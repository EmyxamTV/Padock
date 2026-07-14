import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import Fastify from 'fastify';
import { z } from 'zod';
import { NodeDocker } from './docker.js';
import { ServerFiles } from './files.js';
import { SftpAccountRegistry, startSftpServer } from './sftp.js';
import { padockEnv } from './config.js';
import { BackupObjectStore } from './object-store.js';

const host = padockEnv('AGENT_HOST') ?? '0.0.0.0';
const port = Number(padockEnv('AGENT_PORT') ?? 3001);
const isProduction = process.env.NODE_ENV === 'production';
const developmentToken = 'padock-development-node-token-change-me';
const token = padockEnv('NODE_TOKEN') ?? (isProduction ? '' : developmentToken);
const curseForgeApiKey = process.env.CURSEFORGE_API_KEY?.trim() ?? '';
const dataDir = path.resolve(padockEnv('SERVERS_DIR') ?? (isProduction ? '/var/lib/padock/servers' : './data/servers'));
const backupsDir = path.resolve(padockEnv('BACKUPS_DIR') ?? (isProduction ? '/var/lib/padock/backups' : './data/backups'));
const sftpEnabled = padockEnv('SFTP_ENABLED') !== 'false';
const sftpHost = padockEnv('SFTP_HOST') ?? '0.0.0.0';
const sftpPort = Number(padockEnv('SFTP_PORT') ?? 2022);
const gatewayEnabled = padockEnv('GATEWAY_ENABLED') === 'true';
const gatewayPort = Number(padockEnv('GATEWAY_PORT') ?? 25565);
const sftpHostKey = path.resolve(padockEnv('SFTP_HOST_KEY') ?? path.join(dataDir, '.padock-sftp-host-key'));
const sftpAccountsFile = path.resolve(padockEnv('SFTP_ACCOUNTS_FILE') ?? path.join(dataDir, '.padock-sftp-accounts.json'));
if (token.length < 32) throw new Error('PADOCK_NODE_TOKEN doit contenir au moins 32 caractères.');

const app = Fastify({ logger: true, bodyLimit: 128 * 1024 * 1024 });
const docker = new NodeDocker(dataDir);
const files = new ServerFiles(dataDir, backupsDir);
const objectStore = new BackupObjectStore();
const sftpAccounts = new SftpAccountRegistry(sftpAccountsFile);
await sftpAccounts.load();

app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 128 * 1024 * 1024 }, (_request, body, done) => done(null, body));
app.addContentTypeParser('application/x-padock-backup', (_request, payload, done) => done(null, payload));

app.addHook('onRequest', async (request, reply) => {
  if (request.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: 'Jeton de nœud invalide.' });
});

