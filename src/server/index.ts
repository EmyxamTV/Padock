import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { Store } from './store.js';
import { MinecraftGateway } from './gateway.js';
import { hashPassword, verifyPassword } from './auth.js';
import { NodeClient } from './node-client.js';
import { allowedKinds, curseForgeConfigured, resolveCurseForgeFiles, resolveCurseForgeModpack, searchCurseForge } from './curseforge.js';
import { padockEnv } from './config.js';
import type { AuditEntry, MinecraftServer, ServerPermission, ServerSchedule, UserRecord } from './types.js';

const host = padockEnv('HOST') ?? '0.0.0.0';
const port = Number(padockEnv('PORT') ?? 3000);
const dataDir = path.resolve(padockEnv('DATA_DIR') ?? './data');
const isProduction = process.env.NODE_ENV === 'production';
const jwtSecret = padockEnv('JWT_SECRET') ?? (isProduction ? '' : 'padock-development-secret-change-me');
const publicUrl = padockEnv('PUBLIC_URL') ?? `http://localhost:${port}`;
const sftpPublicHost = padockEnv('SFTP_PUBLIC_HOST') ?? new URL(publicUrl).hostname;
const sftpPublicPort = Number(padockEnv('SFTP_PUBLIC_PORT') ?? 2022);
if (!jwtSecret) throw new Error('PADOCK_JWT_SECRET est obligatoire en production.');

const app = Fastify({ logger: true, bodyLimit: 128 * 1024 * 1024 });
const store = new Store(dataDir);
const gateway = new MinecraftGateway();
const provisioningServers = new Set<string>();
const runningSchedules = new Set<string>();
await store.load();
await ensureDefaultNode();
await gateway.sync(store.snapshot);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 128 * 1024 * 1024 }, (_request, body, done) => done(null, body));
await app.register(cookie);
await app.register(jwt, { secret: jwtSecret, cookie: { cookieName: 'padock_session', signed: false } });
await app.register(rateLimit, { global: false });

const auth = async (request: FastifyRequest, reply: FastifyReply) => {
  try { await request.jwtVerify(); }
  catch { return reply.code(401).send({ error: 'Authentification requise.' }); }
};

const admin = async (request: FastifyRequest, reply: FastifyReply) => {
  if (currentUser(request)?.role !== 'admin') return reply.code(403).send({ error: 'Droits administrateur requis.' });
};

const credentialsSchema = z.object({ username: z.string().trim().min(3).max(32), password: z.string().min(10).max(200) });
const serverSchema = z.object({
  name: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} _.-]+$/u),
  software: z.enum(['PAPER', 'VANILLA', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']).default('PAPER'),
  version: z.string().trim().min(1).max(30).default('LATEST'),
  memoryMb: z.number().int().min(1024).max(65536),
  cpuPercent: z.number().int().min(10).max(1600).default(100),
  diskMb: z.number().int().min(1024).max(1048576).default(10240),
  nodeId: z.string().min(1),
  allocationId: z.string().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  ownerId: z.string().optional(),
  subdomain: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  modpack: z.object({ projectId: z.number().int().positive(), slug: z.string().regex(/^[a-z0-9-]{2,100}$/i) }).optional(),
});

app.get('/api/health', async () => {
  const nodes = await Promise.all(store.snapshot.nodes.map(async (node) => {
    try { return { id: node.id, online: (await new NodeClient(node).health()).docker }; }
    catch { return { id: node.id, online: false }; }
  }));
  return { ok: true, database: process.env.DATABASE_URL ? 'postgresql' : 'json-development', nodes, initialized: store.snapshot.users.length > 0 };
});

app.get('/api/auth/status', async () => ({ initialized: store.snapshot.users.length > 0 }));

app.post('/api/auth/setup', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
  if (store.snapshot.users.length) return reply.code(409).send({ error: 'Le panel est déjà configuré.' });
  const parsed = credentialsSchema.extend({ email: z.string().email().optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const password = await hashPassword(parsed.data.password);
  const user: UserRecord = {
    id: randomUUID().slice(0, 8), username: parsed.data.username,
    email: parsed.data.email ?? `${parsed.data.username}@padock.local`, role: 'admin', ...password, createdAt: new Date().toISOString(),
  };
  await store.update((draft) => { draft.users.push(user); draft.auditLogs.unshift(audit(user.id, 'panel.setup', 'panel')); });
  setSession(reply, user);
  return safeUser(user);
});

app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const parsed = credentialsSchema.safeParse(request.body);
  const user = parsed.success ? store.snapshot.users.find((item) => item.username.toLowerCase() === parsed.data.username.toLowerCase()) : undefined;
  if (!parsed.success || !user || !(await verifyPassword(parsed.data.password, user.salt, user.passwordHash))) {
    return reply.code(401).send({ error: 'Identifiants incorrects.' });
  }
  setSession(reply, user);
  await recordAudit(user.id, 'auth.login', 'user', user.id);
  return safeUser(user);
});

