import assert from 'node:assert/strict';
import { createHmac, scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-operations-')); const port = await freePort(); const password = 'padock-admin-password'; const salt = '0123456789abcdef0123456789abcdef'; let child;
try {
  await writeFile(path.join(root, 'panel.json'), JSON.stringify({ users: [{ id: 'a11d0001', username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }], roles: [], nodes: [{ id: 'local001', name: 'Node', location: 'Local', url: 'http://127.0.0.1:9', token: 'padock-test-node-token-0123456789abcdef', createdAt: new Date().toISOString() }], servers: [], allocations: [{ id: 'alloc001', nodeId: 'local001', ip: '0.0.0.0', port: 25565 }], serverAccess: [], schedules: [], sftpAccounts: [], auditLogs: [] }, null, 2));
  child = spawn(process.execPath, ['build/server/index.js'], { cwd: path.resolve('.'), env: { ...process.env, NODE_ENV: 'production', PADOCK_HOST: '127.0.0.1', PADOCK_PORT: String(port), PADOCK_DATA_DIR: root, PADOCK_PUBLIC_URL: `http://127.0.0.1:${port}`, PADOCK_JWT_SECRET: 'padock-operations-jwt-secret-01234567', PADOCK_ENCRYPTION_KEY: 'padock-operations-encryption-key-1234' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; }); await waitForHealth(port, child, () => logs);
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password } }); assert.equal(login.status, 200); const cookie = login.cookie;
  const sessions = await call('/api/auth/sessions', { cookie }); assert.equal(sessions.status, 200); assert.equal(sessions.body.length, 1); assert.equal(sessions.body[0].current, true);
  const apiKey = await call('/api/auth/api-keys', { method: 'POST', cookie, body: { name: 'Smoke' } }); assert.equal(apiKey.status, 201); assert.match(apiKey.body.secret, /^padock_/);
  const keyMe = await call('/api/auth/me', { bearer: apiKey.body.secret }); assert.equal(keyMe.status, 200); assert.equal(keyMe.body.username, 'admin');
  const group = await call('/api/groups', { method: 'POST', cookie, body: { name: 'Support', description: 'Test', permissions: ['audit.view'], serverPermissions: ['console.read'] } }); assert.equal(group.status, 201);
  const twoFactor = await call('/api/auth/2fa/setup', { method: 'POST', cookie, body: { currentPassword: password } }); assert.equal(twoFactor.status, 200);
  const confirmed = await call('/api/auth/2fa/confirm', { method: 'POST', cookie, body: { code: totp(twoFactor.body.secret) } }); assert.equal(confirmed.status, 200); assert.equal(confirmed.body.recoveryCodes.length, 8);
  const challenged = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password } }); assert.equal(challenged.status, 202); assert.equal(challenged.body.twoFactorRequired, true);
  const verified = await call('/api/auth/2fa/login', { method: 'POST', body: { challenge: challenged.body.challenge, code: totp(twoFactor.body.secret) } }); assert.equal(verified.status, 200); assert.ok(verified.cookie);
  const maintenance = await call('/api/nodes/local001', { method: 'PUT', cookie: verified.cookie, body: { name: 'Node', location: 'Local', url: 'http://127.0.0.1:9', maintenance: true, maintenanceMessage: 'Test' } }); assert.equal(maintenance.status, 200);
  const blocked = await call('/api/servers', { method: 'POST', cookie: verified.cookie, body: { name: 'Blocked', software: 'PAPER', version: 'LATEST', memoryMb: 1024, cpuPercent: 100, diskMb: 1024, nodeId: 'local001' } }); assert.equal(blocked.status, 409); assert.match(blocked.body.error, /Test/);
  const notification = await call('/api/notifications/test', { method: 'POST', cookie: verified.cookie }); assert.equal(notification.status, 200); assert.equal((await call('/api/notifications', { cookie: verified.cookie })).body[0].title, 'Test Padock');
  console.log('Operations smoke test passed: sessions, API keys, groups, 2FA, maintenance and notifications work.');
} finally { if (child && !child.killed) child.kill(); await rm(root, { recursive: true, force: true }); }

async function call(route, options = {}) { const headers = {}; if (options.cookie) headers.Cookie = options.cookie; if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`; if (options.body) headers['Content-Type'] = 'application/json'; const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: options.method ?? 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined }); return { status: response.status, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
async function freePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const selected = server.address().port; await new Promise((resolve) => server.close(resolve)); return selected; }
async function waitForHealth(selected, processHandle, logs) { for (let i = 0; i < 60; i++) { if (processHandle.exitCode !== null) throw new Error(logs()); try { if ((await fetch(`http://127.0.0.1:${selected}/api/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(logs()); }
function totp(secret) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let value = 0; const bytes = []; for (const character of secret) { value = (value << 5) | alphabet.indexOf(character); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } } const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000))); const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); const offset = digest.at(-1) & 15; return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'); }