const idSchema = z.string().regex(/^[a-f0-9]{8}$/);
const sftpAccountSchema = z.object({
  serverId: idSchema,
  username: z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/),
  passwordHash: z.string().regex(/^[a-f0-9]{128}$/),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  paths: z.array(z.string().trim().min(1).max(500)).min(1).max(32),
  readOnly: z.boolean(),
  enabled: z.boolean(),
});
const serverPackSchema = z.object({
  projectId: z.number().int().positive(),
  fileId: z.number().int().positive(),
  url: z.string().url().max(1000),
  filename: z.string().min(1).max(240),
  hash: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{40}$/i),
  algorithm: z.enum(['sha1', 'md5']),
});
const createSchema = z.object({
  id: idSchema,
  name: z.string().min(2).max(40),
  software: z.enum(['PAPER', 'VANILLA', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']),
  version: z.string().min(1).max(30),
  memoryMb: z.number().int().min(1024).max(65536),
  cpuPercent: z.number().int().min(10).max(1600),
  diskMb: z.number().int().min(1024).max(1048576),
  port: z.number().int().min(1024).max(65535),
  serverPack: serverPackSchema.optional(),
})
  .refine((value) => !value.serverPack || ['FABRIC', 'FORGE', 'NEOFORGE'].includes(value.software), { message: 'Les modpacks nécessitent Fabric, Forge ou NeoForge.', path: ['software'] })
  .refine((value) => !gatewayEnabled || value.port !== gatewayPort, { message: `Le port ${gatewayPort} est réservé à la passerelle Minecraft.`, path: ['port'] });

app.get('/v1/health', async () => {
  let dockerReady = true;
  try { await docker.health(); } catch { dockerReady = false; }
  return {
    ok: true, docker: dockerReady, hostname: os.hostname(), version: '1.0.0', sftp: { enabled: sftpEnabled, port: sftpPort }, curseForge: { configured: Boolean(curseForgeApiKey) }, gateway: { enabled: gatewayEnabled, port: gatewayPort },
    backups: { remoteConfigured: objectStore.configured }, memory: { total: os.totalmem(), free: os.freemem() },
    cpu: { cores: os.cpus().length, load: os.loadavg() },
  };
});

app.put('/v1/sftp/accounts/:accountId', async (request, reply) => {
  const accountId = idSchema.safeParse((request.params as { accountId?: string }).accountId);
  const parsed = sftpAccountSchema.safeParse(request.body);
  if (!accountId.success || !parsed.success) return reply.code(400).send({ error: 'Compte SFTP invalide.' });
  await stat(path.join(dataDir, parsed.data.serverId)).then((info) => {
    if (!info.isDirectory()) throw new Error('Le dossier du serveur est introuvable sur ce nœud.');
  });
  await sftpAccounts.upsert({ id: accountId.data, ...parsed.data });
  return { ok: true };
});

app.delete('/v1/sftp/accounts/:accountId', async (request, reply) => {
  const accountId = idSchema.safeParse((request.params as { accountId?: string }).accountId);
  if (!accountId.success) return reply.code(400).send({ error: 'Compte SFTP invalide.' });
  await sftpAccounts.remove(accountId.data);
  return { ok: true };
});

app.delete('/v1/servers/:id/sftp/accounts', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  await sftpAccounts.removeServer(id);
  return { ok: true };
});

app.post('/v1/servers', async (request, reply) => {
  const parsed = createSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (await docker.status(parsed.data.id) !== 'missing') return reply.code(409).send({ error: 'Cette instance existe déjà sur le nœud.' });
  const installedPack = parsed.data.serverPack
    ? await files.installServerPack(parsed.data.id, parsed.data.serverPack.fileId, parsed.data.serverPack.url, parsed.data.serverPack.filename, parsed.data.serverPack.hash, parsed.data.serverPack.algorithm)
    : undefined;
  return reply.code(201).send({ dockerId: await docker.create(parsed.data, installedPack && parsed.data.serverPack ? { relativePath: installedPack.path, projectId: parsed.data.serverPack.projectId, fileId: parsed.data.serverPack.fileId, filename: parsed.data.serverPack.filename } : undefined) });
});

app.get('/v1/servers/:id/status', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  return docker.state(id);
});

app.put('/v1/servers/:id/resources', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({
    memoryMb: z.number().int().min(1024).max(65536),
    cpuPercent: z.number().int().min(10).max(1600),
    diskMb: z.number().int().min(1024).max(1048576),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Ressources invalides.' });
  await docker.updateResources(id, parsed.data);
  return { ok: true };
});

app.put('/v1/servers/:id/crash-policy', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ enabled: z.boolean(), maxRestarts: z.number().int().min(0).max(20) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Politique de crash invalide.' });
  await docker.updateCrashPolicy(id, parsed.data); return { ok: true };
});

app.get('/v1/servers/:id/stats', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const diskBytes = await docker.diskUsage(id);
  if (await docker.status(id) !== 'running') return { cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes };
  return { ...await docker.stats(id), diskBytes };
});

app.get('/v1/servers/:id/metrics', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const state = await docker.state(id); const diskBytes = await docker.diskUsage(id);
  if (state.status !== 'running') return { status: state.status, cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes };
  const stats = await docker.stats(id); let playersOnline: number | undefined; let playersMax: number | undefined;
  try { const output = await docker.command(id, 'list'); const match = output.match(/(?:There are|Il y a)\s+(\d+)\s+(?:of a max of|sur un maximum de)\s+(\d+)/i); if (match) { playersOnline = Number(match[1]); playersMax = Number(match[2]); } } catch { /* RCON peut ne pas être encore prêt. */ }
  return { status: state.status, ...stats, diskBytes, playersOnline, playersMax };
});

app.get('/v1/servers/:id/files', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  return files.list(id, String((request.query as { path?: string }).path ?? ''));
});

app.get('/v1/servers/:id/files/content', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  return { content: await files.read(id, String((request.query as { path?: string }).path ?? '')) };
});

app.put('/v1/servers/:id/files/content', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ path: z.string().min(1).max(500), content: z.string().max(2 * 1024 * 1024) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Fichier invalide.' });
  await files.write(id, parsed.data.path, parsed.data.content); return { ok: true };
});