app.post('/api/auth/logout', { preHandler: auth }, async (request, reply) => {
  await recordAudit(currentUser(request)?.id, 'auth.logout', 'user', currentUser(request)?.id);
  reply.clearCookie('padock_session', { path: '/' });
  reply.clearCookie('panelmc_session', { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', { preHandler: auth }, async (request) => safeUser(currentUser(request)!));

app.put('/api/auth/profile', { preHandler: auth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
  const parsed = z.object({
    username: z.string().trim().min(3).max(32).regex(/^[\p{L}\p{N}_.-]+$/u, 'Le pseudo contient des caractères non autorisés.'),
    email: z.string().trim().email().max(254),
    currentPassword: z.string().min(10).max(200),
    newPassword: z.string().min(10).max(200).optional(),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const user = currentUser(request)!;
  if (!(await verifyPassword(parsed.data.currentPassword, user.salt, user.passwordHash))) {
    return reply.code(401).send({ error: 'Le mot de passe actuel est incorrect.' });
  }
  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return reply.code(400).send({ error: 'Le nouveau mot de passe doit être différent du mot de passe actuel.' });
  }
  const duplicate = store.snapshot.users.find((item) => item.id !== user.id && (item.username.toLocaleLowerCase() === parsed.data.username.toLocaleLowerCase() || item.email.toLocaleLowerCase() === parsed.data.email.toLocaleLowerCase()));
  if (duplicate) return reply.code(409).send({ error: 'Ce pseudo ou cette adresse e-mail est déjà utilisé.' });
  const changed: string[] = [];
  if (parsed.data.username !== user.username) changed.push('username');
  if (parsed.data.email.toLocaleLowerCase() !== user.email.toLocaleLowerCase()) changed.push('email');
  if (parsed.data.newPassword) changed.push('password');
  if (!changed.length) return safeUser(user);
  const password = parsed.data.newPassword ? await hashPassword(parsed.data.newPassword) : undefined;
  await store.update((draft) => {
    const item = draft.users.find((entry) => entry.id === user.id);
    if (!item) return;
    item.username = parsed.data.username;
    item.email = parsed.data.email;
    if (password) Object.assign(item, password);
    draft.auditLogs.unshift(audit(user.id, 'user.profile_update', 'user', user.id, { changed }));
  });
  return safeUser(store.snapshot.users.find((item) => item.id === user.id)!);
});

app.get('/api/users', { preHandler: [auth, admin] }, async () => store.snapshot.users.map(safeUser));

app.post('/api/users', { preHandler: [auth, admin] }, async (request, reply) => {
  const parsed = credentialsSchema.extend({ email: z.string().email(), role: z.enum(['admin', 'user']).default('user') }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (store.snapshot.users.some((item) => item.username.toLowerCase() === parsed.data.username.toLowerCase() || item.email.toLowerCase() === parsed.data.email.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce nom ou cette adresse e-mail est déjà utilisé.' });
  }
  const password = await hashPassword(parsed.data.password);
  const user: UserRecord = { id: randomUUID().slice(0, 8), ...parsed.data, ...password, createdAt: new Date().toISOString() };
  await store.update((draft) => { draft.users.push(user); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'user.create', 'user', user.id, { role: user.role })); });
  return reply.code(201).send(safeUser(user));
});

app.delete('/api/users/:id', { preHandler: [auth, admin] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (id === currentUser(request)?.id) return reply.code(400).send({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  if (store.snapshot.servers.some((server) => server.ownerId === id)) return reply.code(409).send({ error: 'Transférez d’abord les serveurs appartenant à cet utilisateur.' });
  await store.update((draft) => {
    draft.users = draft.users.filter((item) => item.id !== id);
    draft.serverAccess = draft.serverAccess.filter((item) => item.userId !== id);
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'user.delete', 'user', id));
  });
  return { ok: true };
});

app.get('/api/nodes', { preHandler: auth }, async (request) => {
  const user = currentUser(request)!;
  const visibleNodeIds = new Set(visibleServers(user).map((server) => server.nodeId));
  const nodes = user.role === 'admin' ? store.snapshot.nodes : store.snapshot.nodes.filter((node) => visibleNodeIds.has(node.id));
  return Promise.all(nodes.map(async ({ token, ...node }) => {
  try { return { ...node, online: true, health: await new NodeClient({ ...node, token }).health(), allocations: allocationStats(node.id) }; }
  catch { return { ...node, online: false, allocations: allocationStats(node.id) }; }
  }));
});

app.post('/api/nodes', { preHandler: [auth, admin] }, async (request, reply) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(40), location: z.string().trim().min(2).max(60),
    url: z.string().url().refine((value) => value.startsWith('https://') || !isProduction, 'HTTPS est obligatoire en production.'),
    token: z.string().min(32).max(500), ip: z.string().trim().min(2).max(255).default('0.0.0.0'),
    portStart: z.number().int().min(1024).max(65535).default(25565), portEnd: z.number().int().min(1024).max(65535).default(25664),
  }).refine((value) => value.portEnd >= value.portStart && value.portEnd - value.portStart <= 2000, 'Plage de ports invalide ou trop grande.').safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const { ip, portStart, portEnd, ...nodeInput } = parsed.data;
  const node = { id: randomUUID().slice(0, 8), ...nodeInput, createdAt: new Date().toISOString() };
  try { await new NodeClient(node).health(); } catch (error) { return reply.code(400).send({ error: `Agent injoignable : ${(error as Error).message}` }); }
  await store.update((draft) => {
    draft.nodes.push(node);
    for (let value = portStart; value <= portEnd; value++) draft.allocations.push({ id: randomUUID().slice(0, 8), nodeId: node.id, ip, port: value });
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'node.create', 'node', node.id, { portStart, portEnd }));
  });
  const { token: _token, ...safeNode } = node;
  return reply.code(201).send({ ...safeNode, online: true, allocations: allocationStats(node.id) });
});

app.get('/api/nodes/:id/allocations', { preHandler: [auth, admin] }, async (request) => store.snapshot.allocations.filter((item) => item.nodeId === (request.params as { id: string }).id));

