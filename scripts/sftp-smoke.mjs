import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { SftpAccountRegistry, startSftpServer } from '../build/agent/sftp.js';

const { Client } = ssh2;
const root = await mkdtemp(path.join(os.tmpdir(), 'padock-sftp-'));
const serversDir = path.join(root, 'servers');
const serverDir = path.join(serversDir, 'abcd1234');
const registry = new SftpAccountRegistry(path.join(root, 'accounts.json'));
let server;

try {
  await mkdir(path.join(serverDir, 'plugins'), { recursive: true });
  await mkdir(path.join(serverDir, 'world'), { recursive: true });
  await writeFile(path.join(serverDir, 'plugins', 'existing.txt'), 'ok');
  await registry.load();
  await registry.upsert(account('11111111', 'builder', 'builder-password', false));
  await registry.upsert(account('22222222', 'viewer', 'viewer-password', true));
  server = await startSftpServer({ host: '127.0.0.1', port: 0, serversDir, accounts: registry, hostKeyPath: path.join(root, 'host-key'), log: () => undefined });
  const port = server.address().port;

  await withSftp(port, 'builder', 'builder-password', async (sftp) => {
    const rootEntries = await readdir(sftp, '/');
    assert.deepEqual(rootEntries.map((entry) => entry.filename).sort(), ['plugins']);
    await write(sftp, '/plugins/created.txt', 'created');
    await expectFailure(() => write(sftp, '/world/forbidden.txt', 'blocked'));
    await expectFailure(() => rmdir(sftp, '/plugins'));
  });

  await withSftp(port, 'viewer', 'viewer-password', async (sftp) => {
    assert.equal((await read(sftp, '/plugins/existing.txt')).toString(), 'ok');
    await expectFailure(() => write(sftp, '/plugins/read-only.txt', 'blocked'));
  });

  console.log('SFTP smoke test passed: folder isolation and read-only mode are enforced.');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

function account(id, username, password, readOnly) {
  const salt = `${id}${id}`;
  return { id, serverId: 'abcd1234', username, salt, passwordHash: scryptSync(password, salt, 64).toString('hex'), paths: ['plugins'], readOnly, enabled: true };
}

function withSftp(port, username, password, task) {
  return new Promise((resolve, reject) => {
    const connection = new Client();
    connection.once('error', reject);
    connection.on('ready', () => connection.sftp((error, sftp) => {
      if (error) { connection.end(); reject(error); return; }
      Promise.resolve(task(sftp)).then(() => { connection.end(); resolve(); }, (taskError) => { connection.end(); reject(taskError); });
    }));
    connection.connect({ host: '127.0.0.1', port, username, password, readyTimeout: 5000 });
  });
}

function readdir(sftp, target) { return new Promise((resolve, reject) => sftp.readdir(target, (error, entries) => error ? reject(error) : resolve(entries))); }
function read(sftp, target) { return new Promise((resolve, reject) => sftp.readFile(target, (error, content) => error ? reject(error) : resolve(content))); }
function write(sftp, target, content) { return new Promise((resolve, reject) => sftp.writeFile(target, content, (error) => error ? reject(error) : resolve())); }
function rmdir(sftp, target) { return new Promise((resolve, reject) => sftp.rmdir(target, (error) => error ? reject(error) : resolve())); }
async function expectFailure(task) { let failed = false; try { await task(); } catch { failed = true; } assert.equal(failed, true, 'The SFTP operation should have been denied.'); }