app.put('/v1/servers/:id/files/upload', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const relative = String((request.query as { path?: string }).path ?? '');
  if (!relative || relative.length > 500 || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'Upload invalide.' });
  await files.writeBuffer(id, relative, request.body); return { ok: true };
});

app.get('/v1/servers/:id/files/download', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const relative = String((request.query as { path?: string }).path ?? '');
  if (!relative || relative.length > 500) return reply.code(400).send({ error: 'Chemin invalide.' });
  const result = await files.readBuffer(id, relative);
  const safeName = result.name.replace(/["\r\n]/g, '_');
  return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', String(result.size)).header('Content-Disposition', `attachment; filename="${safeName}"`).send(result.content);
});

app.post('/v1/servers/:id/files/rename', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ source: z.string().min(1).max(500), destination: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemins invalides.' });
  await files.move(id, parsed.data.source, parsed.data.destination); return { ok: true };
});

app.post('/v1/servers/:id/files/directory', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ path: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemin invalide.' });
  await files.makeDirectory(id, parsed.data.path); return { ok: true };
});

app.delete('/v1/servers/:id/files', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ path: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemin invalide.' });
  await files.remove(id, parsed.data.path); return { ok: true };
});

app.get('/v1/servers/:id/backups', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const local = (await files.listBackups(id)).map((item) => ({ ...item, local: true, remote: false })); const remote = await objectStore.list(id);
  const merged = new Map(remote.map((item) => [item.id, { ...item, local: false }])); for (const item of local) merged.set(item.id, { ...item, remote: merged.has(item.id) });
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

app.post('/v1/servers/:id/backups', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ name: z.string().max(60).optional(), remote: z.boolean().default(false) }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Nom invalide.' });
  if (await docker.status(id) === 'running') await docker.command(id, 'save-all flush');
  const backup = await files.createBackup(id, parsed.data.name);
  if (parsed.data.remote) { const opened = await files.openBackup(id, backup.id); await objectStore.upload(id, backup.id, opened.stream, opened.size, opened.checksum); }
  return reply.code(201).send({ ...backup, local: true, remote: parsed.data.remote });
});

app.post('/v1/servers/:id/backups/:backupId/restore', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  if (await docker.status(id) === 'running') return reply.code(409).send({ error: 'Arrêtez le serveur avant de restaurer une sauvegarde.' });
  const backupId = (request.params as { backupId: string }).backupId;
  try { await files.openBackup(id, backupId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !await objectStore.exists(id, backupId)) throw error; const remote = await objectStore.download(id, backupId); await files.writeBackupStream(id, backupId, remote.body, remote.checksum); }
  await files.createBackup(id, 'pre-restore');
  await files.restoreBackup(id, backupId); return { ok: true };
});

app.delete('/v1/servers/:id/backups/:backupId', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const backupId = (request.params as { backupId: string }).backupId;
  await files.deleteBackup(id, backupId).catch((error) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await objectStore.delete(id, backupId); return { ok: true };
});

app.post('/v1/servers/:id/backups/prune', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ retention: z.number().int().min(0).max(1000) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Rétention invalide.' });
  const local = await files.pruneBackups(id, parsed.data.retention); const remote = (await objectStore.list(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const item of remote.slice(parsed.data.retention)) await objectStore.delete(id, item.id);
  return { deleted: local.deleted + Math.max(0, remote.length - parsed.data.retention) };
});

app.get('/v1/servers/:id/backups/:backupId/export', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const backup = await files.openBackup(id, (request.params as { backupId: string }).backupId);
  return reply.header('Content-Type', 'application/x-padock-backup').header('Content-Length', String(backup.size)).header('X-Padock-Checksum', backup.checksum).send(backup.stream);
});

app.put('/v1/servers/:id/backups/:backupId/import', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const checksum = String(request.headers['x-padock-checksum'] ?? '');
  const stream = request.body as AsyncIterable<Uint8Array> | undefined;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return reply.code(400).send({ error: 'Flux de sauvegarde invalide.' });
  return reply.code(201).send(await files.writeBackupStream(id, (request.params as { backupId: string }).backupId, stream, checksum));
});

app.post('/v1/servers/:id/clone/:destinationId', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const destinationId = idSchema.safeParse((request.params as { destinationId?: string }).destinationId);
  if (!destinationId.success) return reply.code(400).send({ error: 'Destination invalide.' });
  if (await docker.status(id) === 'running' || await docker.status(destinationId.data) === 'running') return reply.code(409).send({ error: 'Arrêtez les deux serveurs avant la copie.' });
  await files.cloneServer(id, destinationId.data); return { ok: true };
});