app.post('/api/nodes/:id/allocations', { preHandler: [auth, admin] }, async (request, reply) => {
  const nodeId = (request.params as { id: string }).id;
  if (!store.snapshot.nodes.some((node) => node.id === nodeId)) return reply.code(404).send({ error: 'Nœud introuvable.' });
  const parsed = z.object({ ip: z.string().trim().min(2).max(255).default('0.0.0.0'), portStart: z.number().int().min(1024).max(65535), portEnd: z.number().int().min(1024).max(65535) })
    .refine((value) => value.portEnd >= value.portStart && value.portEnd - value.portStart <= 2000, 'Plage invalide.').safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  let created = 0;
  await store.update((draft) => {
    for (let value = parsed.data.portStart; value <= parsed.data.portEnd; value++) {
      if (!draft.allocations.some((item) => item.nodeId === nodeId && item.ip === parsed.data.ip && item.port === value)) {
        draft.allocations.push({ id: randomUUID().slice(0, 8), nodeId, ip: parsed.data.ip, port: value }); created++;
      }
    }
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'allocation.create_range', 'node', nodeId, { ...parsed.data, created }));
  });
  return reply.code(201).send({ created });
});

app.get('/api/servers', { preHandler: auth }, async (request) => Promise.all(visibleServers(currentUser(request)!).map(async (server) => {
  const runtime = await runtimeStateFor(server);
  return { ...server, address: serverAddress(server), status: provisioningServers.has(server.id) ? 'installing' : runtime.status, runtime };
})));

app.get('/api/gateway', { preHandler: auth }, async () => gateway.status(store.snapshot));

app.get('/api/curseforge/modpacks', { preHandler: [auth, admin] }, async (request, reply) => {
  const parsed = z.object({
    software: z.enum(['FABRIC', 'FORGE', 'NEOFORGE']),
    version: z.string().trim().min(1).max(30).default('LATEST'),
    query: z.string().trim().max(100).default(''),
  }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const configured = curseForgeConfigured();
  const minecraftVersion = parsed.data.version.toUpperCase() === 'LATEST' ? undefined : parsed.data.version;
  return {
    configured,
    projects: configured ? await searchCurseForge({ software: parsed.data.software }, 'modpack', parsed.data.query, minecraftVersion) : [],
  };
});

app.post('/api/servers', { preHandler: [auth, admin] }, async (request, reply) => {
  const parsed = serverSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const node = store.snapshot.nodes.find((item) => item.id === parsed.data.nodeId);
  if (!node) return reply.code(404).send({ error: 'Nœud Linux introuvable.' });
  const owner = store.snapshot.users.find((item) => item.id === (parsed.data.ownerId ?? currentUser(request)?.id));
  if (!owner) return reply.code(404).send({ error: 'Propriétaire introuvable.' });
  if (gateway.enabled && parsed.data.port === gateway.publicPort) {
    return reply.code(409).send({ error: `Le port ${gateway.publicPort} est réservé à la passerelle Minecraft.` });
  }
  const allocation = selectAllocation(node.id, parsed.data.allocationId, parsed.data.port);
  if (!allocation) return reply.code(409).send({ error: 'Aucune allocation réseau libre ne correspond à la demande.' });

  const id = randomUUID().slice(0, 8);
  const server: MinecraftServer = {
    id, name: parsed.data.name, software: parsed.data.software, version: parsed.data.version,
    memoryMb: parsed.data.memoryMb, cpuPercent: parsed.data.cpuPercent, diskMb: parsed.data.diskMb,
    port: allocation.port, nodeId: node.id, allocationId: allocation.id, ownerId: owner.id,
    domain: parsed.data.subdomain ? gateway.domainFor(parsed.data.subdomain) : undefined,
    createdAt: new Date().toISOString(),
  };
  if (server.domain && store.snapshot.servers.some((item) => item.domain?.toLowerCase() === server.domain?.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce sous-domaine est déjà utilisé par un autre serveur.' });
  }
  if (parsed.data.modpack && !['FABRIC', 'FORGE', 'NEOFORGE'].includes(server.software)) {
    return reply.code(400).send({ error: 'Les modpacks CurseForge nécessitent Fabric, Forge ou NeoForge.' });
  }
  const minecraftVersion = server.version.toUpperCase() === 'LATEST' ? undefined : server.version;
  const modpack = parsed.data.modpack
    ? await resolveCurseForgeModpack(server, parsed.data.modpack.projectId, parsed.data.modpack.slug, minecraftVersion)
    : undefined;
  if (modpack) server.version = modpack.minecraftVersion;
  await store.update((draft) => {
    draft.servers.push(server);
    const item = draft.allocations.find((entry) => entry.id === allocation.id); if (item) item.serverId = server.id;
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.installing', 'server', server.id, { nodeId: node.id, ownerId: owner.id, serverPack: modpack?.filename }));
  });
  provisioningServers.add(server.id);
  try {
    await gateway.sync(store.snapshot);
    await new NodeClient(node).create(server, modpack);
    await recordAudit(currentUser(request)?.id, 'server.create', 'server', server.id, { nodeId: node.id, ownerId: owner.id, serverPack: modpack ? { projectId: modpack.projectId, mainFileId: modpack.mainFileId, fileId: modpack.fileId, filename: modpack.filename } : undefined });
  } catch (error) {
    await store.update((draft) => {
      draft.servers = draft.servers.filter((item) => item.id !== server.id);
      const item = draft.allocations.find((entry) => entry.id === allocation.id && entry.serverId === server.id); if (item) item.serverId = undefined;
      draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.install_failed', 'server', server.id, { error: (error as Error).message }));
    });
    await gateway.sync(store.snapshot).catch((syncError) => app.log.error(syncError));
    throw error;
  } finally { provisioningServers.delete(server.id); }
  return reply.code(201).send({ ...server, address: serverAddress(server), status: 'stopped' });
});

app.put('/api/servers/:id', { preHandler: auth }, async (request, reply) => {
  const server = ownerServer(request, reply, (request.params as { id: string }).id); if (!server) return;
  const parsed = z.object({ name: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} _.-]+$/u) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Nom de serveur invalide.' });
  await store.update((draft) => {
    const item = draft.servers.find((entry) => entry.id === server.id);
    if (item) item.name = parsed.data.name;
  });
  await recordAudit(currentUser(request)?.id, 'server.rename', 'server', server.id, { from: server.name, to: parsed.data.name });
  return { ok: true };
});

app.put('/api/servers/:id/domain', { preHandler: auth }, async (request, reply) => {
  const server = ownerServer(request, reply, (request.params as { id: string }).id); if (!server) return;
  const parsed = z.object({ subdomain: z.union([z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/), z.literal(''), z.null()]) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Sous-domaine invalide.' });
  const subdomain = parsed.data.subdomain || undefined;
  if (subdomain && server.port === gateway.publicPort) {
    return reply.code(409).send({ error: `Le port interne ${gateway.publicPort} entre en conflit avec la passerelle. Choisissez une autre allocation.` });
  }
  const domain = subdomain ? gateway.domainFor(subdomain) : undefined;
  if (domain && store.snapshot.servers.some((item) => item.id !== server.id && item.domain?.toLowerCase() === domain.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce sous-domaine est déjà utilisé par un autre serveur.' });
  }
  await store.update((draft) => {
    const item = draft.servers.find((entry) => entry.id === server.id);
    if (item) item.domain = domain;
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.domain_update', 'server', server.id, { from: server.domain, to: domain }));
  });
  await gateway.sync(store.snapshot);
  const updated = findServer(server.id)!;
  return { domain: updated.domain, address: serverAddress(updated) };
});

app.get('/api/servers/:id/activity', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'console.read'); if (!server) return;
  return store.snapshot.auditLogs.filter((entry) => entry.targetType === 'server' && entry.targetId === server.id).slice(0, 100).map((entry) => {
    const user = entry.userId ? store.snapshot.users.find((item) => item.id === entry.userId) : undefined;
    return { ...entry, user: user ? safeUser(user) : undefined };
  });
});

app.get('/api/servers/:id/stats', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'console.read'); if (!server) return;
  return clientFor(server).stats(server);
});

