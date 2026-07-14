import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { Store } from './store.js';
import { MinecraftGateway } from './gateway.js';
import { createApiSecret, createRecoveryCodes, createTotpSecret, hashPassword, hashSecret, verifyPassword, verifyTotp } from './auth.js';
import { NodeClient } from './node-client.js';
import { allowedKinds, curseForgeConfigured, resolveCurseForgeFiles, resolveCurseForgeModpack, searchCurseForge } from './curseforge.js';
import { padockEnv } from './config.js';
import { mailConfigured, sendAccountMail } from './mail.js';
import type { Allocation, AuditEntry, JobKind, MinecraftServer, PanelJob, PanelNotification, PanelPermission, PanelRole, ServerPermission, ServerSchedule, SftpAccount, UserGroup, UserRecord } from './types.js';

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
const runningSchedules = new Set<string>();
const runningJobs = new Set<string>();
const crashRestarting = new Set<string>();
const lastRestartCounts = new Map<string, number>();
let collectingMetrics = false;
let monitoringCrashes = false;
await store.load();
await store.update((draft) => {
  for (const job of draft.jobs) if (job.status === 'running') { job.status = 'queued'; job.step = 'Reprise après redémarrage du panel'; job.updatedAt = new Date().toISOString(); }
  for (const allocation of draft.allocations) if (allocation.reservationId && !draft.jobs.some((job) => job.id === allocation.reservationId && ['queued', 'running'].includes(job.status))) allocation.reservationId = undefined;
});
await ensureDefaultNode();
await syncPersistedSftpAccounts();
await gateway.sync(store.snapshot);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 128 * 1024 * 1024 }, (_request, body, done) => done(null, body));
await app.register(cookie);
await app.register(jwt, { secret: jwtSecret, cookie: { cookieName: 'padock_session', signed: false } });
await app.register(rateLimit, { global: false });

const auth = async (request: FastifyRequest, reply: FastifyReply) => {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer?.startsWith('padock_')) {
    const secretHash = hashSecret(bearer);
    const key = store.snapshot.apiKeys.find((item) => item.secretHash === secretHash && !item.revokedAt && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now()));
    if (!key) return reply.code(401).send({ error: 'Clé API invalide ou expirée.' });
    (request as FastifyRequest & { user: { sub: string; apiKeyId: string } }).user = { sub: key.userId, apiKeyId: key.id };
    if (!key.lastUsedAt || Date.now() - new Date(key.lastUsedAt).getTime() > 5 * 60_000) void store.update((draft) => { const item = draft.apiKeys.find((entry) => entry.id === key.id); if (item) item.lastUsedAt = new Date().toISOString(); });
    return;
  }
  try {
    const payload = await request.jwtVerify<{ sub: string; sid?: string }>();
    if (payload.sid) {
      const session = store.snapshot.sessions.find((item) => item.id === payload.sid && item.userId === payload.sub);
      if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) throw new Error('session expired');
      if (Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60_000) void store.update((draft) => { const item = draft.sessions.find((entry) => entry.id === session.id); if (item) item.lastSeenAt = new Date().toISOString(); });
    }
  } catch { return reply.code(401).send({ error: 'Authentification requise.' }); }
};

const requirePanelPermission = (permission: PanelPermission) => async (request: FastifyRequest, reply: FastifyReply) => {
  if (!hasPanelPermission(currentUser(request), permission)) return reply.code(403).send({ error: 'Permission globale insuffisante.' });
};

const requireAdministrator = async (request: FastifyRequest, reply: FastifyReply) => {
  if (currentUser(request)?.role !== 'admin') return reply.code(403).send({ error: 'Cette action est réservée aux administrateurs.' });
};

const panelPermissionValues = ['servers.create', 'servers.manage_all', 'nodes.view', 'nodes.manage', 'users.manage', 'audit.view'] as const;
const serverPermissionValues = ['console.read', 'console.command', 'power.start', 'power.stop', 'power.restart', 'files.read', 'files.write', 'content.manage', 'settings.manage', 'backups.manage', 'schedules.manage', 'sftp.manage', 'members.manage', 'server.delete'] as const;
const panelPermissionsSchema = z.array(z.enum(panelPermissionValues)).max(panelPermissionValues.length).transform((items) => [...new Set(items)]);
const panelRoleSchema = z.object({
  name: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} _.-]+$/u, 'Le nom du rôle contient des caractères non autorisés.'),
  description: z.string().trim().max(200).default(''),
  permissions: panelPermissionsSchema,
});
const userQuotaSchema = z.object({
  maxServers: z.number().int().min(-1).max(10000), maxMemoryMb: z.number().int().min(-1).max(10_000_000),
  maxDiskMb: z.number().int().min(-1).max(100_000_000), maxBackups: z.number().int().min(-1).max(10000),
});
const userGroupSchema = z.object({
  name: z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N} _.-]+$/u), description: z.string().trim().max(200).default(''),
  permissions: panelPermissionsSchema, serverPermissions: z.array(z.enum(serverPermissionValues)).max(serverPermissionValues.length).transform((items) => [...new Set(items)]),
});

const credentialsSchema = z.object({ username: z.string().trim().min(3).max(32), password: z.string().min(10).max(200) });
const sftpUsernameSchema = z.string().trim().toLowerCase().min(3).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/, 'Utilisez uniquement des lettres minuscules, chiffres, points, tirets ou underscores.');
const sftpPathsSchema = z.array(z.string().trim().min(1).max(500)).min(1, 'Choisissez au moins un dossier.').max(32);
const sftpAccountCreateSchema = z.object({
  username: sftpUsernameSchema,
  password: z.string().min(10, 'Le mot de passe doit contenir au moins 10 caractères.').max(200),
  paths: sftpPathsSchema,
  readOnly: z.boolean().default(false),
});
const sftpAccountUpdateSchema = z.object({
  username: sftpUsernameSchema.optional(),
  password: z.string().min(10, 'Le mot de passe doit contenir au moins 10 caractères.').max(200).optional(),
  paths: sftpPathsSchema.optional(),
  readOnly: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'Aucune modification reçue.');
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
  return { ok: true, database: process.env.DATABASE_URL ? 'postgresql' : 'json-development', nodes, mail: mailConfigured(), initialized: store.snapshot.users.length > 0 };
});

app.get('/api/auth/status', async () => ({ initialized: store.snapshot.users.length > 0 }));

