import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-console-race-'));
const panelPort = await freePort();
const agentPort = await freePort();
const password = 'padock-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
let panel;
let socket;
const agent = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/health') return response.end(JSON.stringify({ ok: true, docker: true, hostname: 'smoke', version: 'test', memory: { total: 1, free: 1 }, cpu: { cores: 1, load: [0] } }));
  if (request.url === '/v1/servers/race0001/status') return response.end(JSON.stringify({ status: 'missing' }));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Route de test introuvable.' }));
});

try {
  await new Promise((resolve) => agent.listen(agentPort, '127.0.0.1', resolve));
  await writeFile(path.join(root, 'panel.json'), JSON.stringify({
    users: [{ id: 'a11d0001', username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }],
    roles: [],
    nodes: [{ id: 'local001', name: 'Node', location: 'Local', url: `http://127.0.0.1:${agentPort}`, token: 'padock-test-node-token-0123456789abcdef', createdAt: new Date().toISOString() }],
    servers: [{ id: 'race0001', name: 'Création en cours', software: 'PAPER', version: 'LATEST', memoryMb: 1024, cpuPercent: 100, diskMb: 1024, port: 25566, nodeId: 'local001', allocationId: 'alloc001', ownerId: 'a11d0001', crashPolicy: { enabled: true, maxRestarts: 3, windowMinutes: 10, cooldownMinutes: 30 }, backupPolicy: { retention: 5, remoteEnabled: false }, createdAt: new Date().toISOString() }],
    allocations: [{ id: 'alloc001', nodeId: 'local001', ip: '0.0.0.0', port: 25566, serverId: 'race0001' }],
    serverAccess: [], schedules: [], sftpAccounts: [], auditLogs: [],
  }, null, 2));
  panel = spawn(process.execPath, ['build/server/index.js'], { cwd: path.resolve('.'), env: { ...process.env, NODE_ENV: 'production', PADOCK_HOST: '127.0.0.1', PADOCK_PORT: String(panelPort), PADOCK_DATA_DIR: root, PADOCK_PUBLIC_URL: `http://127.0.0.1:${panelPort}`, PADOCK_JWT_SECRET: 'padock-console-jwt-secret-0123456789', PADOCK_ENCRYPTION_KEY: 'padock-console-encryption-key-123456' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  panel.stdout.on('data', (chunk) => { logs += chunk; });
  panel.stderr.on('data', (chunk) => { logs += chunk; });
  await waitForHealth(panelPort, panel, () => logs);

  const login = await fetch(`http://127.0.0.1:${panelPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  socket = io(`http://127.0.0.1:${panelPort}`, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const event = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Aucune réponse de console.')), 3000);
    socket.once('console:pending', () => { clearTimeout(timeout); resolve('pending'); });
    socket.once('console:error', (message) => { clearTimeout(timeout); resolve(`error:${message}`); });
    socket.emit('console:subscribe', 'race0001');
  });
  assert.equal(event, 'pending');
  console.log('Console race smoke test passed: a pending container does not surface a Docker 404.');
} finally {
  socket?.disconnect();
  if (panel && !panel.killed) panel.kill();
  await new Promise((resolve) => agent.close(resolve));
  await rm(root, { recursive: true, force: true });
}

async function freePort() { const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const selected = server.address().port; await new Promise((resolve) => server.close(resolve)); return selected; }
async function waitForHealth(port, processHandle, logs) { for (let i = 0; i < 60; i++) { if (processHandle.exitCode !== null) throw new Error(logs()); try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(logs()); }