app.put('/api/servers/:id/resources', { preHandler: auth }, async (request, reply) => {
  const server = ownerServer(request, reply, (request.params as { id: string }).id); if (!server) return;
  const parsed = z.object({
    memoryMb: z.number().int().min(1024).max(65536),
    cpuPercent: z.number().int().min(10).max(1600),
    diskMb: z.number().int().min(1024).max(1048576),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Ressources invalides.' });
  await clientFor(server).updateResources(server, parsed.data);
  await store.update((draft) => {
    const item = draft.servers.find((entry) => entry.id === server.id);
    if (item) Object.assign(item, parsed.data);
  });
  await recordAudit(currentUser(request)?.id, 'server.resources_update', 'server', server.id, parsed.data);
  return { ok: true };
});

app.get('/api/servers/:id/files', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  return clientFor(server).files(server, String((request.query as { path?: string }).path ?? ''));
});

app.get('/api/servers/:id/files/content', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  return clientFor(server).readFile(server, String((request.query as { path?: string }).path ?? ''));
});

app.put('/api/servers/:id/files/content', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ path: z.string().min(1).max(500), content: z.string().max(2 * 1024 * 1024) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Fichier invalide.' });
  const result = await clientFor(server).writeFile(server, parsed.data.path, parsed.data.content);
  await recordAudit(currentUser(request)?.id, 'file.write', 'server', server.id, { path: parsed.data.path }); return result;
});

app.put('/api/servers/:id/files/upload', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const relative = String((request.query as { path?: string }).path ?? '');
  if (!relative || relative.length > 500 || !Buffer.isBuffer(request.body)) return reply.code(400).send({ error: 'Upload invalide.' });
  const result = await clientFor(server).uploadFile(server, relative, request.body);
  await recordAudit(currentUser(request)?.id, 'file.upload', 'server', server.id, { path: relative, size: request.body.length }); return result;
});

app.get('/api/servers/:id/files/download', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  const relative = String((request.query as { path?: string }).path ?? '');
  if (!relative || relative.length > 500) return reply.code(400).send({ error: 'Chemin invalide.' });
  const result = await clientFor(server).downloadFile(server, relative);
  const safeName = result.name.replace(/["\r\n]/g, '_');
  return reply.header('Content-Type', result.contentType).header('Content-Length', String(result.content.length)).header('Content-Disposition', `attachment; filename="${safeName}"`).send(result.content);
});

app.post('/api/servers/:id/files/rename', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ source: z.string().min(1).max(500), destination: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemins invalides.' });
  const result = await clientFor(server).renameFile(server, parsed.data.source, parsed.data.destination);
  await recordAudit(currentUser(request)?.id, 'file.rename', 'server', server.id, parsed.data); return result;
});

app.post('/api/servers/:id/files/directory', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ path: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemin invalide.' });
  const result = await clientFor(server).makeDirectory(server, parsed.data.path);
  await recordAudit(currentUser(request)?.id, 'file.mkdir', 'server', server.id, { path: parsed.data.path }); return result;
});

app.delete('/api/servers/:id/files', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ path: z.string().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Chemin invalide.' });
  const result = await clientFor(server).deleteFile(server, parsed.data.path);
  await recordAudit(currentUser(request)?.id, 'file.delete', 'server', server.id, { path: parsed.data.path }); return result;
});

app.get('/api/servers/:id/properties', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  try {
    const result = await clientFor(server).readFile(server, 'server.properties');
    return { values: parseServerProperties(result.content) };
  } catch (error) {
    if ((error as Error).message.includes('ENOENT')) return { values: {} };
    throw error;
  }
});

