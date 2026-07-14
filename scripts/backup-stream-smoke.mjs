import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerFiles } from '../build/agent/files.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'padock-backup-')); const servers = path.join(root, 'servers'); const backups = path.join(root, 'backups'); const files = new ServerFiles(servers, backups);
try {
  await mkdir(path.join(servers, 'aaaaaaaa', 'world'), { recursive: true }); await mkdir(path.join(servers, 'bbbbbbbb'), { recursive: true }); await writeFile(path.join(servers, 'aaaaaaaa', 'world', 'level.dat'), 'padock-transfer');
  const backup = await files.createBackup('aaaaaaaa', 'stream'); assert.match(backup.checksum, /^[a-f0-9]{64}$/);
  const opened = await files.openBackup('aaaaaaaa', backup.id); await files.writeBackupStream('bbbbbbbb', backup.id, opened.stream, opened.checksum); await files.restoreBackup('bbbbbbbb', backup.id);
  assert.equal(await readFile(path.join(servers, 'bbbbbbbb', 'world', 'level.dat'), 'utf8'), 'padock-transfer');
  assert.equal((await files.pruneBackups('bbbbbbbb', 0)).deleted, 1);
  console.log('Backup stream smoke test passed: SHA-256 transfer, restore and retention work.');
} finally { await rm(root, { recursive: true, force: true }); }
