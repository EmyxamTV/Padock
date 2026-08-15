import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-steamcmd-'));
const panelPort = await freePort();
const agentPort = await freePort();
const password = 'padock-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
const token = 'padock-steam-node-token-0123456789abcdef';
let child;
let createdServer;
const agent = createServer(async (request, response) => {
  const body = await readJson(request);
  response.setHeader('Content-Type', 'application/json');
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  if (request.url === '/v1/health') {
    response.end(JSON.stringify({ ok: true, docker: true, hostname: 'steam-node', version: 'test', memory: { total: 32 * 1024 ** 3, free: 24 * 1024 ** 3 }, cpu: { cores: 8, load: [0, 0, 0] } }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/servers') {
    createdServer = body;
    response.writeHead(201).end(JSON.stringify({ dockerId: 'steam-container-test' }));
    return;
  }
  if (request.url?.match(/^\/v1\/servers\/[^/]+\/status$/)) {
    response.end(JSON.stringify({ status: createdServer ? 'stopped' : 'missing' }));
    return;
  }
  if (request.method === 'PUT' && request.url?.endsWith('/crash-policy')) {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: `unhandled ${request.method} ${request.url}` }));
});

try {
  await new Promise((resolve) => agent.listen(agentPort, '127.0.0.1', resolve));
  const allocations = Array.from({ length: 5 }, (_, index) => ({ id: `alloc00${index}`, nodeId: 'local001', ip: '0.0.0.0', port: 30000 + index }));
  await writeFile(path.join(root, 'panel.json'), JSON.stringify({
    users: [{ id: 'a11d0001', username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }],
    roles: [],
    nodes: [{ id: 'local001', name: 'Steam Node', location: 'Local', url: `http://127.0.0.1:${agentPort}`, token, createdAt: new Date().toISOString() }],
    servers: [],
    allocations,
    serverAccess: [],
    schedules: [],
    sftpAccounts: [],
    auditLogs: [],
  }, null, 2));
  child = spawn(process.execPath, ['build/server/index.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PADOCK_HOST: '127.0.0.1',
      PADOCK_PORT: String(panelPort),
      PADOCK_DATA_DIR: root,
      PADOCK_PUBLIC_URL: `http://127.0.0.1:${panelPort}`,
      PADOCK_JWT_SECRET: 'padock-steam-jwt-secret-012345678',
      PADOCK_ENCRYPTION_KEY: 'padock-steam-encryption-key-12345',
      PADOCK_GATEWAY_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  await waitForHealth(panelPort, child, () => logs);

  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password } });
  assert.equal(login.status, 200);
  const cookie = login.cookie;

  const catalog = await call('/api/steam/games', { cookie });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.map((game) => game.id), ['rust', 'garrys-mod', '7-days-to-die']);

  const creation = await call('/api/servers', {
    method: 'POST',
    cookie,
    body: {
      name: 'Rust Smoke',
      platform: 'steamcmd',
      software: 'STEAMCMD',
      version: 'latest',
      steamGameId: 'rust',
      memoryMb: 8192,
      cpuPercent: 200,
      diskMb: 30720,
      nodeId: 'local001',
      allocationId: 'alloc000',
    },
  });
  assert.equal(creation.status, 202);
  assert.equal(creation.body.platform, 'steamcmd');
  assert.equal(creation.body.status, 'installing');

  await waitFor(async () => {
    const jobs = await call('/api/jobs', { cookie });
    return jobs.body.find((job) => job.id === creation.body.job.id)?.status === 'completed';
  }, 5000);

  assert.equal(createdServer.platform, 'steamcmd');
  assert.equal(createdServer.software, 'STEAMCMD');
  assert.equal(createdServer.steam.appId, 258550);
  assert.equal(createdServer.steam.presetId, 'rust');
  assert.deepEqual(createdServer.ports.map((port) => [port.hostPort, port.internalPort, port.protocol]), [
    [30000, 28015, 'udp'],
    [30001, 28016, 'udp'],
  ]);

  const persistedAllocations = await call('/api/nodes/local001/allocations', { cookie });
  assert.equal(persistedAllocations.body.find((item) => item.id === 'alloc000').serverId, creation.body.id);
  assert.equal(persistedAllocations.body.find((item) => item.id === 'alloc001').serverId, creation.body.id);
  assert.equal(persistedAllocations.body.find((item) => item.id === 'alloc002').serverId, undefined);

  const invalidRange = await call('/api/servers', {
    method: 'POST',
    cookie,
    body: {
      name: 'Invalid 7DTD',
      platform: 'steamcmd',
      software: 'STEAMCMD',
      version: 'latest',
      steamGameId: '7-days-to-die',
      memoryMb: 8192,
      cpuPercent: 200,
      diskMb: 30720,
      nodeId: 'local001',
      allocationId: 'alloc004',
    },
  });
  assert.equal(invalidRange.status, 409);
  assert.match(invalidRange.body.error, /contigu/);

  console.log('SteamCMD smoke test passed: catalog, multi-port allocation and agent payload work.');
} finally {
  if (child && !child.killed) child.kill();
  await new Promise((resolve) => agent.close(resolve));
  await rm(root, { recursive: true, force: true });
}

async function call(route, options = {}) {
  const headers = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${panelPort}${route}`, { method: options.method ?? 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function waitForHealth(selected, processHandle, logs) {
  await waitFor(async () => {
    if (processHandle.exitCode !== null) throw new Error(logs());
    try { return (await fetch(`http://127.0.0.1:${selected}/api/health`)).ok; } catch { return false; }
  }, 6000);
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Timed out waiting for SteamCMD smoke-test condition.');
}