app.put('/api/servers/:id/properties', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ values: z.record(z.string(), z.string().max(500)) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Propriétés invalides.' });
  const invalidKey = Object.keys(parsed.data.values).find((key) => !editableProperties.has(key));
  const invalidValue = Object.values(parsed.data.values).find((value) => /[\r\n\0]/.test(value));
  if (invalidKey || invalidValue !== undefined) return reply.code(400).send({ error: 'Une propriété ne peut pas être modifiée.' });
  let content = '';
  try { content = (await clientFor(server).readFile(server, 'server.properties')).content; } catch { /* Premier démarrage. */ }
  content = updateServerProperties(content, parsed.data.values);
  await clientFor(server).writeFile(server, 'server.properties', content);
  await recordAudit(currentUser(request)?.id, 'server.properties_update', 'server', server.id, { keys: Object.keys(parsed.data.values) });
  return { ok: true, restartRequired: (await statusFor(server)) === 'running' };
});

app.post('/api/servers/:id/sftp/credentials', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const node = store.snapshot.nodes.find((item) => item.id === server.nodeId);
  if (!node) return reply.code(404).send({ error: 'Nœud introuvable.' });
  const health = await new NodeClient(node).health();
  if (!health.sftp?.enabled) return reply.code(409).send({ error: 'Le SFTP n’est pas activé sur ce nœud.' });
  const expiry = Math.floor(Date.now() / 1000) + 30 * 60;
  const signature = createHmac('sha256', node.token).update(`${server.id}:${expiry}`).digest('base64url');
  await recordAudit(currentUser(request)?.id, 'sftp.credentials_create', 'server', server.id, { expiresAt: new Date(expiry * 1000).toISOString() });
  return { host: sftpPublicHost, port: sftpPublicPort, username: server.id, password: `${expiry}.${signature}`, expiresAt: new Date(expiry * 1000).toISOString() };
});

app.get('/api/servers/:id/content/search', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  const parsed = z.object({ kind: z.enum(['plugin', 'mod', 'modpack']), query: z.string().trim().max(80).default('') }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Recherche invalide.' });
  const minecraftVersion = await runtimeVersion(server);
  const configured = curseForgeConfigured();
  return { provider: 'curseforge', configured, minecraftVersion, kinds: allowedKinds(server), projects: configured ? await searchCurseForge(server, parsed.data.kind, parsed.data.query, minecraftVersion) : [] };
});

app.get('/api/servers/:id/content/installed', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.read'); if (!server) return;
  const kind = z.enum(['plugin', 'mod']).safeParse((request.query as { kind?: string }).kind);
  if (!kind.success) return reply.code(400).send({ error: 'Type de contenu invalide.' });
  return clientFor(server).installedContent(server, kind.data);
});

app.post('/api/servers/:id/content/install', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ kind: z.enum(['plugin', 'mod', 'modpack']), projectId: z.number().int().positive(), slug: z.string().max(100).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Projet CurseForge invalide.' });
  if (parsed.data.kind === 'modpack' && (await statusFor(server)) !== 'stopped') return reply.code(409).send({ error: 'Arrêtez le serveur avant d’installer un modpack.' });
  const client = clientFor(server);
  const minecraftVersion = await runtimeVersion(server);
  if (parsed.data.kind === 'modpack') {
    if (!parsed.data.slug) return reply.code(400).send({ error: 'Slug CurseForge manquant.' });
    const modpack = await resolveCurseForgeModpack(server, parsed.data.projectId, parsed.data.slug, minecraftVersion);
    const configuredServer = { ...server, version: modpack.minecraftVersion };
    await client.createBackup(server, `pre-curseforge-${parsed.data.slug}`);
    await client.configureCurseForgeModpack(configuredServer, modpack);
    await store.update((draft) => {
      const item = draft.servers.find((entry) => entry.id === server.id);
      if (item) item.version = modpack.minecraftVersion;
    });
    await recordAudit(currentUser(request)?.id, 'content.modpack_configure', 'server', server.id, { provider: 'curseforge', projectId: parsed.data.projectId, mainFileId: modpack.mainFileId, serverPackFileId: modpack.fileId, minecraftVersion: modpack.minecraftVersion });
    return reply.code(201).send({ installed: [], restartRequired: false, startRequired: true, message: `Server pack ${modpack.filename} téléchargé. Démarrez le serveur pour l’appliquer.` });
  }
  const resolved = await resolveCurseForgeFiles(server, parsed.data.kind, parsed.data.projectId, minecraftVersion);
  const installed = [];
  for (const file of resolved) installed.push(await client.installContent(server, { kind: parsed.data.kind, url: file.url, filename: file.filename, hash: file.hash, algorithm: file.algorithm }));
  await recordAudit(currentUser(request)?.id, 'content.install', 'server', server.id, { provider: 'curseforge', kind: parsed.data.kind, projectId: parsed.data.projectId, minecraftVersion, files: resolved.map((file) => file.filename) });
  return reply.code(201).send({ installed, restartRequired: (await statusFor(server)) === 'running', startRequired: false });
});

app.delete('/api/servers/:id/content/installed', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'files.write'); if (!server) return;
  const parsed = z.object({ kind: z.enum(['plugin', 'mod']), filename: z.string().regex(/^[\w .+()\[\]-]{1,180}\.jar$/i) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Extension invalide.' });
  const relative = `${parsed.data.kind === 'plugin' ? 'plugins' : 'mods'}/${parsed.data.filename}`;
  const result = await clientFor(server).deleteFile(server, relative);
  await recordAudit(currentUser(request)?.id, 'content.delete', 'server', server.id, { kind: parsed.data.kind, filename: parsed.data.filename }); return result;
});

app.get('/api/servers/:id/backups', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  return clientFor(server).backups(server);
});

app.post('/api/servers/:id/backups', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  const parsed = z.object({ name: z.string().max(60).optional() }).safeParse(request.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: 'Nom invalide.' });
  const backup = await clientFor(server).createBackup(server, parsed.data.name);
  await recordAudit(currentUser(request)?.id, 'backup.create', 'server', server.id, { backupId: backup.id }); return reply.code(201).send(backup);
});

