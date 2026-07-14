import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-rbac-'));
const port = await freePort();
const password = 'padock-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
const adminId = 'a11d0001';
const serverId = 'abcd1234';
let processHandle;

try {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'panel.json'), JSON.stringify(seedState(), null, 2));
  processHandle = spawn(process.execPath, ['build/server/index.js'], {
    cwd: path.resolve('.'),
    env: { ...process.env, NODE_ENV: 'production', PADOCK_HOST: '127.0.0.1', PADOCK_PORT: String(port), PADOCK_DATA_DIR: root, PADOCK_PUBLIC_URL: `http://127.0.0.1:${port}`, PADOCK_JWT_SECRET: 'padock-rbac-test-jwt-secret-0123456789' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  processHandle.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  processHandle.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  await waitForHealth(port, processHandle, () => logs);

  const admin = await login(port, 'admin', password);
  const freeAllocations = await request(port, '/api/nodes/local001/allocations/available', admin.cookie);
  assert.equal(freeAllocations.status, 200);
  assert.ok(freeAllocations.body.some((allocation) => allocation.id === 'a110c002' && allocation.port === 25566));
  assert.ok(!freeAllocations.body.some((allocation) => allocation.id === 'a110c001' || allocation.port === 25565));
  const invalidPortServer = { name: 'Port interdit', software: 'PAPER', version: '1.21.8', memoryMb: 2048, cpuPercent: 100, diskMb: 10240, nodeId: 'local001', port: 29999 };
  const invalidPortResult = await request(port, '/api/servers', admin.cookie, { method: 'POST', body: invalidPortServer });
  assert.equal(invalidPortResult.status, 409);
  assert.match(invalidPortResult.body.error, /ne fait pas partie des allocations/);
  const usedAllocationResult = await request(port, '/api/servers', admin.cookie, { method: 'POST', body: { ...invalidPortServer, port: undefined, allocationId: 'a110c001' } });
  assert.equal(usedAllocationResult.status, 409);
  const nodeUpdate = await request(port, '/api/nodes/local001', admin.cookie, { method: 'PUT', body: { name: 'Nœud RBAC', location: 'Paris test', url: 'http://127.0.0.1:9' } });
  assert.equal(nodeUpdate.status, 200);
  assert.equal(nodeUpdate.body.name, 'Nœud RBAC');
  assert.equal((await request(port, '/api/nodes/local001/allocations/a110c001', admin.cookie, { method: 'DELETE' })).status, 409);
  assert.equal((await request(port, '/api/nodes/local001/allocations/a110c002', admin.cookie, { method: 'DELETE' })).status, 200);
  const rangeResult = await request(port, '/api/nodes/local001/allocations', admin.cookie, { method: 'POST', body: { ip: '0.0.0.0', portStart: 30000, portEnd: 30000 } });
  assert.equal(rangeResult.status, 201);
  assert.equal(rangeResult.body.created, 1);
  const delegated = await request(port, '/api/users', admin.cookie, { method: 'POST', body: { username: 'manager', email: 'manager@padock.local', password: 'manager-password', role: 'user', permissions: ['users.manage', 'audit.view'] } });
  assert.equal(delegated.status, 201);

  const manager = await login(port, 'manager', 'manager-password');
  assert.equal((await request(port, '/api/users', manager.cookie)).status, 200);
  assert.equal((await request(port, '/api/nodes/local001', manager.cookie, { method: 'PUT', body: { name: 'Interdit', location: 'Interdit', url: 'http://127.0.0.1:9' } })).status, 403);
  assert.equal((await request(port, '/api/roles', manager.cookie)).status, 200);
  assert.equal((await request(port, '/api/audit', manager.cookie)).status, 200);
  assert.equal((await request(port, '/api/roles', manager.cookie, { method: 'POST', body: { name: 'Interdit', description: '', permissions: [] } })).status, 403);
  assert.equal((await request(port, '/api/users', manager.cookie, { method: 'POST', body: { username: 'forbiddenadmin', email: 'forbiddenadmin@padock.local', password: 'forbidden-password', role: 'admin', permissions: [] } })).status, 403);
  assert.equal((await request(port, '/api/users', manager.cookie, { method: 'POST', body: { username: 'escalated', email: 'escalated@padock.local', password: 'escalated-password', role: 'user', permissions: ['nodes.manage'] } })).status, 403);

  const customRoleResult = await request(port, '/api/roles', admin.cookie, { method: 'POST', body: { name: 'Créateur', description: 'Peut créer ses propres serveurs.', permissions: ['servers.create'] } });
  assert.equal(customRoleResult.status, 201);
  const customRoleId = customRoleResult.body.id;

  const childResult = await request(port, '/api/users', manager.cookie, { method: 'POST', body: { username: 'builder', email: 'builder@padock.local', password: 'builder-password', role: 'user', permissions: ['audit.view'] } });
  assert.equal(childResult.status, 201);
  const childId = childResult.body.id;
  assert.equal((await request(port, `/api/users/${adminId}`, manager.cookie, { method: 'PUT', body: { role: 'user', permissions: [] } })).status, 403);
  assert.equal((await request(port, `/api/users/${childId}`, manager.cookie, { method: 'PUT', body: { role: 'user', roleId: customRoleId, permissions: ['audit.view'] } })).status, 403);

  const roleAssignment = await request(port, `/api/users/${childId}`, admin.cookie, { method: 'PUT', body: { role: 'user', roleId: customRoleId, permissions: ['audit.view'] } });
  assert.equal(roleAssignment.status, 200);
  assert.equal(roleAssignment.body.customRole.name, 'Créateur');
  assert.deepEqual(roleAssignment.body.directPermissions, ['audit.view']);
  assert.deepEqual(roleAssignment.body.permissions.sort(), ['audit.view', 'servers.create']);
  assert.equal((await request(port, `/api/roles/${customRoleId}`, admin.cookie, { method: 'DELETE' })).status, 409);

  const memberResult = await request(port, `/api/servers/${serverId}/members/${childId}`, admin.cookie, { method: 'PUT', body: { permissions: ['console.read', 'files.read'] } });
  assert.equal(memberResult.status, 200);
  const child = await login(port, 'builder', 'builder-password');
  assert.equal((await request(port, '/api/nodes/local001/allocations/available', child.cookie)).status, 200);
  const visibleServers = await request(port, '/api/servers', child.cookie);
  assert.equal(visibleServers.status, 200);
  assert.deepEqual(visibleServers.body[0].permissions.sort(), ['console.read', 'files.read']);
  assert.equal((await request(port, `/api/servers/${serverId}/sftp/accounts`, child.cookie)).status, 403);
  assert.equal((await request(port, `/api/servers/${serverId}/members`, child.cookie)).status, 403);

  const roleUpdate = await request(port, `/api/roles/${customRoleId}`, admin.cookie, { method: 'PUT', body: { name: 'Créateur', description: 'Accès infrastructure en lecture.', permissions: ['nodes.view'] } });
  assert.equal(roleUpdate.status, 200);
  const refreshedChild = await request(port, '/api/auth/me', child.cookie);
  assert.deepEqual(refreshedChild.body.permissions.sort(), ['audit.view', 'nodes.view']);
  assert.equal((await request(port, `/api/users/${childId}`, admin.cookie, { method: 'PUT', body: { role: 'user', roleId: null, permissions: ['audit.view'] } })).status, 200);
  assert.equal((await request(port, `/api/roles/${customRoleId}`, admin.cookie, { method: 'DELETE' })).status, 200);

  console.log('RBAC smoke test passed: custom roles, allocation validation, global delegation and per-server permissions are enforced.');
} finally {
  if (processHandle && !processHandle.killed) processHandle.kill();
  await rm(root, { recursive: true, force: true });
}

function seedState() {
  return {
    users: [{ id: adminId, username: 'admin', email: 'admin@padock.local', role: 'admin', permissions: [], passwordHash: scryptSync(password, salt, 64).toString('hex'), salt, createdAt: new Date().toISOString() }],
    roles: [],
    nodes: [{ id: 'local001', name: 'Nœud test', location: 'Local', url: 'http://127.0.0.1:9', token: 'padock-rbac-node-token-0123456789abcdef', createdAt: new Date().toISOString() }],
    servers: [{ id: serverId, name: 'Serveur RBAC', software: 'PAPER', version: '1.21.8', memoryMb: 2048, cpuPercent: 100, diskMb: 10240, port: 25565, nodeId: 'local001', allocationId: 'a110c001', ownerId: adminId, createdAt: new Date().toISOString() }],
    allocations: [{ id: 'a110c001', nodeId: 'local001', ip: '0.0.0.0', port: 25565, serverId }, { id: 'a110c002', nodeId: 'local001', ip: '0.0.0.0', port: 25566 }],
    serverAccess: [], schedules: [], sftpAccounts: [], auditLogs: [],
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function waitForHealth(selectedPort, child, logs) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Padock exited before the RBAC test started.\n${logs()}`);
    try { if ((await fetch(`http://127.0.0.1:${selectedPort}/api/health`)).ok) return; } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Padock did not start in time.\n${logs()}`);
}

async function login(selectedPort, username, loginPassword) {
  const response = await fetch(`http://127.0.0.1:${selectedPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: loginPassword }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { cookie, body: await response.json() };
}

async function request(selectedPort, route, cookie, options = {}) {
  const response = await fetch(`http://127.0.0.1:${selectedPort}${route}`, { method: options.method ?? 'GET', headers: { Cookie: cookie, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
