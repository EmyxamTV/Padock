import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-performance-'));
const panelPort = await freePort();
const agentPort = await freePort();
const password = 'padock-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
let panel;
let bulkStatusCalls = 0;
let individualStatusCalls = 0;
let bulkMetricCalls = 0;
let individualMetricCalls = 0;

const agent = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/health') return response.end(JSON.stringify({ ok: true, docker: true, hostname: 'performance-node', version: 'test', memory: { total: 32 * 1024 ** 3, free: 24 * 1024 ** 3 }, cpu: { cores: 8, load: [0, 0, 0] } }));
  if (request.method === 'POST' && request.url === '/v1/servers/statuses') {
    bulkStatusCalls += 1;
    const body = JSON.parse(await readBody(request));
    return response.end(JSON.stringify(Object.fromEntries(body.ids.map((id) => [id, { status: 'stopped' }]))));
  }
  if (request.method === 'POST' && request.url === '/v1/servers/metrics') {
    bulkMetricCalls += 1;
    const body = JSON.parse(await readBody(request));
    return response.end(JSON.stringify(Object.fromEntries(body.ids.map((id) => [id, { status: 'stopped', cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes: 0 }]))));
  }
  if (request.url?.match(/^\/v1\/servers\/[^/]+\/status$/)) {
    individualStatusCalls += 1;
    return response.end(JSON.stringify({ status: 'stopped' }));
  }
  if (request.url?.match(/^\/v1\/servers\/[^/]+\/metrics$/)) {
    individualMetricCalls += 1;
    return response.end(JSON.stringify({ status: 'stopped', cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes: 0 }));
  }
  response.writeHead(404).end(JSON.stringify({ error: 'Route inconnue.' }));
});

try {
  await new Promise((resolve) => agent.listen(agentPort, '127.0.0.1', resolve));
  const servers = Array.from({ length: 80 }, (_, index) => ({
    id: `srv${String(index).padStart(5, '0')}`,
    name: `Serveur ${index + 1}`,
    software: 'PAPER',
    version: 'LATEST',
    memoryMb: 2048,
    cpuPercent: 100,
    diskMb: 10240,
    port: 30000 + index,
    nodeId: 'local001',
    allocationId: `alloc${String(index).padStart(3, '0')}`,
    ownerId: 'a11d0001',
    createdAt: new Date().toISOString(),
  }));
  const allocations = servers.map((server, index) => ({ id: server.allocationId, nodeId: 'local001', ip: '0.0.0.0', port: 30000 + index, serverId: server.id }));
  const metrics = Array.from({ length: 100 }, (_, index) => ({ id: `metric${String(index).padStart(3, '0')}`, serverId: servers[0].id, status: 'stopped', cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes: 0, createdAt: new Date(Date.now() - (100 - index) * 60_000).toISOString() }));
  await writeFile(path.join(root, 'panel.json'), JSON.stringify({
    users: [{ id: 'a11d0001', username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }],
    roles: [], groups: [], nodes: [{ id: 'local001', name: 'Node', location: 'Local', url: `http://127.0.0.1:${agentPort}`, token: 'padock-performance-node-token-0123456789', createdAt: new Date().toISOString() }],
    servers, allocations, serverAccess: [], schedules: [], sftpAccounts: [], jobs: [], notifications: [], metrics, sessions: [], apiKeys: [], crashEvents: [], accountTokens: [], templates: [], auditLogs: [],
  }, null, 2));

  panel = spawn(process.execPath, ['build/server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', PADOCK_HOST: '127.0.0.1', PADOCK_PORT: String(panelPort), PADOCK_DATA_DIR: root, PADOCK_PUBLIC_URL: `http://127.0.0.1:${panelPort}`, PADOCK_JWT_SECRET: 'padock-performance-jwt-secret-012345', PADOCK_ENCRYPTION_KEY: 'padock-performance-encryption-key-12' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  panel.stdout.on('data', (chunk) => { logs += chunk; });
  panel.stderr.on('data', (chunk) => { logs += chunk; });
  await waitForHealth(panelPort, panel, () => logs);
  await waitFor(() => bulkStatusCalls >= 1 && bulkMetricCalls >= 1);
  assert.equal(individualStatusCalls, 0);
  assert.equal(individualMetricCalls, 0);
  bulkStatusCalls = 0;

  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password } });
  assert.equal(login.status, 200);
  const listed = await call('/api/servers', { cookie: login.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 80);
  assert.equal(bulkStatusCalls, 1);
  assert.equal(individualStatusCalls, 0);
  assert.ok(listed.body.every((server) => server.status === 'stopped'));
  const history = await call(`/api/servers/${servers[0].id}/metrics?hours=168`, { cookie: login.cookie });
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 72);
  console.log('Performance smoke test passed: 80 server states and metrics use one request per node and no per-server requests.');
} finally {
  if (panel && !panel.killed) panel.kill();
  await new Promise((resolve) => agent.close(resolve));
  await rm(root, { recursive: true, force: true });
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function call(route, options = {}) {
  const headers = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${panelPort}${route}`, { method: options.method ?? 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, processHandle, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(logs());
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Padock did not start in time.\n${logs()}`);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the performance-test background cycles.');
}