app.post('/api/servers/:id/backups/:backupId/restore', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  const backupId = (request.params as { backupId: string }).backupId;
  const result = await clientFor(server).restoreBackup(server, backupId);
  await recordAudit(currentUser(request)?.id, 'backup.restore', 'server', server.id, { backupId }); return result;
});

app.delete('/api/servers/:id/backups/:backupId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  const backupId = (request.params as { backupId: string }).backupId;
  const result = await clientFor(server).deleteBackup(server, backupId);
  await recordAudit(currentUser(request)?.id, 'backup.delete', 'server', server.id, { backupId }); return result;
});

app.get('/api/servers/:id/schedules', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'schedules.manage'); if (!server) return;
  return store.snapshot.schedules.filter((item) => item.serverId === server.id);
});

app.post('/api/servers/:id/schedules', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'schedules.manage'); if (!server) return;
  const parsed = z.object({ name: z.string().trim().min(2).max(60), intervalMinutes: z.number().int().min(1).max(525600), action: z.enum(['start', 'stop', 'restart', 'command', 'backup']), payload: z.string().max(500).optional(), enabled: z.boolean().default(true) })
    .refine((value) => value.action !== 'command' || Boolean(value.payload?.trim()), 'Une commande est obligatoire.').safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const schedule = { id: randomUUID().slice(0, 8), serverId: server.id, ...parsed.data, nextRunAt: new Date(Date.now() + parsed.data.intervalMinutes * 60000).toISOString(), createdAt: new Date().toISOString() };
  await store.update((draft) => { draft.schedules.push(schedule); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'schedule.create', 'server', server.id, { scheduleId: schedule.id, action: schedule.action })); });
  return reply.code(201).send(schedule);
});

app.put('/api/servers/:id/schedules/:scheduleId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'schedules.manage'); if (!server) return;
  const scheduleId = (request.params as { scheduleId: string }).scheduleId;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
  if (!parsed.success || !store.snapshot.schedules.some((item) => item.id === scheduleId && item.serverId === server.id)) return reply.code(404).send({ error: 'Tâche introuvable.' });
  await store.update((draft) => { const item = draft.schedules.find((entry) => entry.id === scheduleId)!; item.enabled = parsed.data.enabled; item.nextRunAt = new Date(Date.now() + item.intervalMinutes * 60000).toISOString(); });
  return { ok: true };
});

app.post('/api/servers/:id/schedules/:scheduleId/run', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'schedules.manage'); if (!server) return;
  const schedule = store.snapshot.schedules.find((item) => item.id === (request.params as { scheduleId: string }).scheduleId && item.serverId === server.id);
  if (!schedule) return reply.code(404).send({ error: 'Tâche introuvable.' });
  if (runningSchedules.has(schedule.id)) return reply.code(409).send({ error: 'Cette tâche est déjà en cours.' });
  return executeSchedule(schedule);
});

app.delete('/api/servers/:id/schedules/:scheduleId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'schedules.manage'); if (!server) return;
  const scheduleId = (request.params as { scheduleId: string }).scheduleId;
  await store.update((draft) => { draft.schedules = draft.schedules.filter((item) => item.id !== scheduleId || item.serverId !== server.id); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'schedule.delete', 'server', server.id, { scheduleId })); });
  return { ok: true };
});

app.get('/api/servers/:id/members', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id); if (!server) return;
  return store.snapshot.serverAccess.filter((item) => item.serverId === server.id).map((item) => ({ ...item, user: safeUser(store.snapshot.users.find((user) => user.id === item.userId)!) }));
});

app.put('/api/servers/:id/members/:userId', { preHandler: auth }, async (request, reply) => {
  const server = ownerServer(request, reply, (request.params as { id: string }).id); if (!server) return;
  const userId = (request.params as { userId: string }).userId;
  if (!store.snapshot.users.some((user) => user.id === userId)) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
  const parsed = z.object({ permissions: z.array(z.enum(['console.read', 'console.command', 'power.start', 'power.stop', 'power.restart', 'files.read', 'files.write', 'backups.manage', 'schedules.manage'])) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Permissions invalides.' });
  await store.update((draft) => {
    draft.serverAccess = draft.serverAccess.filter((item) => item.serverId !== server.id || item.userId !== userId);
    draft.serverAccess.push({ serverId: server.id, userId, permissions: parsed.data.permissions });
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.member_update', 'server', server.id, { userId, permissions: parsed.data.permissions }));
  });
  return { ok: true };
});

app.post('/api/servers/:id/:action', { preHandler: auth }, async (request, reply) => {
  const params = request.params as { id: string; action: string };
  if (params.action === 'repair') {
    const server = ownerServer(request, reply, params.id); if (!server) return;
    await clientFor(server).repair(server);
    await recordAudit(currentUser(request)?.id, 'server.repair', 'server', server.id);
    return { ok: true };
  }
  if (params.action === 'kill') {
    const server = ownerServer(request, reply, params.id); if (!server) return;
    await clientFor(server).action(server, 'kill');
    await recordAudit(currentUser(request)?.id, 'server.kill', 'server', server.id);
    return { ok: true };
  }
  if (!['start', 'stop', 'restart'].includes(params.action)) return reply.code(404).send({ error: 'Action inconnue.' });
  const permission = `power.${params.action}` as ServerPermission;
  const server = authorizedServer(request, reply, params.id, permission); if (!server) return;
  await clientFor(server).action(server, params.action as 'start' | 'stop' | 'restart');
  await recordAudit(currentUser(request)?.id, `server.${params.action}`, 'server', server.id);
  return { ok: true };
});

app.post('/api/servers/:id/command', { preHandler: auth }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const server = authorizedServer(request, reply, id, 'console.command'); if (!server) return;
  const parsed = z.object({ command: z.string().trim().min(1).max(500) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Commande invalide.' });
  const result = await clientFor(server).command(server, parsed.data.command);
  await recordAudit(currentUser(request)?.id, 'server.command', 'server', server.id, { command: parsed.data.command.split(' ')[0] });
  return result;
});

app.delete('/api/servers/:id', { preHandler: auth }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const server = ownerServer(request, reply, id); if (!server) return;
  await clientFor(server).remove(server);
  await store.update((draft) => {
    draft.servers = draft.servers.filter((item) => item.id !== id);
    draft.serverAccess = draft.serverAccess.filter((item) => item.serverId !== id);
    draft.schedules = draft.schedules.filter((item) => item.serverId !== id);
    const allocation = draft.allocations.find((item) => item.serverId === id); if (allocation) allocation.serverId = undefined;
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.delete', 'server', id));
  });
  await gateway.sync(store.snapshot);
  return { ok: true };
});

app.get('/api/audit', { preHandler: [auth, admin] }, async () => store.snapshot.auditLogs.slice(0, 250).map((entry) => {
  const user = entry.userId ? store.snapshot.users.find((item) => item.id === entry.userId) : undefined;
  return { ...entry, user: user ? safeUser(user) : undefined };
}));

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
if (isProduction) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') || request.url.startsWith('/socket.io/') ? reply.code(404).send({ error: 'Route introuvable.' }) : reply.sendFile('index.html'));
}

const io = new SocketServer(app.server, { cors: { origin: false } });
io.use(async (socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie ?? '';
    const token = rawCookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('padock_session='))?.split('=')[1]
      ?? rawCookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('panelmc_session='))?.split('=')[1];
    if (!token) throw new Error('missing token');
    const payload = await app.jwt.verify<{ sub: string }>(decodeURIComponent(token));
    socket.data.userId = payload.sub; next();
  } catch { next(new Error('unauthorized')); }
});