app.post('/api/auth/password/forgot', { config: { rateLimit: { max: 4, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const parsed = z.object({ email: z.string().trim().email().max(254) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Adresse e-mail invalide.' });
  const user = store.snapshot.users.find((item) => item.email.toLowerCase() === parsed.data.email.toLowerCase());
  if (user && mailConfigured()) {
    const secret = createApiSecret(); const token = { id: randomUUID().slice(0, 8), userId: user.id, type: 'password_reset' as const, tokenHash: hashSecret(secret), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), createdAt: new Date().toISOString() };
    await store.update((draft) => { draft.accountTokens = draft.accountTokens.filter((item) => item.userId !== user.id || item.type !== 'password_reset' || item.usedAt); draft.accountTokens.push(token); });
    await sendAccountMail(user.email, 'Réinitialisation de votre mot de passe Padock', `Un changement de mot de passe a été demandé. Ouvrez ce lien dans les 30 minutes :\n\n${publicUrl}/?reset=${encodeURIComponent(secret)}\n\nSi vous n’êtes pas à l’origine de cette demande, ignorez ce message.`);
  }
  return reply.code(202).send({ ok: true, message: 'Si ce compte existe et que l’envoi SMTP est configuré, un message a été envoyé.' });
});

app.post('/api/auth/password/reset', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const parsed = z.object({ token: z.string().min(30).max(200), password: z.string().min(10).max(200) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Demande de réinitialisation invalide.' });
  const token = store.snapshot.accountTokens.find((item) => item.type === 'password_reset' && item.tokenHash === hashSecret(parsed.data.token) && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now());
  if (!token) return reply.code(400).send({ error: 'Ce lien est invalide ou expiré.' });
  const password = await hashPassword(parsed.data.password);
  await store.update((draft) => { const user = draft.users.find((item) => item.id === token.userId); if (user) Object.assign(user, password); const current = draft.accountTokens.find((item) => item.id === token.id); if (current) current.usedAt = new Date().toISOString(); for (const session of draft.sessions) if (session.userId === token.userId) session.revokedAt = new Date().toISOString(); draft.auditLogs.unshift(audit(token.userId, 'auth.password_reset', 'user', token.userId)); });
  return { ok: true };
});

app.post('/api/auth/setup', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (request, reply) => {
  if (store.snapshot.users.length) return reply.code(409).send({ error: 'Le panel est déjà configuré.' });
  const parsed = credentialsSchema.extend({ email: z.string().email().optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const password = await hashPassword(parsed.data.password);
  const user: UserRecord = {
    id: randomUUID().slice(0, 8), username: parsed.data.username,
    email: parsed.data.email ?? `${parsed.data.username}@padock.local`, role: 'admin', groupIds: [], permissions: [], quota: unlimitedQuota(),
    twoFactorEnabled: false, recoveryCodeHashes: [], emailVerified: false, ...password, createdAt: new Date().toISOString(),
  };
  await store.update((draft) => { draft.users.push(user); draft.auditLogs.unshift(audit(user.id, 'panel.setup', 'panel')); });
  await setSession(request, reply, user);
  return safeUser(user);
});

app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
  const parsed = credentialsSchema.safeParse(request.body);
  const user = parsed.success ? store.snapshot.users.find((item) => item.username.toLowerCase() === parsed.data.username.toLowerCase()) : undefined;
  if (!parsed.success || !user || !(await verifyPassword(parsed.data.password, user.salt, user.passwordHash))) {
    return reply.code(401).send({ error: 'Identifiants incorrects.' });
  }
  if (user.twoFactorEnabled) {
    return reply.code(202).send({ twoFactorRequired: true, challenge: app.jwt.sign({ sub: user.id, purpose: '2fa-login' }, { expiresIn: '5m' }) });
  }
  await setSession(request, reply, user);
  await recordAudit(user.id, 'auth.login', 'user', user.id);
  return safeUser(user);
});

app.post('/api/auth/2fa/login', { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } }, async (request, reply) => {
  const parsed = z.object({ challenge: z.string().min(20), code: z.string().trim().min(6).max(20) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Code de double authentification invalide.' });
  let payload: { sub: string; purpose?: string };
  try { payload = await app.jwt.verify(parsed.data.challenge); } catch { return reply.code(401).send({ error: 'La tentative de connexion a expiré.' }); }
  if (payload.purpose !== '2fa-login') return reply.code(401).send({ error: 'Tentative de connexion invalide.' });
  const user = store.snapshot.users.find((item) => item.id === payload.sub);
  if (!user?.twoFactorEnabled || !user.twoFactorSecret) return reply.code(401).send({ error: 'Double authentification indisponible.' });
  const normalized = parsed.data.code.toUpperCase();
  const recoveryHash = hashSecret(normalized);
  const recoveryIndex = user.recoveryCodeHashes.indexOf(recoveryHash);
  if (!verifyTotp(user.twoFactorSecret, parsed.data.code) && recoveryIndex < 0) return reply.code(401).send({ error: 'Code incorrect.' });
  if (recoveryIndex >= 0) await store.update((draft) => { const item = draft.users.find((entry) => entry.id === user.id); item?.recoveryCodeHashes.splice(recoveryIndex, 1); });
  await setSession(request, reply, user);
  await recordAudit(user.id, 'auth.login_2fa', 'user', user.id, { recoveryCode: recoveryIndex >= 0 });
  return safeUser(store.snapshot.users.find((item) => item.id === user.id)!);
});

app.post('/api/auth/logout', { preHandler: auth }, async (request, reply) => {
  const sid = (request.user as { sid?: string } | undefined)?.sid;
  if (sid) await store.update((draft) => { const session = draft.sessions.find((item) => item.id === sid); if (session) session.revokedAt = new Date().toISOString(); });
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
    if (changed.includes('email')) item.emailVerified = false;
    if (password) Object.assign(item, password);
    draft.auditLogs.unshift(audit(user.id, 'user.profile_update', 'user', user.id, { changed }));
  });
  return safeUser(store.snapshot.users.find((item) => item.id === user.id)!);
});

app.post('/api/auth/email/verification', { preHandler: auth, config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
  const user = currentUser(request)!; if (user.emailVerified) return { ok: true };
  if (!mailConfigured()) return reply.code(409).send({ error: 'Le serveur SMTP n’est pas configuré.' });
  const secret = createApiSecret(); const token = { id: randomUUID().slice(0, 8), userId: user.id, type: 'email_verification' as const, tokenHash: hashSecret(secret), expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), createdAt: new Date().toISOString() };
  await store.update((draft) => { draft.accountTokens = draft.accountTokens.filter((item) => item.userId !== user.id || item.type !== 'email_verification' || item.usedAt); draft.accountTokens.push(token); });
  await sendAccountMail(user.email, 'Vérifiez votre adresse e-mail Padock', `Confirmez votre adresse en ouvrant ce lien dans les 24 heures :\n\n${publicUrl}/?verify=${encodeURIComponent(secret)}`);
  return reply.code(202).send({ ok: true });
});

app.post('/api/auth/email/verify', async (request, reply) => {
  const parsed = z.object({ token: z.string().min(30).max(200) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Jeton invalide.' });
  const token = store.snapshot.accountTokens.find((item) => item.type === 'email_verification' && item.tokenHash === hashSecret(parsed.data.token) && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now());
  if (!token) return reply.code(400).send({ error: 'Ce lien est invalide ou expiré.' });
  await store.update((draft) => { const user = draft.users.find((item) => item.id === token.userId); if (user) user.emailVerified = true; const current = draft.accountTokens.find((item) => item.id === token.id); if (current) current.usedAt = new Date().toISOString(); draft.auditLogs.unshift(audit(token.userId, 'auth.email_verified', 'user', token.userId)); });
  return { ok: true };
});

app.post('/api/auth/2fa/setup', { preHandler: auth }, async (request, reply) => {
  const parsed = z.object({ currentPassword: z.string().min(10).max(200) }).safeParse(request.body);
  const user = currentUser(request)!;
  if (!parsed.success || !(await verifyPassword(parsed.data.currentPassword, user.salt, user.passwordHash))) return reply.code(401).send({ error: 'Mot de passe actuel incorrect.' });
  const secret = createTotpSecret();
  await store.update((draft) => { const item = draft.users.find((entry) => entry.id === user.id); if (item) { item.twoFactorSecret = secret; item.twoFactorEnabled = false; item.recoveryCodeHashes = []; } });
  const issuer = encodeURIComponent('Padock'); const account = encodeURIComponent(user.email);
  return { secret, uri: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&digits=6&period=30` };
});

app.post('/api/auth/2fa/confirm', { preHandler: auth }, async (request, reply) => {
  const parsed = z.object({ code: z.string().trim().length(6) }).safeParse(request.body);
  const user = currentUser(request)!;
  if (!parsed.success || !user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, parsed.data.code)) return reply.code(400).send({ error: 'Code TOTP incorrect.' });
  const recoveryCodes = createRecoveryCodes();
  await store.update((draft) => {
    const item = draft.users.find((entry) => entry.id === user.id);
    if (item) { item.twoFactorEnabled = true; item.recoveryCodeHashes = recoveryCodes.map((code) => hashSecret(code)); }
    draft.auditLogs.unshift(audit(user.id, 'auth.2fa_enable', 'user', user.id));
  });
  return { recoveryCodes };
});

app.delete('/api/auth/2fa', { preHandler: auth }, async (request, reply) => {
  const parsed = z.object({ currentPassword: z.string().min(10).max(200), code: z.string().trim().min(6).max(20) }).safeParse(request.body);
  const user = currentUser(request)!;
  if (!parsed.success || !(await verifyPassword(parsed.data.currentPassword, user.salt, user.passwordHash))) return reply.code(401).send({ error: 'Mot de passe actuel incorrect.' });
  if (user.twoFactorEnabled && user.twoFactorSecret && !verifyTotp(user.twoFactorSecret, parsed.data.code) && !user.recoveryCodeHashes.includes(hashSecret(parsed.data.code.toUpperCase()))) return reply.code(401).send({ error: 'Code de double authentification incorrect.' });
  await store.update((draft) => { const item = draft.users.find((entry) => entry.id === user.id); if (item) { item.twoFactorSecret = undefined; item.twoFactorEnabled = false; item.recoveryCodeHashes = []; } draft.auditLogs.unshift(audit(user.id, 'auth.2fa_disable', 'user', user.id)); });
  return { ok: true };
});

app.get('/api/auth/sessions', { preHandler: auth }, async (request) => {
  const user = currentUser(request)!; const currentSid = (request.user as { sid?: string }).sid;
  return store.snapshot.sessions.filter((item) => item.userId === user.id && !item.revokedAt && new Date(item.expiresAt).getTime() > Date.now()).map((item) => ({ ...item, current: item.id === currentSid }));
});

app.delete('/api/auth/sessions/:id', { preHandler: auth }, async (request, reply) => {
  const user = currentUser(request)!; const id = (request.params as { id: string }).id;
  const session = store.snapshot.sessions.find((item) => item.id === id && item.userId === user.id);
  if (!session) return reply.code(404).send({ error: 'Session introuvable.' });
  await store.update((draft) => { const item = draft.sessions.find((entry) => entry.id === id); if (item) item.revokedAt = new Date().toISOString(); });
  return { ok: true };
});

app.get('/api/auth/api-keys', { preHandler: auth }, async (request) => store.snapshot.apiKeys.filter((item) => item.userId === currentUser(request)!.id).map(({ secretHash: _secretHash, ...item }) => item));

app.post('/api/auth/api-keys', { preHandler: auth }, async (request, reply) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(50), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const user = currentUser(request)!; const secret = createApiSecret(); const now = new Date();
  const key = { id: randomUUID().slice(0, 8), userId: user.id, name: parsed.data.name, prefix: secret.slice(0, 14), secretHash: hashSecret(secret), createdAt: now.toISOString(), expiresAt: parsed.data.expiresInDays ? new Date(now.getTime() + parsed.data.expiresInDays * 86400_000).toISOString() : undefined };
  await store.update((draft) => { draft.apiKeys.unshift(key); draft.auditLogs.unshift(audit(user.id, 'auth.api_key_create', 'api_key', key.id, { name: key.name })); });
  return reply.code(201).send({ ...key, secretHash: undefined, secret });
});

app.delete('/api/auth/api-keys/:id', { preHandler: auth }, async (request, reply) => {
  const user = currentUser(request)!; const id = (request.params as { id: string }).id;
  const key = store.snapshot.apiKeys.find((item) => item.id === id && item.userId === user.id);
  if (!key) return reply.code(404).send({ error: 'Clé API introuvable.' });
  await store.update((draft) => { const item = draft.apiKeys.find((entry) => entry.id === id); if (item) item.revokedAt = new Date().toISOString(); draft.auditLogs.unshift(audit(user.id, 'auth.api_key_revoke', 'api_key', id)); });
  return { ok: true };
});

app.get('/api/users/directory', { preHandler: auth }, async () => store.snapshot.users.map((user) => ({ id: user.id, username: user.username })));

app.get('/api/roles', { preHandler: [auth, requirePanelPermission('users.manage')] }, async () => store.snapshot.roles.map(safePanelRole));

app.post('/api/roles', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const parsed = panelRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (isReservedRoleName(parsed.data.name)) return reply.code(400).send({ error: 'Ce nom est réservé à un rôle système.' });
  if (store.snapshot.roles.some((role) => role.name.toLocaleLowerCase() === parsed.data.name.toLocaleLowerCase())) {
    return reply.code(409).send({ error: 'Un rôle porte déjà ce nom.' });
  }
  const now = new Date().toISOString();
  const role: PanelRole = { id: randomUUID().slice(0, 8), ...parsed.data, createdAt: now, updatedAt: now };
  const actor = currentUser(request)!;
  await store.update((draft) => {
    draft.roles.push(role);
    draft.auditLogs.unshift(audit(actor.id, 'role.create', 'role', role.id, { name: role.name, permissions: role.permissions }));
  });
  return reply.code(201).send(safePanelRole(role));
});

app.put('/api/roles/:id', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const existing = store.snapshot.roles.find((role) => role.id === id);
  if (!existing) return reply.code(404).send({ error: 'Rôle introuvable.' });
  const parsed = panelRoleSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (isReservedRoleName(parsed.data.name)) return reply.code(400).send({ error: 'Ce nom est réservé à un rôle système.' });
  if (store.snapshot.roles.some((role) => role.id !== id && role.name.toLocaleLowerCase() === parsed.data.name.toLocaleLowerCase())) {
    return reply.code(409).send({ error: 'Un rôle porte déjà ce nom.' });
  }
  const actor = currentUser(request)!;
  await store.update((draft) => {
    const role = draft.roles.find((item) => item.id === id)!;
    role.name = parsed.data.name; role.description = parsed.data.description; role.permissions = parsed.data.permissions; role.updatedAt = new Date().toISOString();
    draft.auditLogs.unshift(audit(actor.id, 'role.update', 'role', id, { name: role.name, permissions: role.permissions }));
  });
  return safePanelRole(store.snapshot.roles.find((role) => role.id === id)!);
});

app.delete('/api/roles/:id', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const role = store.snapshot.roles.find((item) => item.id === id);
  if (!role) return reply.code(404).send({ error: 'Rôle introuvable.' });
  const assigned = store.snapshot.users.filter((user) => user.roleId === id).length;
  if (assigned) return reply.code(409).send({ error: `Ce rôle est encore attribué à ${assigned} utilisateur${assigned > 1 ? 's' : ''}.` });
  const actor = currentUser(request)!;
  await store.update((draft) => {
    draft.roles = draft.roles.filter((item) => item.id !== id);
    draft.auditLogs.unshift(audit(actor.id, 'role.delete', 'role', id, { name: role.name }));
  });
  return { ok: true };
});

app.get('/api/groups', { preHandler: [auth, requirePanelPermission('users.manage')] }, async () => store.snapshot.groups.map(safeGroup));

app.post('/api/groups', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const parsed = userGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (store.snapshot.groups.some((item) => item.name.toLowerCase() === parsed.data.name.toLowerCase())) return reply.code(409).send({ error: 'Un groupe porte déjà ce nom.' });
  const now = new Date().toISOString(); const group: UserGroup = { id: randomUUID().slice(0, 8), ...parsed.data, createdAt: now, updatedAt: now };
  await store.update((draft) => { draft.groups.push(group); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'group.create', 'group', group.id, { name: group.name })); });
  return reply.code(201).send(safeGroup(group));
});

app.put('/api/groups/:id', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const id = (request.params as { id: string }).id; const parsed = userGroupSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (!store.snapshot.groups.some((item) => item.id === id)) return reply.code(404).send({ error: 'Groupe introuvable.' });
  if (store.snapshot.groups.some((item) => item.id !== id && item.name.toLowerCase() === parsed.data.name.toLowerCase())) return reply.code(409).send({ error: 'Un groupe porte déjà ce nom.' });
  await store.update((draft) => { const item = draft.groups.find((entry) => entry.id === id)!; Object.assign(item, parsed.data, { updatedAt: new Date().toISOString() }); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'group.update', 'group', id)); });
  return safeGroup(store.snapshot.groups.find((item) => item.id === id)!);
});

app.delete('/api/groups/:id', { preHandler: [auth, requireAdministrator] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (!store.snapshot.groups.some((item) => item.id === id)) return reply.code(404).send({ error: 'Groupe introuvable.' });
  await store.update((draft) => { draft.groups = draft.groups.filter((item) => item.id !== id); for (const user of draft.users) user.groupIds = user.groupIds.filter((item) => item !== id); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'group.delete', 'group', id)); });
  return { ok: true };
});

app.get('/api/users', { preHandler: [auth, requirePanelPermission('users.manage')] }, async () => store.snapshot.users.map(safeUser));

app.post('/api/users', { preHandler: [auth, requirePanelPermission('users.manage')] }, async (request, reply) => {
  const parsed = credentialsSchema.extend({ email: z.string().email(), role: z.enum(['admin', 'user']).default('user'), roleId: z.string().min(1).nullable().optional(), groupIds: z.array(z.string().min(1)).max(50).default([]), permissions: panelPermissionsSchema.default([]), quota: userQuotaSchema.default(unlimitedQuota()) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const actor = currentUser(request)!;
  if (actor.role !== 'admin' && Object.prototype.hasOwnProperty.call(request.body as object, 'quota')) return reply.code(403).send({ error: 'Seul un administrateur peut définir des quotas.' });
  const roleId = parsed.data.role === 'admin' ? undefined : parsed.data.roleId ?? undefined;
  if (parsed.data.groupIds.some((id) => !store.snapshot.groups.some((group) => group.id === id))) return reply.code(400).send({ error: 'Un groupe sélectionné n’existe pas.' });
  if (actor.role !== 'admin' && parsed.data.groupIds.length) return reply.code(403).send({ error: 'Seul un administrateur peut attribuer des groupes.' });
  const assignmentError = validatePermissionAssignment(actor, parsed.data.role, parsed.data.permissions, roleId);
  if (assignmentError) return reply.code(403).send({ error: assignmentError });
  if (store.snapshot.users.some((item) => item.username.toLowerCase() === parsed.data.username.toLowerCase() || item.email.toLowerCase() === parsed.data.email.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce nom ou cette adresse e-mail est déjà utilisé.' });
  }
  const password = await hashPassword(parsed.data.password);
  const user: UserRecord = { id: randomUUID().slice(0, 8), username: parsed.data.username, email: parsed.data.email, role: parsed.data.role, roleId, groupIds: parsed.data.role === 'admin' ? [] : parsed.data.groupIds, permissions: parsed.data.role === 'admin' ? [] : parsed.data.permissions, quota: parsed.data.role === 'admin' ? unlimitedQuota() : parsed.data.quota, twoFactorEnabled: false, recoveryCodeHashes: [], emailVerified: false, ...password, createdAt: new Date().toISOString() };
  await store.update((draft) => { draft.users.push(user); draft.auditLogs.unshift(audit(actor.id, 'user.create', 'user', user.id, { role: user.role, roleId: user.roleId, permissions: user.permissions })); });
  return reply.code(201).send(safeUser(user));
});

app.put('/api/users/:id', { preHandler: [auth, requirePanelPermission('users.manage')] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const actor = currentUser(request)!;
  const user = store.snapshot.users.find((item) => item.id === id);
  if (!user) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
  if (id === actor.id) return reply.code(400).send({ error: 'Modifiez uniquement votre profil depuis la page « Mon profil ».' });
  if (actor.role !== 'admin' && user.role === 'admin') return reply.code(403).send({ error: 'Seul un administrateur peut modifier un autre administrateur.' });
  const parsed = z.object({ role: z.enum(['admin', 'user']), roleId: z.string().min(1).nullable().optional(), groupIds: z.array(z.string().min(1)).max(50).optional(), permissions: panelPermissionsSchema, quota: userQuotaSchema.optional(), password: z.string().min(10).max(200).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const roleId = parsed.data.role === 'admin' ? undefined : parsed.data.roleId ?? undefined;
  const groupIds = parsed.data.role === 'admin' ? [] : parsed.data.groupIds ?? user.groupIds;
  if (groupIds.some((groupId) => !store.snapshot.groups.some((group) => group.id === groupId))) return reply.code(400).send({ error: 'Un groupe sélectionné n’existe pas.' });
  if (actor.role !== 'admin' && (parsed.data.groupIds || parsed.data.quota)) return reply.code(403).send({ error: 'Seul un administrateur peut modifier les groupes ou quotas.' });
  if (parsed.data.quota) {
    const owned = store.snapshot.servers.filter((server) => server.ownerId === user.id); const memory = owned.reduce((total, server) => total + server.memoryMb, 0); const disk = owned.reduce((total, server) => total + server.diskMb, 0);
    if (parsed.data.quota.maxServers >= 0 && parsed.data.quota.maxServers < owned.length) return reply.code(409).send({ error: `Ce compte possède déjà ${owned.length} serveur(s).` });
    if (parsed.data.quota.maxMemoryMb >= 0 && parsed.data.quota.maxMemoryMb < memory) return reply.code(409).send({ error: `Ce compte utilise déjà ${memory} Mo de RAM.` });
    if (parsed.data.quota.maxDiskMb >= 0 && parsed.data.quota.maxDiskMb < disk) return reply.code(409).send({ error: `Ce compte utilise déjà ${disk} Mo de disque.` });
  }
  const assignmentError = validatePermissionAssignment(actor, parsed.data.role, parsed.data.permissions, roleId);
  if (assignmentError) return reply.code(403).send({ error: assignmentError });
  if (user.role === 'admin' && parsed.data.role !== 'admin' && store.snapshot.users.filter((item) => item.role === 'admin').length <= 1) {
    return reply.code(409).send({ error: 'Le panel doit conserver au moins un administrateur.' });
  }
  const password = parsed.data.password ? await hashPassword(parsed.data.password) : undefined;
  await store.update((draft) => {
    const item = draft.users.find((entry) => entry.id === id)!;
    item.role = parsed.data.role; item.roleId = roleId; item.groupIds = groupIds; item.permissions = parsed.data.role === 'admin' ? [] : parsed.data.permissions; item.quota = parsed.data.role === 'admin' ? unlimitedQuota() : parsed.data.quota ?? item.quota;
    if (password) Object.assign(item, password);
    draft.auditLogs.unshift(audit(actor.id, 'user.permissions_update', 'user', id, { role: item.role, roleId: item.roleId, permissions: item.permissions, passwordReset: Boolean(password) }));
  });
  return safeUser(store.snapshot.users.find((item) => item.id === id)!);
});

app.delete('/api/users/:id', { preHandler: [auth, requirePanelPermission('users.manage')] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (id === currentUser(request)?.id) return reply.code(400).send({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  const target = store.snapshot.users.find((item) => item.id === id);
  if (!target) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
  if (currentUser(request)?.role !== 'admin' && target.role === 'admin') return reply.code(403).send({ error: 'Seul un administrateur peut supprimer un autre administrateur.' });
  if (target.role === 'admin' && store.snapshot.users.filter((item) => item.role === 'admin').length <= 1) return reply.code(409).send({ error: 'Le panel doit conserver au moins un administrateur.' });
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
  const nodes = hasAnyPanelPermission(user, ['nodes.view', 'nodes.manage', 'servers.create']) ? store.snapshot.nodes : store.snapshot.nodes.filter((node) => visibleNodeIds.has(node.id));
  return Promise.all(nodes.map(async ({ token, ...node }) => {
  const capacity = nodeCapacity(node.id);
  try { return { ...node, online: true, health: await new NodeClient({ ...node, token }).health(), allocations: allocationStats(node.id), capacity }; }
  catch { return { ...node, online: false, allocations: allocationStats(node.id), capacity }; }
  }));
});

app.post('/api/nodes', { preHandler: [auth, requirePanelPermission('nodes.manage')] }, async (request, reply) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(40), location: z.string().trim().min(2).max(60),
    url: z.string().url().refine((value) => value.startsWith('https://') || !isProduction, 'HTTPS est obligatoire en production.'),
    token: z.string().min(32).max(500), ip: z.string().trim().min(2).max(255).default('0.0.0.0'),
    portStart: z.number().int().min(1024).max(65535).default(25565), portEnd: z.number().int().min(1024).max(65535).default(25664),
    maxMemoryMb: z.number().int().min(1024).max(10_000_000).optional(), maxDiskMb: z.number().int().min(1024).max(100_000_000).optional(),
  }).refine((value) => value.portEnd >= value.portStart && value.portEnd - value.portStart <= 2000, 'Plage de ports invalide ou trop grande.').safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const { ip, portStart, portEnd, ...nodeInput } = parsed.data;
  const node = { id: randomUUID().slice(0, 8), ...nodeInput, maintenance: false, createdAt: new Date().toISOString() };
  try { await new NodeClient(node).health(); } catch (error) { return reply.code(400).send({ error: `Agent injoignable : ${(error as Error).message}` }); }
  await store.update((draft) => {
    draft.nodes.push(node);
    for (let value = portStart; value <= portEnd; value++) draft.allocations.push({ id: randomUUID().slice(0, 8), nodeId: node.id, ip, port: value });
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'node.create', 'node', node.id, { portStart, portEnd }));
  });
  const { token: _token, ...safeNode } = node;
  return reply.code(201).send({ ...safeNode, online: true, allocations: allocationStats(node.id) });
});

app.put('/api/nodes/:id', { preHandler: [auth, requirePanelPermission('nodes.manage')] }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const existing = store.snapshot.nodes.find((node) => node.id === id);
  if (!existing) return reply.code(404).send({ error: 'Nœud introuvable.' });
  const parsed = z.object({
    name: z.string().trim().min(2).max(40),
    location: z.string().trim().min(2).max(60),
    url: z.string().url(),
    token: z.union([z.string().min(32).max(500), z.literal('')]).optional(),
    maintenance: z.boolean().optional(), maintenanceMessage: z.string().trim().max(200).nullable().optional(),
    maxMemoryMb: z.number().int().min(1024).max(10_000_000).nullable().optional(), maxDiskMb: z.number().int().min(1024).max(100_000_000).nullable().optional(),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (isProduction && parsed.data.url !== existing.url && !parsed.data.url.startsWith('https://')) {
    return reply.code(400).send({ error: 'HTTPS est obligatoire pour une nouvelle adresse d’agent en production.' });
  }
  const token = parsed.data.token || existing.token;
  const connectionChanged = parsed.data.url !== existing.url || token !== existing.token;
  if (connectionChanged) {
    try { await new NodeClient({ ...existing, name: parsed.data.name, location: parsed.data.location, url: parsed.data.url, token }).health(); }
    catch (error) { return reply.code(400).send({ error: `Agent injoignable avec cette configuration : ${(error as Error).message}` }); }
  }
  const changed = ['name', 'location', 'url'].filter((field) => parsed.data[field as 'name' | 'location' | 'url'] !== existing[field as 'name' | 'location' | 'url']);
  if (token !== existing.token) changed.push('token');
  await store.update((draft) => {
    const node = draft.nodes.find((item) => item.id === id)!;
    node.name = parsed.data.name; node.location = parsed.data.location; node.url = parsed.data.url; node.token = token;
    if (parsed.data.maintenance !== undefined) node.maintenance = parsed.data.maintenance;
    if (parsed.data.maintenanceMessage !== undefined) node.maintenanceMessage = parsed.data.maintenanceMessage || undefined;
    if (parsed.data.maxMemoryMb !== undefined) node.maxMemoryMb = parsed.data.maxMemoryMb ?? undefined;
    if (parsed.data.maxDiskMb !== undefined) node.maxDiskMb = parsed.data.maxDiskMb ?? undefined;
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'node.update', 'node', id, { changed }));
  });
  return { id, name: parsed.data.name, location: parsed.data.location, url: parsed.data.url, maintenance: parsed.data.maintenance ?? existing.maintenance, allocations: allocationStats(id), capacity: nodeCapacity(id) };
});

app.get('/api/nodes/:id/allocations', { preHandler: [auth, requirePanelPermission('nodes.manage')] }, async (request) => store.snapshot.allocations.filter((item) => item.nodeId === (request.params as { id: string }).id));

app.get('/api/nodes/:id/allocations/available', { preHandler: [auth, requirePanelPermission('servers.create')] }, async (request, reply) => {
  const nodeId = (request.params as { id: string }).id;
  if (!store.snapshot.nodes.some((node) => node.id === nodeId)) return reply.code(404).send({ error: 'Nœud introuvable.' });
  return availableAllocations(nodeId).map(({ serverId: _serverId, ...allocation }) => allocation);
});

app.post('/api/nodes/:id/allocations', { preHandler: [auth, requirePanelPermission('nodes.manage')] }, async (request, reply) => {
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

app.delete('/api/nodes/:id/allocations/:allocationId', { preHandler: [auth, requirePanelPermission('nodes.manage')] }, async (request, reply) => {
  const { id: nodeId, allocationId } = request.params as { id: string; allocationId: string };
  const allocation = store.snapshot.allocations.find((item) => item.id === allocationId && item.nodeId === nodeId);
  if (!allocation) return reply.code(404).send({ error: 'Allocation introuvable sur ce nœud.' });
  if (allocation.serverId || allocation.reservationId) return reply.code(409).send({ error: 'Cette allocation est utilisée ou réservée par une opération en cours.' });
  await store.update((draft) => {
    draft.allocations = draft.allocations.filter((item) => item.id !== allocationId);
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'allocation.delete', 'node', nodeId, { allocationId, ip: allocation.ip, port: allocation.port }));
  });
  return { ok: true };
});

app.get('/api/servers', { preHandler: auth }, async (request) => Promise.all(visibleServers(currentUser(request)!).map(async (server) => {
  const user = currentUser(request)!;
  const runtime = await runtimeStateFor(server);
  const job = latestServerJob(server.id);
  const status = job && ['queued', 'running'].includes(job.status) && job.kind === 'server.create' ? 'installing' : job?.kind === 'server.create' && job.status === 'failed' && runtime.status === 'missing' ? 'failed' : runtime.status;
  return { ...server, permissions: effectiveServerPermissions(user, server), address: serverAddress(server), status, runtime, activeJob: job && ['queued', 'running'].includes(job.status) ? publicJob(job) : undefined };
})));

app.get('/api/gateway', { preHandler: auth }, async () => gateway.status(store.snapshot));

app.get('/api/templates', { preHandler: [auth, requirePanelPermission('servers.create')] }, async () => store.snapshot.templates);

app.post('/api/templates', { preHandler: [auth, requirePanelPermission('servers.create')] }, async (request, reply) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(50), description: z.string().trim().max(200).default(''), software: z.enum(['PAPER', 'VANILLA', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']), version: z.string().trim().min(1).max(30), memoryMb: z.number().int().min(1024).max(65536), cpuPercent: z.number().int().min(10).max(1600), diskMb: z.number().int().min(1024).max(1048576) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (store.snapshot.templates.some((item) => item.name.toLowerCase() === parsed.data.name.toLowerCase())) return reply.code(409).send({ error: 'Un modèle porte déjà ce nom.' });
  const now = new Date().toISOString(); const template = { id: randomUUID().slice(0, 8), ...parsed.data, createdBy: currentUser(request)!.id, createdAt: now, updatedAt: now };
  await store.update((draft) => { draft.templates.push(template); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'template.create', 'template', template.id, { name: template.name })); }); return reply.code(201).send(template);
});

app.post('/api/servers/:id/template', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  const parsed = z.object({ name: z.string().trim().min(2).max(50), description: z.string().trim().max(200).default('') }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Nom de modèle invalide.' });
  if (store.snapshot.templates.some((item) => item.name.toLowerCase() === parsed.data.name.toLowerCase())) return reply.code(409).send({ error: 'Un modèle porte déjà ce nom.' });
  const now = new Date().toISOString(); const template = { id: randomUUID().slice(0, 8), ...parsed.data, software: server.software, version: server.version, memoryMb: server.memoryMb, cpuPercent: server.cpuPercent, diskMb: server.diskMb, createdBy: currentUser(request)!.id, createdAt: now, updatedAt: now };
  await store.update((draft) => { draft.templates.push(template); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'template.create_from_server', 'template', template.id, { serverId: server.id })); }); return reply.code(201).send(template);
});

app.delete('/api/templates/:id', { preHandler: [auth, requirePanelPermission('servers.create')] }, async (request, reply) => {
  const id = (request.params as { id: string }).id; const template = store.snapshot.templates.find((item) => item.id === id); if (!template) return reply.code(404).send({ error: 'Modèle introuvable.' });
  const user = currentUser(request)!; if (user.role !== 'admin' && template.createdBy !== user.id) return reply.code(403).send({ error: 'Seul le créateur ou un administrateur peut supprimer ce modèle.' });
  await store.update((draft) => { draft.templates = draft.templates.filter((item) => item.id !== id); draft.auditLogs.unshift(audit(user.id, 'template.delete', 'template', id)); }); return { ok: true };
});

app.get('/api/curseforge/modpacks', { preHandler: [auth, requirePanelPermission('servers.create')] }, async (request, reply) => {
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

app.post('/api/servers', { preHandler: [auth, requirePanelPermission('servers.create')] }, async (request, reply) => {
  const parsed = serverSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const node = store.snapshot.nodes.find((item) => item.id === parsed.data.nodeId);
  if (!node) return reply.code(404).send({ error: 'Nœud Linux introuvable.' });
  if (node.maintenance) return reply.code(409).send({ error: node.maintenanceMessage || 'Ce nœud est actuellement en maintenance.' });
  const actor = currentUser(request)!;
  const requestedOwnerId = hasPanelPermission(actor, 'servers.manage_all') ? (parsed.data.ownerId ?? actor.id) : actor.id;
  const owner = store.snapshot.users.find((item) => item.id === requestedOwnerId);
  if (!owner) return reply.code(404).send({ error: 'Propriétaire introuvable.' });
  const quotaError = checkUserQuota(owner, parsed.data.memoryMb, parsed.data.diskMb);
  if (quotaError) return reply.code(409).send({ error: quotaError });
  const capacityError = checkNodeCapacity(node.id, parsed.data.memoryMb, parsed.data.diskMb);
  if (capacityError) return reply.code(409).send({ error: capacityError });
  if (gateway.enabled && parsed.data.port === gateway.publicPort) {
    return reply.code(409).send({ error: `Le port ${gateway.publicPort} est réservé à la passerelle Minecraft.` });
  }
  if (parsed.data.allocationId && !store.snapshot.allocations.some((item) => item.id === parsed.data.allocationId && item.nodeId === node.id)) {
    return reply.code(409).send({ error: 'Cette allocation n’appartient pas au nœud sélectionné.' });
  }
  if (parsed.data.port && !store.snapshot.allocations.some((item) => item.nodeId === node.id && item.port === parsed.data.port)) {
    return reply.code(409).send({ error: `Le port ${parsed.data.port} ne fait pas partie des allocations configurées sur ce nœud.` });
  }
  const id = randomUUID().slice(0, 8);
  const jobId = randomUUID().slice(0, 8);
  const domain = parsed.data.subdomain ? gateway.domainFor(parsed.data.subdomain) : undefined;
  if (domain && store.snapshot.servers.some((item) => item.domain?.toLowerCase() === domain.toLowerCase())) return reply.code(409).send({ error: 'Ce sous-domaine est déjà utilisé par un autre serveur.' });
  if (parsed.data.modpack && !['FABRIC', 'FORGE', 'NEOFORGE'].includes(parsed.data.software)) {
    return reply.code(400).send({ error: 'Les modpacks CurseForge nécessitent Fabric, Forge ou NeoForge.' });
  }
  let created!: { server: MinecraftServer; job: PanelJob };
  try {
    created = await store.transaction((draft) => {
      const candidates = draft.allocations.filter((item) => item.nodeId === node.id && !item.serverId && !item.reservationId && (!gateway.enabled || item.port !== gateway.publicPort));
      const allocation = parsed.data.allocationId ? candidates.find((item) => item.id === parsed.data.allocationId) : parsed.data.port ? candidates.find((item) => item.port === parsed.data.port) : candidates.sort((a, b) => a.port - b.port)[0];
      if (!allocation) throw httpError(409, 'Cette allocation est déjà utilisée, réservée, ou aucune allocation libre n’est disponible.');
      if (domain && draft.servers.some((item) => item.domain?.toLowerCase() === domain.toLowerCase())) throw httpError(409, 'Ce sous-domaine est déjà utilisé par un autre serveur.');
      const server: MinecraftServer = {
        id, name: parsed.data.name, software: parsed.data.software, version: parsed.data.version,
        memoryMb: parsed.data.memoryMb, cpuPercent: parsed.data.cpuPercent, diskMb: parsed.data.diskMb,
        port: allocation.port, nodeId: node.id, allocationId: allocation.id, ownerId: owner.id, domain,
        crashPolicy: defaultCrashPolicy(), backupPolicy: defaultBackupPolicy(), createdAt: new Date().toISOString(),
      };
      const job = makeJob('server.create', actor.id, server.id, node.id, { modpack: parsed.data.modpack });
      job.id = jobId; allocation.serverId = server.id; draft.servers.push(server); draft.jobs.unshift(job);
      draft.auditLogs.unshift(audit(actor.id, 'server.installing', 'server', server.id, { nodeId: node.id, ownerId: owner.id, jobId }));
      return { server, job };
    });
  } catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }); }
  await gateway.sync(store.snapshot);
  void runJob(created.job.id);
  return reply.code(202).send({ ...created.server, permissions: effectiveServerPermissions(actor, created.server), address: serverAddress(created.server), status: 'installing', job: publicJob(created.job) });
});

app.put('/api/servers/:id', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
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
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
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

app.get('/api/servers/:id/metrics', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'console.read'); if (!server) return;
  const parsed = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Période invalide.' });
  const since = Date.now() - parsed.data.hours * 3600_000;
  return store.snapshot.metrics.filter((item) => item.serverId === server.id && new Date(item.createdAt).getTime() >= since);
});

app.put('/api/servers/:id/resources', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  const parsed = z.object({
    memoryMb: z.number().int().min(1024).max(65536),
    cpuPercent: z.number().int().min(10).max(1600),
    diskMb: z.number().int().min(1024).max(1048576),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Ressources invalides.' });
  const resourceError = checkResourceUpdate(server, parsed.data.memoryMb, parsed.data.diskMb); if (resourceError) return reply.code(409).send({ error: resourceError });
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
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  try {
    const result = await clientFor(server).readFile(server, 'server.properties');
    return { values: parseServerProperties(result.content) };
  } catch (error) {
    if ((error as Error).message.includes('ENOENT')) return { values: {} };
    throw error;
  }
});

app.put('/api/servers/:id/properties', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
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

app.get('/api/servers/:id/sftp/accounts', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'sftp.manage'); if (!server) return;
  const health = await clientFor(server).health();
  return {
    host: sftpPublicHost,
    port: sftpPublicPort,
    enabled: Boolean(health.sftp?.enabled),
    accounts: store.snapshot.sftpAccounts.filter((account) => account.serverId === server.id).map(safeSftpAccount),
  };
});

app.post('/api/servers/:id/sftp/accounts', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'sftp.manage'); if (!server) return;
  const parsed = sftpAccountCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (store.snapshot.sftpAccounts.some((account) => account.username.toLowerCase() === parsed.data.username.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce nom d’utilisateur SFTP est déjà utilisé.' });
  }
  const client = clientFor(server);
  const health = await client.health();
  if (!health.sftp?.enabled) return reply.code(409).send({ error: 'Le SFTP n’est pas activé sur ce nœud.' });
  const paths = await validateSftpPaths(server, parsed.data.paths);
  const password = await hashPassword(parsed.data.password);
  const now = new Date().toISOString();
  const account: SftpAccount = {
    id: randomUUID().slice(0, 8), serverId: server.id, username: parsed.data.username,
    ...password, paths, readOnly: parsed.data.readOnly, enabled: true, createdAt: now, updatedAt: now,
  };
  await client.syncSftpAccount(account);
  try {
    await store.update((draft) => {
      draft.sftpAccounts.push(account);
      draft.auditLogs.unshift(audit(currentUser(request)?.id, 'sftp.account_create', 'server', server.id, { accountId: account.id, username: account.username, paths: account.paths, readOnly: account.readOnly }));
    });
  } catch (error) {
    await client.deleteSftpAccount(account.id).catch(() => undefined);
    throw error;
  }
  return reply.code(201).send(safeSftpAccount(account));
});

app.put('/api/servers/:id/sftp/accounts/:accountId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'sftp.manage'); if (!server) return;
  const accountId = (request.params as { accountId: string }).accountId;
  const previous = store.snapshot.sftpAccounts.find((account) => account.id === accountId && account.serverId === server.id);
  if (!previous) return reply.code(404).send({ error: 'Compte SFTP introuvable.' });
  const parsed = sftpAccountUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  if (parsed.data.username && store.snapshot.sftpAccounts.some((account) => account.id !== previous.id && account.username.toLowerCase() === parsed.data.username!.toLowerCase())) {
    return reply.code(409).send({ error: 'Ce nom d’utilisateur SFTP est déjà utilisé.' });
  }
  const updated: SftpAccount = {
    ...previous,
    username: parsed.data.username ?? previous.username,
    paths: parsed.data.paths ? await validateSftpPaths(server, parsed.data.paths) : previous.paths,
    readOnly: parsed.data.readOnly ?? previous.readOnly,
    enabled: parsed.data.enabled ?? previous.enabled,
    updatedAt: new Date().toISOString(),
  };
  if (parsed.data.password) Object.assign(updated, await hashPassword(parsed.data.password));
  const client = clientFor(server);
  await client.syncSftpAccount(updated);
  try {
    await store.update((draft) => {
      const index = draft.sftpAccounts.findIndex((account) => account.id === previous.id);
      if (index >= 0) draft.sftpAccounts[index] = updated;
      draft.auditLogs.unshift(audit(currentUser(request)?.id, 'sftp.account_update', 'server', server.id, { accountId: updated.id, username: updated.username, paths: updated.paths, readOnly: updated.readOnly, enabled: updated.enabled, passwordChanged: Boolean(parsed.data.password) }));
    });
  } catch (error) {
    await client.syncSftpAccount(previous).catch(() => undefined);
    throw error;
  }
  return safeSftpAccount(updated);
});

app.delete('/api/servers/:id/sftp/accounts/:accountId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'sftp.manage'); if (!server) return;
  const accountId = (request.params as { accountId: string }).accountId;
  const account = store.snapshot.sftpAccounts.find((item) => item.id === accountId && item.serverId === server.id);
  if (!account) return reply.code(404).send({ error: 'Compte SFTP introuvable.' });
  const client = clientFor(server);
  await client.deleteSftpAccount(account.id);
  try {
    await store.update((draft) => {
      draft.sftpAccounts = draft.sftpAccounts.filter((item) => item.id !== account.id);
      draft.auditLogs.unshift(audit(currentUser(request)?.id, 'sftp.account_delete', 'server', server.id, { accountId: account.id, username: account.username }));
    });
  } catch (error) {
    await client.syncSftpAccount(account).catch(() => undefined);
    throw error;
  }
  return { ok: true };
});

app.get('/api/servers/:id/content/search', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'content.manage'); if (!server) return;
  const parsed = z.object({ kind: z.enum(['plugin', 'mod', 'modpack']), query: z.string().trim().max(80).default('') }).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: 'Recherche invalide.' });
  const minecraftVersion = await runtimeVersion(server);
  const configured = curseForgeConfigured();
  return { provider: 'curseforge', configured, minecraftVersion, kinds: allowedKinds(server), projects: configured ? await searchCurseForge(server, parsed.data.kind, parsed.data.query, minecraftVersion) : [] };
});

app.get('/api/servers/:id/content/installed', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'content.manage'); if (!server) return;
  const kind = z.enum(['plugin', 'mod']).safeParse((request.query as { kind?: string }).kind);
  if (!kind.success) return reply.code(400).send({ error: 'Type de contenu invalide.' });
  return clientFor(server).installedContent(server, kind.data);
});

app.post('/api/servers/:id/content/install', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'content.manage'); if (!server) return;
  const parsed = z.object({ kind: z.enum(['plugin', 'mod', 'modpack']), projectId: z.number().int().positive(), slug: z.string().max(100).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Projet CurseForge invalide.' });
  if (parsed.data.kind === 'modpack' && (await statusFor(server)) !== 'stopped') return reply.code(409).send({ error: 'Arrêtez le serveur avant d’installer un modpack.' });
  const client = clientFor(server);
  const minecraftVersion = await runtimeVersion(server);
  if (parsed.data.kind === 'modpack') {
    if (!parsed.data.slug) return reply.code(400).send({ error: 'Slug CurseForge manquant.' });
    const job = await enqueueJob(makeJob('content.modpack', currentUser(request)?.id, server.id, server.nodeId, { projectId: parsed.data.projectId, slug: parsed.data.slug }));
    void runJob(job.id); return reply.code(202).send({ installed: [], restartRequired: false, startRequired: true, job: publicJob(job), message: 'Installation du server pack lancée en arrière-plan.' });
  }
  const resolved = await resolveCurseForgeFiles(server, parsed.data.kind, parsed.data.projectId, minecraftVersion);
  const installed = [];
  for (const file of resolved) installed.push(await client.installContent(server, { kind: parsed.data.kind, url: file.url, filename: file.filename, hash: file.hash, algorithm: file.algorithm }));
  await recordAudit(currentUser(request)?.id, 'content.install', 'server', server.id, { provider: 'curseforge', kind: parsed.data.kind, projectId: parsed.data.projectId, minecraftVersion, files: resolved.map((file) => file.filename) });
  return reply.code(201).send({ installed, restartRequired: (await statusFor(server)) === 'running', startRequired: false });
});

app.delete('/api/servers/:id/content/installed', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'content.manage'); if (!server) return;
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
  const backups = await clientFor(server).backups(server);
  const owner = store.snapshot.users.find((item) => item.id === server.ownerId);
  if (owner && owner.quota.maxBackups >= 0 && backups.length >= owner.quota.maxBackups) return reply.code(409).send({ error: `Quota de ${owner.quota.maxBackups} sauvegarde(s) atteint.` });
  const job = await enqueueJob(makeJob('backup.create', currentUser(request)?.id, server.id, server.nodeId, { name: parsed.data.name }));
  void runJob(job.id); return reply.code(202).send(publicJob(job));
});

app.post('/api/servers/:id/backups/:backupId/restore', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  const backupId = (request.params as { backupId: string }).backupId;
  const job = await enqueueJob(makeJob('backup.restore', currentUser(request)?.id, server.id, server.nodeId, { backupId }));
  void runJob(job.id); return reply.code(202).send(publicJob(job));
});

app.delete('/api/servers/:id/backups/:backupId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'backups.manage'); if (!server) return;
  const backupId = (request.params as { backupId: string }).backupId;
  const result = await clientFor(server).deleteBackup(server, backupId);
  await recordAudit(currentUser(request)?.id, 'backup.delete', 'server', server.id, { backupId }); return result;
});

app.put('/api/servers/:id/policies', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  const parsed = z.object({
    crashPolicy: z.object({ enabled: z.boolean(), maxRestarts: z.number().int().min(0).max(20), windowMinutes: z.number().int().min(1).max(1440), cooldownMinutes: z.number().int().min(1).max(10080) }),
    backupPolicy: z.object({ retention: z.number().int().min(0).max(1000), remoteEnabled: z.boolean() }),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Politiques invalides.' });
  if (parsed.data.backupPolicy.remoteEnabled && !(await clientFor(server).health()).backups?.remoteConfigured) return reply.code(409).send({ error: 'Le stockage S3 n’est pas configuré sur le nœud.' });
  if ((await statusFor(server)) !== 'missing') await clientFor(server).updateCrashPolicy(server, parsed.data.crashPolicy);
  await store.update((draft) => { const item = draft.servers.find((entry) => entry.id === server.id); if (item) Object.assign(item, parsed.data); draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.policies_update', 'server', server.id, parsed.data)); });
  return { ok: true };
});

app.post('/api/servers/:id/clone', { preHandler: auth }, async (request, reply) => {
  const source = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!source) return;
  const parsed = z.object({ name: z.string().trim().min(2).max(40), nodeId: z.string().min(1), allocationId: z.string().optional(), port: z.number().int().min(1024).max(65535).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message });
  const node = store.snapshot.nodes.find((item) => item.id === parsed.data.nodeId);
  if (!node) return reply.code(404).send({ error: 'Nœud de destination introuvable.' });
  if (node.maintenance) return reply.code(409).send({ error: node.maintenanceMessage || 'Le nœud de destination est en maintenance.' });
  const owner = store.snapshot.users.find((item) => item.id === source.ownerId)!;
  const quotaError = checkUserQuota(owner, source.memoryMb, source.diskMb); if (quotaError) return reply.code(409).send({ error: quotaError });
  const capacityError = checkNodeCapacity(node.id, source.memoryMb, source.diskMb); if (capacityError) return reply.code(409).send({ error: capacityError });
  const id = randomUUID().slice(0, 8); const actor = currentUser(request)!;
  let created!: { server: MinecraftServer; job: PanelJob };
  try { created = await store.transaction((draft) => {
    const allocation = pickFreeAllocation(draft.allocations, node.id, parsed.data.allocationId, parsed.data.port);
    if (!allocation) throw httpError(409, 'Aucune allocation libre ne correspond à la destination.');
    const server: MinecraftServer = { ...source, id, name: parsed.data.name, nodeId: node.id, allocationId: allocation.id, port: allocation.port, domain: undefined, createdAt: new Date().toISOString() };
    const job = makeJob('server.clone', actor.id, server.id, node.id, { sourceId: source.id }); allocation.serverId = server.id; draft.servers.push(server); draft.jobs.unshift(job);
    draft.auditLogs.unshift(audit(actor.id, 'server.clone_queued', 'server', server.id, { sourceId: source.id, jobId: job.id })); return { server, job };
  }); } catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }); }
  void runJob(created.job.id); return reply.code(202).send({ server: created.server, job: publicJob(created.job) });
});

app.post('/api/servers/:id/transfer', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  const parsed = z.object({ nodeId: z.string().min(1), allocationId: z.string().optional(), port: z.number().int().min(1024).max(65535).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Destination invalide.' });
  if (parsed.data.nodeId === server.nodeId) return reply.code(409).send({ error: 'Choisissez un autre nœud.' });
  const node = store.snapshot.nodes.find((item) => item.id === parsed.data.nodeId);
  if (!node) return reply.code(404).send({ error: 'Nœud de destination introuvable.' });
  if (node.maintenance) return reply.code(409).send({ error: node.maintenanceMessage || 'Le nœud de destination est en maintenance.' });
  if ((await statusFor(server)) !== 'stopped') return reply.code(409).send({ error: 'Arrêtez le serveur avant son transfert.' });
  const capacityError = checkNodeCapacity(node.id, server.memoryMb, server.diskMb); if (capacityError) return reply.code(409).send({ error: capacityError });
  const actor = currentUser(request)!; const job = makeJob('server.transfer', actor.id, server.id, node.id, {});
  try { await store.transaction((draft) => { const allocation = pickFreeAllocation(draft.allocations, node.id, parsed.data.allocationId, parsed.data.port); if (!allocation) throw httpError(409, 'Aucune allocation libre ne correspond à la destination.'); allocation.reservationId = job.id; job.payload = { allocationId: allocation.id }; draft.jobs.unshift(job); draft.auditLogs.unshift(audit(actor.id, 'server.transfer_queued', 'server', server.id, { nodeId: node.id, allocationId: allocation.id, jobId: job.id })); }); }
  catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }); }
  void runJob(job.id); return reply.code(202).send(publicJob(job));
});

app.post('/api/servers/:id/upgrade', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'settings.manage'); if (!server) return;
  const parsed = z.object({ software: z.enum(['PAPER', 'VANILLA', 'PURPUR', 'FABRIC', 'FORGE', 'NEOFORGE']), version: z.string().trim().min(1).max(30) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Version ou logiciel invalide.' });
  if ((await statusFor(server)) !== 'stopped') return reply.code(409).send({ error: 'Arrêtez le serveur avant sa mise à niveau.' });
  if (parsed.data.software === server.software && parsed.data.version === server.version) return reply.code(409).send({ error: 'Le serveur utilise déjà cette configuration.' });
  const job = await enqueueJob(makeJob('server.upgrade', currentUser(request)?.id, server.id, server.nodeId, parsed.data)); void runJob(job.id);
  return reply.code(202).send(publicJob(job));
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
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'members.manage'); if (!server) return;
  return store.snapshot.serverAccess.filter((item) => item.serverId === server.id).map((item) => ({ ...item, user: safeUser(store.snapshot.users.find((user) => user.id === item.userId)!) }));
});

app.put('/api/servers/:id/members/:userId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'members.manage'); if (!server) return;
  const userId = (request.params as { userId: string }).userId;
  if (!store.snapshot.users.some((user) => user.id === userId)) return reply.code(404).send({ error: 'Utilisateur introuvable.' });
  if (userId === server.ownerId) return reply.code(400).send({ error: 'Le propriétaire possède déjà tous les droits.' });
  const parsed = z.object({ permissions: z.array(z.enum(serverPermissionValues)).min(1).max(serverPermissionValues.length).transform((items) => [...new Set(items)]) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Permissions invalides.' });
  const actor = currentUser(request)!;
  const actorIsOwner = server.ownerId === actor.id || hasPanelPermission(actor, 'servers.manage_all');
  if (!actorIsOwner && parsed.data.permissions.some((permission) => !effectiveServerPermissions(actor, server).includes(permission))) {
    return reply.code(403).send({ error: 'Vous ne pouvez attribuer que des droits que vous possédez sur ce serveur.' });
  }
  await store.update((draft) => {
    draft.serverAccess = draft.serverAccess.filter((item) => item.serverId !== server.id || item.userId !== userId);
    draft.serverAccess.push({ serverId: server.id, userId, permissions: parsed.data.permissions });
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.member_update', 'server', server.id, { userId, permissions: parsed.data.permissions }));
  });
  return { ok: true };
});

app.delete('/api/servers/:id/members/:userId', { preHandler: auth }, async (request, reply) => {
  const server = authorizedServer(request, reply, (request.params as { id: string }).id, 'members.manage'); if (!server) return;
  const userId = (request.params as { userId: string }).userId;
  const existing = store.snapshot.serverAccess.some((item) => item.serverId === server.id && item.userId === userId);
  if (!existing) return reply.code(404).send({ error: 'Accès partagé introuvable.' });
  await store.update((draft) => {
    draft.serverAccess = draft.serverAccess.filter((item) => item.serverId !== server.id || item.userId !== userId);
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.member_remove', 'server', server.id, { userId }));
  });
  return { ok: true };
});

app.post('/api/servers/:id/:action', { preHandler: auth }, async (request, reply) => {
  const params = request.params as { id: string; action: string };
  if (params.action === 'repair') {
    const server = authorizedServer(request, reply, params.id, 'settings.manage'); if (!server) return;
    const job = await enqueueJob(makeJob('server.repair', currentUser(request)?.id, server.id, server.nodeId)); void runJob(job.id);
    return reply.code(202).send(publicJob(job));
  }
  if (params.action === 'kill') {
    const server = authorizedServer(request, reply, params.id, 'power.stop'); if (!server) return;
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
  const server = authorizedServer(request, reply, id, 'server.delete'); if (!server) return;
  const client = clientFor(server);
  await client.deleteServerSftpAccounts(server);
  await client.remove(server);
  await store.update((draft) => {
    draft.servers = draft.servers.filter((item) => item.id !== id);
    draft.serverAccess = draft.serverAccess.filter((item) => item.serverId !== id);
    draft.schedules = draft.schedules.filter((item) => item.serverId !== id);
    draft.sftpAccounts = draft.sftpAccounts.filter((item) => item.serverId !== id);
    const serverJobIds = new Set(draft.jobs.filter((item) => item.serverId === id).map((item) => item.id));
    for (const allocation of draft.allocations) if (allocation.reservationId && serverJobIds.has(allocation.reservationId)) allocation.reservationId = undefined;
    draft.jobs = draft.jobs.filter((item) => item.serverId !== id || item.status === 'running');
    draft.metrics = draft.metrics.filter((item) => item.serverId !== id);
    draft.crashEvents = draft.crashEvents.filter((item) => item.serverId !== id);
    const allocation = draft.allocations.find((item) => item.serverId === id); if (allocation) allocation.serverId = undefined;
    draft.auditLogs.unshift(audit(currentUser(request)?.id, 'server.delete', 'server', id));
  });
  await gateway.sync(store.snapshot);
  return { ok: true };
});

app.get('/api/jobs', { preHandler: auth }, async (request) => {
  const user = currentUser(request)!; const visible = new Set(visibleServers(user).map((server) => server.id));
  return store.snapshot.jobs.filter((job) => user.role === 'admin' || job.userId === user.id || (job.serverId && visible.has(job.serverId))).slice(0, 250).map(publicJob);
});

app.post('/api/jobs/:id/retry', { preHandler: auth }, async (request, reply) => {
  const id = (request.params as { id: string }).id; const user = currentUser(request)!; const job = store.snapshot.jobs.find((item) => item.id === id);
  if (!job) return reply.code(404).send({ error: 'Opération introuvable.' });
  if (!canViewJob(user, job)) return reply.code(403).send({ error: 'Accès refusé.' });
  if (job.status !== 'failed') return reply.code(409).send({ error: 'Seule une opération échouée peut être relancée.' });
  await store.update((draft) => { const item = draft.jobs.find((entry) => entry.id === id)!; item.status = 'queued'; item.error = undefined; item.progress = 0; item.step = 'Nouvelle tentative demandée'; item.attempts = 0; item.finishedAt = undefined; item.updatedAt = new Date().toISOString(); });
  void runJob(id); return publicJob(store.snapshot.jobs.find((item) => item.id === id)!);
});

app.delete('/api/jobs/:id', { preHandler: auth }, async (request, reply) => {
  const id = (request.params as { id: string }).id; const user = currentUser(request)!; const job = store.snapshot.jobs.find((item) => item.id === id);
  if (!job) return reply.code(404).send({ error: 'Opération introuvable.' });
  if (!canViewJob(user, job)) return reply.code(403).send({ error: 'Accès refusé.' });
  if (job.status === 'running') return reply.code(409).send({ error: 'Cette opération est déjà en cours et ne peut plus être annulée sans risque.' });
  if (job.status !== 'queued') return reply.code(409).send({ error: 'Cette opération est déjà terminée.' });
  await store.update((draft) => { const item = draft.jobs.find((entry) => entry.id === id)!; item.status = 'cancelled'; item.step = 'Annulée'; item.finishedAt = item.updatedAt = new Date().toISOString(); for (const allocation of draft.allocations) if (allocation.reservationId === id) allocation.reservationId = undefined; });
  return { ok: true };
});

app.get('/api/notifications', { preHandler: auth }, async (request) => {
  const user = currentUser(request)!; return store.snapshot.notifications.filter((item) => !item.userId || item.userId === user.id).slice(0, 100);
});

app.put('/api/notifications/:id/read', { preHandler: auth }, async (request, reply) => {
  const id = (request.params as { id: string }).id; const user = currentUser(request)!; const item = store.snapshot.notifications.find((entry) => entry.id === id && (!entry.userId || entry.userId === user.id));
  if (!item) return reply.code(404).send({ error: 'Notification introuvable.' });
  await store.update((draft) => { const notification = draft.notifications.find((entry) => entry.id === id); if (notification) notification.readAt = new Date().toISOString(); }); return { ok: true };
});

app.post('/api/notifications/read-all', { preHandler: auth }, async (request) => {
  const user = currentUser(request)!; await store.update((draft) => { for (const item of draft.notifications) if (!item.userId || item.userId === user.id) item.readAt ??= new Date().toISOString(); }); return { ok: true };
});

app.post('/api/notifications/test', { preHandler: [auth, requireAdministrator] }, async (request) => {
  await createNotification({ level: 'info', title: 'Test Padock', message: 'Les notifications et le webhook sont correctement configurés.' });
  return { ok: true };
});

app.get('/api/audit', { preHandler: [auth, requirePanelPermission('audit.view')] }, async () => store.snapshot.auditLogs.slice(0, 250).map((entry) => {
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
    const payload = await app.jwt.verify<{ sub: string; sid?: string }>(decodeURIComponent(token));
    if (payload.sid && !store.snapshot.sessions.some((item) => item.id === payload.sid && item.userId === payload.sub && !item.revokedAt && new Date(item.expiresAt).getTime() > Date.now())) throw new Error('revoked session');
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
setInterval(() => { void runQueuedJobs(); }, 2_000).unref();
setInterval(() => { void collectMetrics(); }, 60_000).unref();
setInterval(() => { void monitorCrashes(); }, 30_000).unref();
setInterval(() => { void cleanupOperationalData(); }, 60 * 60_000).unref();
void runDueSchedules();
void runQueuedJobs();
void collectMetrics();
void monitorCrashes();

function currentUser(request: FastifyRequest) { return store.snapshot.users.find((user) => user.id === (request.user as { sub?: string } | undefined)?.sub); }
function safeUser(user: UserRecord) {
  const customRole = user.roleId ? store.snapshot.roles.find((role) => role.id === user.roleId) : undefined;
  return {
    id: user.id, username: user.username, email: user.email, role: user.role, roleId: customRole?.id,
    customRole: customRole ? { id: customRole.id, name: customRole.name } : undefined,
    groupIds: user.groupIds, groups: store.snapshot.groups.filter((group) => user.groupIds.includes(group.id)).map((group) => ({ id: group.id, name: group.name })),
    permissions: effectivePanelPermissions(user), directPermissions: user.permissions, quota: user.quota,
    twoFactorEnabled: user.twoFactorEnabled, recoveryCodesRemaining: user.recoveryCodeHashes.length, emailVerified: user.emailVerified, createdAt: user.createdAt,
  };
}
function safePanelRole(role: PanelRole) { return { ...role, memberCount: store.snapshot.users.filter((user) => user.roleId === role.id).length }; }
function safeGroup(group: UserGroup) { return { ...group, memberCount: store.snapshot.users.filter((user) => user.groupIds.includes(group.id)).length }; }
function safeSftpAccount(account: SftpAccount) { return { id: account.id, serverId: account.serverId, username: account.username, paths: account.paths, readOnly: account.readOnly, enabled: account.enabled, createdAt: account.createdAt, updatedAt: account.updatedAt }; }
async function setSession(request: FastifyRequest, reply: FastifyReply, user: UserRecord) {
  const now = new Date(); const session = { id: randomUUID(), userId: user.id, ip: request.ip, userAgent: request.headers['user-agent']?.slice(0, 300), createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt: new Date(now.getTime() + 12 * 3600_000).toISOString() };
  await store.update((draft) => { draft.sessions.unshift(session); draft.sessions = draft.sessions.slice(0, 5000); });
  reply.setCookie('padock_session', app.jwt.sign({ sub: user.id, sid: session.id }, { expiresIn: '12h' }), sessionCookie());
}
function findServer(id: string) { return store.snapshot.servers.find((server) => server.id === id); }
function effectivePanelPermissions(user: UserRecord) {
  const inherited = user.roleId ? store.snapshot.roles.find((role) => role.id === user.roleId)?.permissions ?? [] : [];
  const grouped = store.snapshot.groups.filter((group) => user.groupIds.includes(group.id)).flatMap((group) => group.permissions);
  return [...new Set([...inherited, ...grouped, ...user.permissions])] as PanelPermission[];
}
function hasPanelPermission(user: UserRecord | undefined, permission: PanelPermission) { return Boolean(user && (user.role === 'admin' || effectivePanelPermissions(user).includes(permission))); }
function hasAnyPanelPermission(user: UserRecord, permissions: PanelPermission[]) { return user.role === 'admin' || permissions.some((permission) => effectivePanelPermissions(user).includes(permission)); }
function validatePermissionAssignment(actor: UserRecord, role: UserRecord['role'], permissions: PanelPermission[], roleId?: string) {
  if (role === 'admin' && roleId) return 'Un administrateur ne peut pas recevoir de rôle personnalisé.';
  const customRole = roleId ? store.snapshot.roles.find((item) => item.id === roleId) : undefined;
  if (roleId && !customRole) return 'Le rôle personnalisé sélectionné n’existe pas.';
  if (actor.role === 'admin') return undefined;
  if (role === 'admin') return 'Seul un administrateur peut attribuer le rôle administrateur.';
  const assignedPermissions = [...new Set([...permissions, ...(customRole?.permissions ?? [])])];
  const actorPermissions = effectivePanelPermissions(actor);
  if (assignedPermissions.some((permission) => !actorPermissions.includes(permission))) return 'Vous ne pouvez attribuer que des permissions que vous possédez.';
  return undefined;
}
function isReservedRoleName(name: string) { return ['admin', 'administrateur', 'user', 'utilisateur'].includes(name.trim().toLocaleLowerCase()); }
function visibleServers(user: UserRecord) { return hasPanelPermission(user, 'servers.manage_all') ? store.snapshot.servers : store.snapshot.servers.filter((server) => server.ownerId === user.id || store.snapshot.serverAccess.some((item) => item.serverId === server.id && item.userId === user.id)); }
function effectiveServerPermissions(user: UserRecord, server: MinecraftServer): ServerPermission[] {
  if (hasPanelPermission(user, 'servers.manage_all') || server.ownerId === user.id) return [...serverPermissionValues];
  const direct = store.snapshot.serverAccess.find((item) => item.serverId === server.id && item.userId === user.id)?.permissions;
  if (!direct) return [];
  const grouped = store.snapshot.groups.filter((group) => user.groupIds.includes(group.id)).flatMap((group) => group.serverPermissions);
  return [...new Set([...direct, ...grouped])] as ServerPermission[];
}
function hasPermission(user: UserRecord, server: MinecraftServer, permission?: ServerPermission) { return hasPanelPermission(user, 'servers.manage_all') || server.ownerId === user.id || Boolean(permission && effectiveServerPermissions(user, server).includes(permission)); }
function authorizedServer(request: FastifyRequest, reply: FastifyReply, id: string, permission?: ServerPermission) { const server = findServer(id); if (!server) { reply.code(404).send({ error: 'Serveur introuvable.' }); return; } if (!hasPermission(currentUser(request)!, server, permission)) { reply.code(403).send({ error: 'Permission insuffisante.' }); return; } return server; }
function clientFor(server: MinecraftServer) { const node = store.snapshot.nodes.find((item) => item.id === server.nodeId); if (!node) throw new Error('Le nœud associé à ce serveur n’existe plus.'); return new NodeClient(node); }
function serverAddress(server: MinecraftServer) { if (server.domain) return server.domain; const allocation = store.snapshot.allocations.find((item) => item.id === server.allocationId); const hostname = allocation?.alias || (allocation?.ip && allocation.ip !== '0.0.0.0' ? allocation.ip : new URL(publicUrl).hostname); return `${hostname}:${server.port}`; }
async function runtimeStateFor(server: MinecraftServer) { try { return await clientFor(server).state(server); } catch (error) { return { status: 'unavailable' as const, error: (error as Error).message }; } }
async function statusFor(server: MinecraftServer) { return (await runtimeStateFor(server)).status; }
async function runtimeVersion(server: MinecraftServer) {
  try { const detected = (await clientFor(server).runtime(server)).minecraftVersion; if (detected) return detected; } catch { /* Le serveur n'a pas encore produit ses fichiers. */ }
  return server.version.toUpperCase() === 'LATEST' ? undefined : server.version;
}
async function validateSftpPaths(server: MinecraftServer, values: string[]) {
  const normalized = [...new Set(values.map(normalizeSftpPath))];
  if (normalized.includes('.')) return ['.'];
  const paths = normalized.sort((left, right) => left.split('/').length - right.split('/').length)
    .filter((candidate, index, all) => !all.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)));
  for (const item of paths) {
    try { await clientFor(server).files(server, item); }
    catch { throw new Error(`Le dossier « ${item} » n’existe pas ou n’est pas accessible.`); }
  }
  return paths;
}
function normalizeSftpPath(value: string) {
  if (value.includes('\0')) throw new Error('Chemin SFTP invalide.');
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '.';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.includes('.') || parts.includes('..')) throw new Error('Les chemins relatifs « . » et « .. » ne sont pas autorisés.');
  return parts.join('/');
}
function nodeAllocations(nodeId: string) { return store.snapshot.allocations.filter((item) => item.nodeId === nodeId && (!gateway.enabled || item.port !== gateway.publicPort)); }
function availableAllocations(nodeId: string) { return nodeAllocations(nodeId).filter((item) => !item.serverId && !item.reservationId).sort((left, right) => left.port - right.port || left.ip.localeCompare(right.ip)); }
function allocationStats(nodeId: string) { const items = nodeAllocations(nodeId); return { total: items.length, used: items.filter((item) => item.serverId).length, reserved: items.filter((item) => item.reservationId).length, free: items.filter((item) => !item.serverId && !item.reservationId).length }; }
function selectAllocation(nodeId: string, allocationId?: string, port?: number) { const items = availableAllocations(nodeId); return allocationId ? items.find((item) => item.id === allocationId) : port ? items.find((item) => item.port === port) : items[0]; }
function pickFreeAllocation(allocations: Allocation[], nodeId: string, allocationId?: string, port?: number) { const items = allocations.filter((item) => item.nodeId === nodeId && !item.serverId && !item.reservationId && (!gateway.enabled || item.port !== gateway.publicPort)).sort((a, b) => a.port - b.port); return allocationId ? items.find((item) => item.id === allocationId) : port ? items.find((item) => item.port === port) : items[0]; }
function nodeCapacity(nodeId: string) { const node = store.snapshot.nodes.find((item) => item.id === nodeId); const servers = store.snapshot.servers.filter((item) => item.nodeId === nodeId); const memoryMb = servers.reduce((total, item) => total + item.memoryMb, 0); const diskMb = servers.reduce((total, item) => total + item.diskMb, 0); return { memoryMb, diskMb, maxMemoryMb: node?.maxMemoryMb, maxDiskMb: node?.maxDiskMb, serverCount: servers.length }; }
function checkNodeCapacity(nodeId: string, memoryMb: number, diskMb: number) { const value = nodeCapacity(nodeId); if (value.maxMemoryMb && value.memoryMb + memoryMb > value.maxMemoryMb) return `Capacité RAM du nœud dépassée (${value.memoryMb + memoryMb}/${value.maxMemoryMb} Mo).`; if (value.maxDiskMb && value.diskMb + diskMb > value.maxDiskMb) return `Capacité disque du nœud dépassée (${value.diskMb + diskMb}/${value.maxDiskMb} Mo).`; return undefined; }
function checkUserQuota(user: UserRecord, memoryMb: number, diskMb: number) { if (user.role === 'admin') return undefined; const servers = store.snapshot.servers.filter((item) => item.ownerId === user.id); if (user.quota.maxServers >= 0 && servers.length + 1 > user.quota.maxServers) return `Quota de ${user.quota.maxServers} serveur(s) atteint.`; if (user.quota.maxMemoryMb >= 0 && servers.reduce((total, item) => total + item.memoryMb, 0) + memoryMb > user.quota.maxMemoryMb) return `Quota RAM utilisateur dépassé (${user.quota.maxMemoryMb} Mo).`; if (user.quota.maxDiskMb >= 0 && servers.reduce((total, item) => total + item.diskMb, 0) + diskMb > user.quota.maxDiskMb) return `Quota disque utilisateur dépassé (${user.quota.maxDiskMb} Mo).`; return undefined; }
function checkResourceUpdate(server: MinecraftServer, memoryMb: number, diskMb: number) { const node = store.snapshot.nodes.find((item) => item.id === server.nodeId); const nodeOthers = store.snapshot.servers.filter((item) => item.nodeId === server.nodeId && item.id !== server.id); if (node?.maxMemoryMb && nodeOthers.reduce((total, item) => total + item.memoryMb, 0) + memoryMb > node.maxMemoryMb) return `Capacité RAM du nœud dépassée (${node.maxMemoryMb} Mo).`; if (node?.maxDiskMb && nodeOthers.reduce((total, item) => total + item.diskMb, 0) + diskMb > node.maxDiskMb) return `Capacité disque du nœud dépassée (${node.maxDiskMb} Mo).`; const owner = store.snapshot.users.find((item) => item.id === server.ownerId); if (!owner || owner.role === 'admin') return undefined; const others = store.snapshot.servers.filter((item) => item.ownerId === owner.id && item.id !== server.id); if (owner.quota.maxMemoryMb >= 0 && others.reduce((total, item) => total + item.memoryMb, 0) + memoryMb > owner.quota.maxMemoryMb) return `Quota RAM utilisateur dépassé (${owner.quota.maxMemoryMb} Mo).`; if (owner.quota.maxDiskMb >= 0 && others.reduce((total, item) => total + item.diskMb, 0) + diskMb > owner.quota.maxDiskMb) return `Quota disque utilisateur dépassé (${owner.quota.maxDiskMb} Mo).`; return undefined; }
function unlimitedQuota() { return { maxServers: -1, maxMemoryMb: -1, maxDiskMb: -1, maxBackups: -1 }; }
function defaultCrashPolicy() { return { enabled: true, maxRestarts: 3, windowMinutes: 10, cooldownMinutes: 30 }; }
function defaultBackupPolicy() { return { retention: 5, remoteEnabled: false }; }
function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
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
  if (!await store.tryBecomeLeader()) return;
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
    else if (schedule.action === 'backup') { await client.createBackup(server, schedule.name); await client.pruneBackups(server, server.backupPolicy.retention); }
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

function makeJob(kind: JobKind, userId?: string, serverId?: string, nodeId?: string, payload: Record<string, unknown> = {}): PanelJob {
  const now = new Date().toISOString();
  return { id: randomUUID().slice(0, 8), kind, status: 'queued', progress: 0, step: 'En attente', payload, attempts: 0, maxAttempts: kind === 'server.create' ? 2 : 1, userId, serverId, nodeId, createdAt: now, updatedAt: now };
}

async function enqueueJob(job: PanelJob) { await store.update((draft) => { draft.jobs.unshift(job); draft.jobs = draft.jobs.slice(0, 1000); }); return job; }
function publicJob(job: PanelJob) { return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, step: job.step, result: job.result, error: job.error, attempts: job.attempts, maxAttempts: job.maxAttempts, userId: job.userId, serverId: job.serverId, nodeId: job.nodeId, createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt }; }
function latestServerJob(serverId: string) { return store.snapshot.jobs.filter((item) => item.serverId === serverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
function canViewJob(user: UserRecord, job: PanelJob) { return user.role === 'admin' || job.userId === user.id || Boolean(job.serverId && visibleServers(user).some((server) => server.id === job.serverId)); }

async function runQueuedJobs() {
  if (!await store.tryBecomeLeader()) return;
  for (const job of store.snapshot.jobs.filter((item) => item.status === 'queued').slice(0, 4)) void runJob(job.id);
}

async function runJob(id: string) {
  if (!await store.tryBecomeLeader()) return;
  if (runningJobs.has(id)) return;
  const initial = store.snapshot.jobs.find((item) => item.id === id); if (!initial || initial.status !== 'queued') return;
  runningJobs.add(id);
  await store.update((draft) => { const job = draft.jobs.find((item) => item.id === id); if (job?.status === 'queued') { job.status = 'running'; job.attempts++; job.progress = Math.max(1, job.progress); job.step = job.attempts > 1 ? `Nouvelle tentative ${job.attempts}/${job.maxAttempts}` : 'Démarrage'; job.startedAt ??= new Date().toISOString(); job.updatedAt = new Date().toISOString(); } });
  try {
    const result = await executePanelJob(id);
    await store.update((draft) => { const job = draft.jobs.find((item) => item.id === id); if (job) { job.status = 'completed'; job.progress = 100; job.step = 'Terminé'; job.result = result; job.error = undefined; job.finishedAt = job.updatedAt = new Date().toISOString(); } });
    const job = store.snapshot.jobs.find((item) => item.id === id)!;
    await createNotification({ userId: job.userId, level: 'success', title: jobTitle(job.kind), message: 'L’opération s’est terminée correctement.', link: job.serverId ? `server:${job.serverId}` : undefined });
    emitJob(job);
  } catch (error) {
    const message = (error as Error).message; let retry = false;
    await store.update((draft) => {
      const job = draft.jobs.find((item) => item.id === id); if (!job) return;
      retry = job.attempts < job.maxAttempts; job.status = retry ? 'queued' : 'failed'; job.step = retry ? 'Nouvelle tentative planifiée' : 'Échec'; job.error = message; job.updatedAt = new Date().toISOString(); if (!retry) job.finishedAt = job.updatedAt;
      if (!retry) for (const allocation of draft.allocations) if (allocation.reservationId === job.id) allocation.reservationId = undefined;
      draft.auditLogs.unshift(audit(job.userId, `${job.kind}.${retry ? 'retry' : 'failed'}`, job.serverId ? 'server' : 'job', job.serverId ?? job.id, { jobId: job.id, error: message }));
    });
    const job = store.snapshot.jobs.find((item) => item.id === id)!; emitJob(job);
    if (!retry) await createNotification({ userId: job.userId, level: 'error', title: `${jobTitle(job.kind)} : échec`, message, link: job.serverId ? `server:${job.serverId}` : undefined });
  } finally { runningJobs.delete(id); }
}

async function executePanelJob(id: string): Promise<Record<string, unknown>> {
  const job = store.snapshot.jobs.find((item) => item.id === id); if (!job) throw new Error('Opération introuvable.');
  const server = job.serverId ? findServer(job.serverId) : undefined;
  if (!server) throw new Error('Serveur introuvable.');
  if (job.kind === 'server.create') {
    const node = store.snapshot.nodes.find((item) => item.id === server.nodeId); if (!node) throw new Error('Nœud introuvable.');
    await updateJob(id, 10, 'Préparation de l’installation');
    const modpackInput = job.payload.modpack as { projectId: number; slug: string } | undefined;
    const pack = modpackInput ? await resolveCurseForgeModpack(server, modpackInput.projectId, modpackInput.slug, server.version.toUpperCase() === 'LATEST' ? undefined : server.version) : undefined;
    if (pack && pack.minecraftVersion !== server.version) await store.update((draft) => { const item = draft.servers.find((entry) => entry.id === server.id); if (item) item.version = pack.minecraftVersion; });
    const current = await new NodeClient(node).state(server).catch(() => ({ status: 'missing' as const }));
    await updateJob(id, 45, pack ? `Installation du server pack ${pack.filename}` : 'Création du conteneur Minecraft');
    if (current.status === 'missing') await new NodeClient(node).create(findServer(server.id)!, pack);
    await new NodeClient(node).updateCrashPolicy(server, server.crashPolicy);
    await updateJob(id, 90, 'Synchronisation de la passerelle'); await gateway.sync(store.snapshot);
    await recordAudit(job.userId, 'server.create', 'server', server.id, { nodeId: node.id, jobId: job.id, serverPack: pack?.filename });
    return { serverId: server.id, serverPack: pack?.filename };
  }
  if (job.kind === 'backup.create') {
    await updateJob(id, 15, 'Sauvegarde et compression des fichiers');
    const backup = await clientFor(server).createBackup(server, typeof job.payload.name === 'string' ? job.payload.name : undefined);
    await updateJob(id, 85, 'Application de la politique de rétention');
    await clientFor(server).pruneBackups(server, server.backupPolicy.retention);
    await recordAudit(job.userId, 'backup.create', 'server', server.id, { backupId: backup.id, checksum: (backup as { checksum?: string }).checksum }); return backup;
  }
  if (job.kind === 'backup.restore') {
    const backupId = String(job.payload.backupId ?? ''); await updateJob(id, 10, 'Création du point de retour');
    await clientFor(server).restoreBackup(server, backupId); await recordAudit(job.userId, 'backup.restore', 'server', server.id, { backupId }); return { backupId };
  }
  if (job.kind === 'server.repair') {
    await updateJob(id, 20, 'Reconstruction du conteneur'); await clientFor(server).repair(server); await recordAudit(job.userId, 'server.repair', 'server', server.id, { jobId: id }); return { serverId: server.id };
  }
  if (job.kind === 'server.upgrade') {
    const input = job.payload as { software: MinecraftServer['software']; version: string }; const original = { software: server.software, version: server.version };
    await updateJob(id, 10, 'Sauvegarde avant mise à niveau'); const backup = await clientFor(server).createBackup(server, `pre-upgrade-${input.version}`);
    await updateJob(id, 45, `Passage vers ${input.software} ${input.version}`);
    const upgraded = { ...server, ...input };
    try {
      await clientFor(server).repair(upgraded);
      await store.update((draft) => { const item = draft.servers.find((entry) => entry.id === server.id); if (item) Object.assign(item, input); });
    } catch (error) {
      await clientFor(server).repair(server).catch(() => undefined); await clientFor(server).restoreBackup(server, backup.id).catch(() => undefined); throw error;
    }
    await recordAudit(job.userId, 'server.upgrade', 'server', server.id, { from: original, to: input, rollbackBackup: backup.id }); return { ...input, rollbackBackup: backup.id };
  }
  if (job.kind === 'content.modpack') {
    const input = job.payload as { projectId: number; slug: string };
    await updateJob(id, 5, 'Sauvegarde avant mise à jour'); await clientFor(server).createBackup(server, `pre-curseforge-${input.slug}`);
    await updateJob(id, 20, 'Résolution du server pack CurseForge'); const pack = await resolveCurseForgeModpack(server, input.projectId, input.slug, server.version.toUpperCase() === 'LATEST' ? undefined : server.version);
    await updateJob(id, 40, `Installation de ${pack.filename}`); await clientFor(server).configureCurseForgeModpack(server, pack);
    await store.update((draft) => { const item = draft.servers.find((entry) => entry.id === server.id); if (item) item.version = pack.minecraftVersion; });
    await recordAudit(job.userId, 'content.modpack_configure', 'server', server.id, { projectId: pack.projectId, fileId: pack.fileId }); return { filename: pack.filename };
  }
  if (job.kind === 'server.clone') {
    const source = findServer(String(job.payload.sourceId ?? '')); if (!source) throw new Error('Serveur source introuvable.');
    const destinationClient = clientFor(server); await updateJob(id, 10, 'Création du serveur de destination');
    if ((await destinationClient.state(server).catch(() => ({ status: 'missing' as const }))).status === 'missing') await destinationClient.create(server);
    await destinationClient.updateCrashPolicy(server, server.crashPolicy);
    if (source.nodeId === server.nodeId) { await updateJob(id, 45, 'Copie locale des données'); await destinationClient.cloneData(source, server); }
    else {
      await updateJob(id, 30, 'Création de la sauvegarde de transfert'); const backup = await clientFor(source).createBackup(source, `clone-${server.id}`);
      await updateJob(id, 50, 'Transfert chiffré entre les nœuds'); await clientFor(source).transferBackupTo(source, backup.id, destinationClient, server);
      await updateJob(id, 80, 'Restauration sur le nœud de destination'); await destinationClient.restoreBackup(server, backup.id);
    }
    await recordAudit(job.userId, 'server.clone', 'server', server.id, { sourceId: source.id, nodeId: server.nodeId }); return { serverId: server.id, sourceId: source.id };
  }
  if (job.kind === 'server.transfer') {
    const allocation = store.snapshot.allocations.find((item) => item.id === String(job.payload.allocationId ?? '') && item.reservationId === job.id); if (!allocation) throw new Error('Allocation de destination perdue.');
    const targetNode = store.snapshot.nodes.find((item) => item.id === job.nodeId); if (!targetNode) throw new Error('Nœud de destination introuvable.');
    const sourceClient = clientFor(server); const targetClient = new NodeClient(targetNode); const targetServer = { ...server, nodeId: targetNode.id, allocationId: allocation.id, port: allocation.port };
    await updateJob(id, 10, 'Création de la sauvegarde de migration'); const backup = await sourceClient.createBackup(server, `transfer-${targetNode.id}`);
    await updateJob(id, 30, 'Préparation du conteneur de destination'); if ((await targetClient.state(targetServer).catch(() => ({ status: 'missing' as const }))).status === 'missing') await targetClient.create(targetServer); await targetClient.updateCrashPolicy(targetServer, targetServer.crashPolicy);
    await updateJob(id, 50, 'Transfert des données entre les nœuds'); await sourceClient.transferBackupTo(server, backup.id, targetClient, targetServer);
    await updateJob(id, 75, 'Restauration et vérification'); await targetClient.restoreBackup(targetServer, backup.id);
    await store.update((draft) => {
      const item = draft.servers.find((entry) => entry.id === server.id)!; const oldAllocation = draft.allocations.find((entry) => entry.id === item.allocationId); if (oldAllocation) oldAllocation.serverId = undefined;
      const destination = draft.allocations.find((entry) => entry.id === allocation.id)!; destination.reservationId = undefined; destination.serverId = server.id;
      item.nodeId = targetNode.id; item.allocationId = destination.id; item.port = destination.port;
    });
    await gateway.sync(store.snapshot); for (const account of store.snapshot.sftpAccounts.filter((item) => item.serverId === server.id)) await targetClient.syncSftpAccount(account);
    await sourceClient.deleteServerSftpAccounts(server).catch(() => undefined); await sourceClient.remove(server).catch((error) => app.log.warn(error)); await sourceClient.removeData(server).catch((error) => app.log.warn(error));
    await recordAudit(job.userId, 'server.transfer', 'server', server.id, { fromNodeId: server.nodeId, toNodeId: targetNode.id, allocationId: allocation.id }); return { serverId: server.id, nodeId: targetNode.id };
  }
  throw new Error(`Type d’opération non pris en charge : ${job.kind}`);
}

async function updateJob(id: string, progress: number, step: string) {
  await store.update((draft) => { const job = draft.jobs.find((item) => item.id === id); if (job) { job.progress = progress; job.step = step; job.updatedAt = new Date().toISOString(); } });
  const job = store.snapshot.jobs.find((item) => item.id === id); if (job) emitJob(job);
}

function emitJob(job: PanelJob) { for (const socket of io.sockets.sockets.values()) if (!job.userId || socket.data.userId === job.userId || store.snapshot.users.find((item) => item.id === socket.data.userId)?.role === 'admin') socket.emit('job:update', publicJob(job)); }
function jobTitle(kind: JobKind) { return ({ 'server.create': 'Création du serveur', 'server.clone': 'Clonage du serveur', 'server.transfer': 'Transfert du serveur', 'server.repair': 'Réparation du serveur', 'server.upgrade': 'Mise à niveau du serveur', 'backup.create': 'Sauvegarde', 'backup.restore': 'Restauration', 'content.modpack': 'Installation du modpack' } as Record<JobKind, string>)[kind]; }

async function createNotification(input: Omit<PanelNotification, 'id' | 'createdAt'>) {
  const notification: PanelNotification = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...input };
  await store.update((draft) => { draft.notifications.unshift(notification); draft.notifications = draft.notifications.slice(0, 2000); });
  for (const socket of io.sockets.sockets.values()) if (!notification.userId || socket.data.userId === notification.userId) socket.emit('notification:new', notification);
  if (['warning', 'error'].includes(notification.level)) void sendWebhook(notification);
  return notification;
}

async function sendWebhook(notification: PanelNotification) {
  const value = padockEnv('ALERT_WEBHOOK')?.trim(); if (!value) return;
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return; await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Padock', content: `**${notification.title}**\n${notification.message}` }), signal: AbortSignal.timeout(10_000) }); }
  catch (error) { app.log.warn({ error }, 'Impossible d’envoyer le webhook d’alerte.'); }
}

async function collectMetrics() {
  if (!await store.tryBecomeLeader()) return;
  if (collectingMetrics) return; collectingMetrics = true;
  try {
    const samples = (await Promise.all(store.snapshot.servers.map(async (server) => {
      try { const metric = await clientFor(server).metrics(server); return { id: randomUUID().slice(0, 8), serverId: server.id, ...metric, createdAt: new Date().toISOString() }; }
      catch { return { id: randomUUID().slice(0, 8), serverId: server.id, status: 'unavailable' as const, cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes: 0, createdAt: new Date().toISOString() }; }
    }))).filter(Boolean);
    const cutoff = Date.now() - 7 * 86400_000;
    await store.update((draft) => { draft.metrics.push(...samples); draft.metrics = draft.metrics.filter((item) => new Date(item.createdAt).getTime() >= cutoff).slice(-100_000); });
    for (const sample of samples) {
      const server = findServer(sample.serverId); if (!server) continue;
      if (server.diskMb > 0 && sample.diskBytes / (server.diskMb * 1024 * 1024) >= 0.9 && !recentNotification(`disk:${server.id}`, 6 * 3600_000)) await createNotification({ userId: server.ownerId, level: 'warning', title: `${server.name} manque d’espace`, message: `Le stockage utilise ${Math.round(sample.diskBytes / (server.diskMb * 1024 * 1024) * 100)} % du quota.`, link: `server:${server.id}` });
    }
    for (const node of store.snapshot.nodes) {
      try { await new NodeClient(node).health(); }
      catch (error) { if (!recentNotification(`node:${node.id}`, 30 * 60_000)) await createNotification({ level: 'error', title: `Nœud hors ligne : ${node.name}`, message: (error as Error).message, link: `node:${node.id}` }); }
    }
  } finally { collectingMetrics = false; }
}

async function monitorCrashes() {
  if (!await store.tryBecomeLeader()) return;
  if (monitoringCrashes) return; monitoringCrashes = true;
  try {
    for (const server of store.snapshot.servers.filter((item) => item.crashPolicy.enabled)) {
      if (crashRestarting.has(server.id) || latestServerJob(server.id)?.status === 'running') continue;
      let state; try { state = await clientFor(server).state(server); } catch { continue; }
      const previousRestarts = lastRestartCounts.get(server.id) ?? state.restartCount ?? 0; const restartCount = state.restartCount ?? 0; lastRestartCounts.set(server.id, restartCount);
      const crashed = restartCount > previousRestarts || (state.status === 'stopped' && Boolean(state.oomKilled || state.exitCode)); if (!crashed) continue;
      const reason = state.oomKilled ? 'Mémoire épuisée (OOM)' : state.error || `Code de sortie ${state.exitCode ?? 'inconnu'}`; const now = new Date();
      await store.update((draft) => { draft.crashEvents.unshift({ id: randomUUID().slice(0, 8), serverId: server.id, reason, createdAt: now.toISOString() }); draft.crashEvents = draft.crashEvents.filter((item) => new Date(item.createdAt).getTime() >= Date.now() - 7 * 86400_000); });
      const cutoff = Date.now() - server.crashPolicy.windowMinutes * 60_000; const crashes = store.snapshot.crashEvents.filter((item) => item.serverId === server.id && new Date(item.createdAt).getTime() >= cutoff).length;
      if (crashes > server.crashPolicy.maxRestarts) {
        crashRestarting.add(server.id); try { if (state.status === 'running' || state.status === 'starting') await clientFor(server).action(server, 'stop'); } catch { /* déjà arrêté */ } finally { crashRestarting.delete(server.id); }
        if (!recentNotification(`crash-loop:${server.id}`, server.crashPolicy.cooldownMinutes * 60_000)) await createNotification({ userId: server.ownerId, level: 'error', title: `Boucle de crash stoppée : ${server.name}`, message: `${crashes} crashs en ${server.crashPolicy.windowMinutes} min. Cause probable : ${reason}.`, link: `server:${server.id}` });
      } else if (state.status === 'stopped') {
        crashRestarting.add(server.id); try { await clientFor(server).action(server, 'start'); await createNotification({ userId: server.ownerId, level: 'warning', title: `${server.name} a redémarré après un crash`, message: `Tentative ${crashes}/${server.crashPolicy.maxRestarts}. Cause probable : ${reason}.`, link: `server:${server.id}` }); } finally { crashRestarting.delete(server.id); }
      }
    }
  } finally { monitoringCrashes = false; }
}

function recentNotification(marker: string, period: number) { const [kind = marker, ...rest] = marker.split(':'); const target = rest.join(':'); const word = ({ disk: 'espace', 'crash-loop': 'boucle', node: 'nœud' } as Record<string, string>)[kind] ?? kind; return store.snapshot.notifications.some((item) => item.title.toLowerCase().includes(word) && (!target || item.link?.endsWith(target)) && new Date(item.createdAt).getTime() >= Date.now() - period); }
async function cleanupOperationalData() {
  const metricsCutoff = Date.now() - 7 * 86400_000; const jobsCutoff = Date.now() - 30 * 86400_000; const sessionCutoff = Date.now() - 30 * 86400_000;
  await store.update((draft) => { draft.metrics = draft.metrics.filter((item) => new Date(item.createdAt).getTime() >= metricsCutoff); draft.jobs = draft.jobs.filter((item) => ['queued', 'running'].includes(item.status) || new Date(item.createdAt).getTime() >= jobsCutoff); draft.sessions = draft.sessions.filter((item) => !item.revokedAt || new Date(item.revokedAt).getTime() >= sessionCutoff); draft.accountTokens = draft.accountTokens.filter((item) => !item.usedAt && new Date(item.expiresAt).getTime() >= Date.now() - 86400_000); });
}

async function ensureDefaultNode() {
  const url = padockEnv('DEFAULT_NODE_URL') ?? (isProduction ? undefined : 'http://localhost:3001');
  const token = padockEnv('NODE_TOKEN') ?? (isProduction ? undefined : 'padock-development-node-token-change-me');
  if (url && token && !store.snapshot.nodes.length) {
    await store.update((draft) => {
      draft.nodes.push({ id: 'local001', name: 'Nœud principal', location: 'Local', url, token, maintenance: false, createdAt: new Date().toISOString() });
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

async function syncPersistedSftpAccounts() {
  for (const account of store.snapshot.sftpAccounts) {
    const server = store.snapshot.servers.find((item) => item.id === account.serverId);
    const node = server ? store.snapshot.nodes.find((item) => item.id === server.nodeId) : undefined;
    if (!server || !node) continue;
    await new NodeClient(node).syncSftpAccount(account).catch((error) => {
      app.log.warn({ error, accountId: account.id, nodeId: node.id }, 'Impossible de synchroniser un compte SFTP au démarrage.');
    });
  }
}

function sessionCookie() { return { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: padockEnv('PUBLIC_URL')?.startsWith('https://') ?? false, maxAge: 60 * 60 * 12 }; }
function stripDockerHeader(chunk: Buffer) { let offset = 0; let output = ''; while (offset + 8 <= chunk.length) { const size = chunk.readUInt32BE(offset + 4); if (offset + 8 + size > chunk.length) return output + chunk.subarray(offset).toString(); output += chunk.subarray(offset + 8, offset + 8 + size).toString(); offset += 8 + size; } return output || chunk.toString(); }
interface DestroyableReadableStream extends NodeJS.ReadableStream { destroy(error?: Error): void; }
