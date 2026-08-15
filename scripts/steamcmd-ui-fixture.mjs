import { createServer } from 'node:http';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-steamcmd-ui-'));
const panelPort = 4173;
const agentPort = 4174;
const password = 'padock-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
const token = 'padock-ui-node-token-0123456789abcdef';

const agent = createServer(async (request, response) => {
  for await (const _ of request) { /* consume */ }
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/health') {
    response.end(JSON.stringify({ ok: true, docker: true, hostname: 'steam-node', version: 'test', memory: { total: 32 * 1024 ** 3, free: 24 * 1024 ** 3 }, cpu: { cores: 8, load: [0, 0, 0] } }));
    return;
  }
  if (request.url?.endsWith('/status')) {
    response.end(JSON.stringify({ status: 'missing' }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: 'fixture' }));
});

await new Promise((resolve) => agent.listen(agentPort, '127.0.0.1', resolve));
await writeFile(path.join(root, 'panel.json'), JSON.stringify({
  users: [{ id: 'a11d0001', username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }],
  roles: [],
  nodes: [{ id: 'local001', name: 'Nœud Steam', location: 'Paris', url: `http://127.0.0.1:${agentPort}`, token, createdAt: new Date().toISOString() }],
  servers: [],
  allocations: Array.from({ length: 20 }, (_, index) => ({ id: `alloc${String(index).padStart(3, '0')}`, nodeId: 'local001', ip: '0.0.0.0', port: 30000 + index })),
  serverAccess: [],
  schedules: [],
  sftpAccounts: [],
  auditLogs: [],
}, null, 2));

const panel = spawn(process.execPath, ['build/server/index.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PADOCK_HOST: '127.0.0.1',
    PADOCK_PORT: String(panelPort),
    PADOCK_DATA_DIR: root,
    PADOCK_PUBLIC_URL: `http://127.0.0.1:${panelPort}`,
    PADOCK_JWT_SECRET: 'padock-ui-jwt-secret-012345678901',
    PADOCK_ENCRYPTION_KEY: 'padock-ui-encryption-key-01234567',
    PADOCK_GATEWAY_ENABLED: 'false',
  },
  stdio: 'ignore',
});

async function cleanup() {
  panel.kill();
  await new Promise((resolve) => agent.close(resolve));
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGTERM', () => void cleanup());
process.on('SIGINT', () => void cleanup());
setInterval(() => undefined, 60_000);