io.on('connection', (socket) => {
  let logStream: DestroyableReadableStream | undefined;
  socket.on('console:subscribe', async (id: string) => {
    logStream?.destroy();
    const server = findServer(id); const user = store.snapshot.users.find((item) => item.id === socket.data.userId);
    if (!server || !user || !hasPermission(user, server, 'console.read')) return socket.emit('console:error', 'Accès à la console refusé.');
    try {
      const stream = await clientFor(server).logs(server) as DestroyableReadableStream; logStream = stream;
      stream.on('data', (chunk: Buffer) => socket.emit('console:line', stripDockerHeader(chunk)));
      stream.on('error', (error: Error) => socket.emit('console:error', error.message));
    } catch (error) { socket.emit('console:error', (error as Error).message); }
  });
  socket.on('disconnect', () => logStream?.destroy());
});

app.setErrorHandler((error, _request, reply) => { const failure = error as Error & { statusCode?: number }; app.log.error(failure); reply.code(failure.statusCode ?? 500).send({ error: failure.statusCode ? failure.message : 'Erreur interne du Panel.' }); });
await app.listen({ host, port });
setInterval(() => { void runDueSchedules(); }, 30_000).unref();
void runDueSchedules();

function currentUser(request: FastifyRequest) { return store.snapshot.users.find((user) => user.id === (request.user as { sub?: string } | undefined)?.sub); }
function safeUser(user: UserRecord) { return { id: user.id, username: user.username, email: user.email, role: user.role, createdAt: user.createdAt }; }
function setSession(reply: FastifyReply, user: UserRecord) { reply.setCookie('padock_session', app.jwt.sign({ sub: user.id }, { expiresIn: '12h' }), sessionCookie()); }
function findServer(id: string) { return store.snapshot.servers.find((server) => server.id === id); }
function visibleServers(user: UserRecord) { return user.role === 'admin' ? store.snapshot.servers : store.snapshot.servers.filter((server) => server.ownerId === user.id || store.snapshot.serverAccess.some((item) => item.serverId === server.id && item.userId === user.id)); }
function hasPermission(user: UserRecord, server: MinecraftServer, permission?: ServerPermission) { return user.role === 'admin' || server.ownerId === user.id || Boolean(permission && store.snapshot.serverAccess.some((item) => item.serverId === server.id && item.userId === user.id && item.permissions.includes(permission))); }
function authorizedServer(request: FastifyRequest, reply: FastifyReply, id: string, permission?: ServerPermission) { const server = findServer(id); if (!server) { reply.code(404).send({ error: 'Serveur introuvable.' }); return; } if (!hasPermission(currentUser(request)!, server, permission)) { reply.code(403).send({ error: 'Permission insuffisante.' }); return; } return server; }
function ownerServer(request: FastifyRequest, reply: FastifyReply, id: string) { const server = findServer(id); const user = currentUser(request)!; if (!server) { reply.code(404).send({ error: 'Serveur introuvable.' }); return; } if (user.role !== 'admin' && server.ownerId !== user.id) { reply.code(403).send({ error: 'Seul le propriétaire peut effectuer cette action.' }); return; } return server; }
function clientFor(server: MinecraftServer) { const node = store.snapshot.nodes.find((item) => item.id === server.nodeId); if (!node) throw new Error('Le nœud associé à ce serveur n’existe plus.'); return new NodeClient(node); }
function serverAddress(server: MinecraftServer) { if (server.domain) return server.domain; const allocation = store.snapshot.allocations.find((item) => item.id === server.allocationId); const hostname = allocation?.alias || (allocation?.ip && allocation.ip !== '0.0.0.0' ? allocation.ip : new URL(publicUrl).hostname); return `${hostname}:${server.port}`; }
async function runtimeStateFor(server: MinecraftServer) { try { return await clientFor(server).state(server); } catch (error) { return { status: 'unavailable' as const, error: (error as Error).message }; } }
async function statusFor(server: MinecraftServer) { return (await runtimeStateFor(server)).status; }
async function runtimeVersion(server: MinecraftServer) {
  try { const detected = (await clientFor(server).runtime(server)).minecraftVersion; if (detected) return detected; } catch { /* Le serveur n'a pas encore produit ses fichiers. */ }
  return server.version.toUpperCase() === 'LATEST' ? undefined : server.version;
}
function allocationStats(nodeId: string) { const items = store.snapshot.allocations.filter((item) => item.nodeId === nodeId && (!gateway.enabled || item.port !== gateway.publicPort)); return { total: items.length, used: items.filter((item) => item.serverId).length, free: items.filter((item) => !item.serverId).length }; }
function selectAllocation(nodeId: string, allocationId?: string, port?: number) { const items = store.snapshot.allocations.filter((item) => item.nodeId === nodeId && !item.serverId && (!gateway.enabled || item.port !== gateway.publicPort)); return allocationId ? items.find((item) => item.id === allocationId) : port ? items.find((item) => item.port === port) : items[0]; }
function audit(userId: string | undefined, action: string, targetType: string, targetId?: string, metadata: Record<string, unknown> = {}): AuditEntry { return { id: randomUUID(), userId, action, targetType, targetId, metadata, createdAt: new Date().toISOString() }; }
async function recordAudit(userId: string | undefined, action: string, targetType: string, targetId?: string, metadata: Record<string, unknown> = {}) { await store.update((draft) => { draft.auditLogs.unshift(audit(userId, action, targetType, targetId, metadata)); draft.auditLogs = draft.auditLogs.slice(0, 1000); }); }