app.get('/v1/servers/:id/runtime', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  let minecraftVersion: string | undefined;
  try {
    const manifest = JSON.parse(await files.read(id, '.papermc-manifest.json')) as { minecraftVersion?: string };
    minecraftVersion = manifest.minecraftVersion;
  } catch { /* Les autres moteurs n'ont pas ce manifeste. */ }
  if (!minecraftVersion) {
    try {
      const history = JSON.parse(await files.read(id, 'version_history.json')) as { currentVersion?: string };
      minecraftVersion = history.currentVersion?.match(/MC:\s*([^\s)]+)/)?.[1];
    } catch { /* Le serveur n'a peut-être pas encore été démarré. */ }
  }
  return { minecraftVersion };
});

app.get('/v1/servers/:id/content', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const kind = z.enum(['plugin', 'mod']).safeParse((request.query as { kind?: string }).kind);
  if (!kind.success) return reply.code(400).send({ error: 'Type de contenu invalide.' });
  return files.listInstalled(id, kind.data);
});

app.post('/v1/servers/:id/content/install', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({
    kind: z.enum(['plugin', 'mod']),
    url: z.string().url().max(1000),
    filename: z.string().min(1).max(180),
    hash: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{40}$/i),
    algorithm: z.enum(['sha1', 'md5']),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Fichier CurseForge invalide.' });
  return reply.code(201).send(await files.installRemote(id, parsed.data.kind, parsed.data.url, parsed.data.filename, parsed.data.hash, parsed.data.algorithm));
});

app.post('/v1/servers/:id/content/modpack', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ software: z.enum(['FABRIC', 'FORGE', 'NEOFORGE']), version: z.string().min(1).max(30), memoryMb: z.number().int().min(1024).max(65536).optional(), serverPack: serverPackSchema }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Modpack CurseForge invalide.' });
  if (await docker.status(id) !== 'stopped') return reply.code(409).send({ error: 'Arrêtez le serveur avant de changer de modpack.' });
  const installedPack = await files.installServerPack(id, parsed.data.serverPack.fileId, parsed.data.serverPack.url, parsed.data.serverPack.filename, parsed.data.serverPack.hash, parsed.data.serverPack.algorithm);
  await docker.configureCurseForgeServerPack(id, { software: parsed.data.software, version: parsed.data.version, memoryMb: parsed.data.memoryMb, relativePath: installedPack.path, projectId: parsed.data.serverPack.projectId, fileId: parsed.data.serverPack.fileId, filename: parsed.data.serverPack.filename });
  return { ok: true };
});

app.post('/v1/servers/:id/repair', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = createSchema.safeParse({ ...(request.body as object), id, serverPack: undefined });
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  await docker.repair(parsed.data);
  return { ok: true };
});

app.post('/v1/servers/:id/:action', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const action = (request.params as { action: string }).action;
  if (!['start', 'stop', 'restart', 'kill'].includes(action)) return reply.code(404).send({ error: 'Action inconnue.' });
  await docker.action(id, action as 'start' | 'stop' | 'restart' | 'kill');
  return { ok: true };
});

app.post('/v1/servers/:id/command', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const parsed = z.object({ command: z.string().trim().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Commande invalide.' });
  return { output: await docker.command(id, parsed.data.command) };
});

app.get('/v1/servers/:id/logs', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  const tail = Math.min(1000, Math.max(0, Number((request.query as { tail?: string }).tail ?? 200)));
  const stream = await docker.logs(id, tail) as NodeJS.ReadableStream & { destroy(): void };
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  stream.pipe(reply.raw);
  request.raw.on('close', () => stream.destroy());
});

app.delete('/v1/servers/:id', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  await docker.remove(id);
  return { ok: true };
});

app.delete('/v1/servers/:id/data', async (request, reply) => {
  const id = parseId(request.params, reply); if (!id) return;
  if (await docker.status(id) !== 'missing') return reply.code(409).send({ error: 'Supprimez le conteneur avant ses données.' });
  await files.deleteServerData(id); return { ok: true };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message });
});

await app.listen({ host, port });
if (sftpEnabled) await startSftpServer({ host: sftpHost, port: sftpPort, serversDir: dataDir, accounts: sftpAccounts, hostKeyPath: sftpHostKey, log: (message) => app.log.info(message) });

function parseId(params: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  const parsed = idSchema.safeParse((params as { id?: string }).id);
  if (!parsed.success) { reply.code(400).send({ error: 'Identifiant invalide.' }); return undefined; }
  return parsed.data;
}