const editableProperties = new Set([
  'motd', 'max-players', 'difficulty', 'gamemode', 'pvp', 'view-distance', 'simulation-distance',
  'spawn-protection', 'white-list', 'enforce-whitelist', 'allow-flight', 'hardcore',
  'enable-command-block', 'player-idle-timeout', 'allow-nether', 'generate-structures', 'level-seed',
]);

function parseServerProperties(content: string) {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1);
  }
  return Object.fromEntries([...editableProperties].map((key) => [key, values[key] ?? '']));
}

function updateServerProperties(content: string, updates: Record<string, string>) {
  const remaining = new Set(Object.keys(updates));
  const lines = content ? content.split(/\r?\n/) : ['#Minecraft server properties', `#${new Date().toISOString()}`];
  const result = lines.map((line) => {
    if (!line || line.trimStart().startsWith('#')) return line;
    const separator = line.indexOf('=');
    if (separator < 1) return line;
    const key = line.slice(0, separator).trim();
    if (!remaining.has(key)) return line;
    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });
  for (const key of remaining) result.push(`${key}=${updates[key]}`);
  return `${result.join('\n').replace(/\n+$/, '')}\n`;
}

async function runDueSchedules() {
  const due = store.snapshot.schedules.filter((item) => item.enabled && new Date(item.nextRunAt).getTime() <= Date.now() && !runningSchedules.has(item.id));
  for (const schedule of due) await executeSchedule(schedule);
}

async function executeSchedule(schedule: ServerSchedule) {
  runningSchedules.add(schedule.id);
  let status: 'success' | 'failed' = 'success'; let errorMessage: string | undefined;
  try {
    const server = findServer(schedule.serverId); if (!server) throw new Error('Serveur introuvable.');
    const client = clientFor(server);
    if (schedule.action === 'command') await client.command(server, schedule.payload!);
    else if (schedule.action === 'backup') await client.createBackup(server, schedule.name);
    else await client.action(server, schedule.action);
  } catch (error) { status = 'failed'; errorMessage = (error as Error).message; }
  finally {
    await store.update((draft) => {
      const item = draft.schedules.find((entry) => entry.id === schedule.id);
      if (item) { item.lastRunAt = new Date().toISOString(); item.lastStatus = status; item.nextRunAt = new Date(Date.now() + item.intervalMinutes * 60000).toISOString(); }
      draft.auditLogs.unshift(audit(undefined, 'schedule.execute', 'server', schedule.serverId, { scheduleId: schedule.id, status, error: errorMessage }));
    }).catch((error) => app.log.error(error));
    runningSchedules.delete(schedule.id);
  }
  return { status, error: errorMessage };
}

async function ensureDefaultNode() {
  const url = padockEnv('DEFAULT_NODE_URL') ?? (isProduction ? undefined : 'http://localhost:3001');
  const token = padockEnv('NODE_TOKEN') ?? (isProduction ? undefined : 'padock-development-node-token-change-me');
  if (url && token && !store.snapshot.nodes.length) {
    await store.update((draft) => {
      draft.nodes.push({ id: 'local001', name: 'Nœud principal', location: 'Local', url, token, createdAt: new Date().toISOString() });
    });
  }
  if (store.snapshot.nodes.length) {
    await store.update((draft) => {
      for (const node of draft.nodes) for (let port = 25565; port <= 25664; port++) {
        if (!draft.allocations.some((item) => item.nodeId === node.id && item.ip === '0.0.0.0' && item.port === port)) {
          draft.allocations.push({ id: randomUUID().slice(0, 8), nodeId: node.id, ip: '0.0.0.0', port });
        }
      }
    });
  }
}

function sessionCookie() { return { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: padockEnv('PUBLIC_URL')?.startsWith('https://') ?? false, maxAge: 60 * 60 * 12 }; }
function stripDockerHeader(chunk: Buffer) { let offset = 0; let output = ''; while (offset + 8 <= chunk.length) { const size = chunk.readUInt32BE(offset + 4); if (offset + 8 + size > chunk.length) return output + chunk.subarray(offset).toString(); output += chunk.subarray(offset + 8, offset + 8 + size).toString(); offset += 8 + size; } return output || chunk.toString(); }
interface DestroyableReadableStream extends NodeJS.ReadableStream { destroy(error?: Error): void; }
