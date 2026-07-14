import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { Attributes, SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;

const STATUS = utils.sftp.STATUS_CODE;

type OpenResource =
  | { type: 'file'; file: FileHandle; target: string }
  | { type: 'directory'; entries: Array<{ filename: string; longname: string; attrs: Attributes }>; offset: number };

export async function startSftpServer(options: {
  host: string;
  port: number;
  serversDir: string;
  secret: string;
  hostKeyPath: string;
  log: (message: string) => void;
}) {
  const hostKey = await loadOrCreateHostKey(options.hostKeyPath);
  const server = new Server({ hostKeys: [hostKey], ident: 'SSH-2.0-Padock_SFTP_1.0.0' }, (client, info) => {
    let serverId = '';

    client.on('authentication', (context) => {
      if (context.method !== 'password' || !validCredential(context.username, context.password, options.secret)) {
        context.reject(['password']); return;
      }
      const requestedServer = context.username;
      void stat(path.join(options.serversDir, requestedServer)).then((info) => {
        if (!info.isDirectory()) return context.reject(['password']);
        serverId = requestedServer;
        context.accept();
      }).catch(() => context.reject(['password']));
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), path.resolve(options.serversDir, serverId)));
      });
    });
    client.on('error', () => undefined);
    options.log(`Connexion SFTP reçue depuis ${info.ip}.`);
  });
  server.on('error', (error: Error) => options.log(`Erreur SFTP : ${error.message}`));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
  });
  options.log(`SFTP prêt sur ${options.host}:${options.port}.`);
  return server;
}

function serveSftp(sftp: SFTPWrapper, base: string) {
  const resources = new Map<number, OpenResource>();
  let nextHandle = 1;
  const respond = (requestId: number, task: () => Promise<void>) => {
    void task().catch((error) => {
      const mapped = mapError(error);
      sftp.status(requestId, mapped.code, mapped.message);
    });
  };

  sftp.on('REALPATH', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    await assertNoSymlink(base, target);
    const info = await stat(target);
    const filename = remotePath(base, target);
    sftp.name(requestId, [{ filename, longname: longName(path.basename(filename) || '/', info), attrs: attributes(info) }]);
  }));

  const sendStat = (requestId: number, requestedPath: string) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    await assertNoSymlink(base, target);
    sftp.attrs(requestId, attributes(await stat(target)));
  });
  sftp.on('STAT', sendStat);
  sftp.on('LSTAT', sendStat);

  sftp.on('OPENDIR', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    await assertNoSymlink(base, target);
    const entries = await Promise.all((await readdir(target, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink())
      .map(async (entry) => {
        const info = await stat(path.join(target, entry.name));
        return { filename: entry.name, longname: longName(entry.name, info), attrs: attributes(info) };
      }));
    const handleId = nextHandle++;
    resources.set(handleId, { type: 'directory', entries, offset: 0 });
    sftp.handle(requestId, encodeHandle(handleId));
  }));

  sftp.on('READDIR', (requestId, rawHandle) => respond(requestId, async () => {
    const resource = resources.get(decodeHandle(rawHandle));
    if (!resource || resource.type !== 'directory') throw sftpError(STATUS.FAILURE, 'Dossier non ouvert.');
    if (resource.offset >= resource.entries.length) return sftp.status(requestId, STATUS.EOF);
    const entries = resource.entries.slice(resource.offset, resource.offset + 100);
    resource.offset += entries.length;
    sftp.name(requestId, entries);
  }));

  sftp.on('OPEN', (requestId, filename, flags, attrs) => respond(requestId, async () => {
    const target = resolveTarget(base, filename);
    await assertNoSymlink(base, target, true);
    await mkdir(path.dirname(target), { recursive: true });
    const mode = utils.sftp.flagsToString(flags);
    if (!mode) throw sftpError(STATUS.BAD_MESSAGE, 'Mode d’ouverture invalide.');
    const file = await open(target, mode, attrs.mode ? attrs.mode & 0o777 : 0o664);
    const handleId = nextHandle++;
    resources.set(handleId, { type: 'file', file, target });
    sftp.handle(requestId, encodeHandle(handleId));
  }));

  sftp.on('READ', (requestId, rawHandle, offset, length) => respond(requestId, async () => {
    const resource = resources.get(decodeHandle(rawHandle));
    if (!resource || resource.type !== 'file') throw sftpError(STATUS.FAILURE, 'Fichier non ouvert.');
    const buffer = Buffer.alloc(Math.min(length, 1024 * 1024));
    const result = await resource.file.read(buffer, 0, buffer.length, offset);
    if (!result.bytesRead) return sftp.status(requestId, STATUS.EOF);
    sftp.data(requestId, buffer.subarray(0, result.bytesRead));
  }));

  sftp.on('WRITE', (requestId, rawHandle, offset, data) => respond(requestId, async () => {
    const resource = resources.get(decodeHandle(rawHandle));
    if (!resource || resource.type !== 'file') throw sftpError(STATUS.FAILURE, 'Fichier non ouvert.');
    await resource.file.write(data, 0, data.length, offset);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('FSTAT', (requestId, rawHandle) => respond(requestId, async () => {
    const resource = resources.get(decodeHandle(rawHandle));
    if (!resource || resource.type !== 'file') throw sftpError(STATUS.FAILURE, 'Fichier non ouvert.');
    sftp.attrs(requestId, attributes(await resource.file.stat()));
  }));

  sftp.on('FSETSTAT', (requestId, rawHandle, attrs) => respond(requestId, async () => {
    const resource = resources.get(decodeHandle(rawHandle));
    if (!resource || resource.type !== 'file') throw sftpError(STATUS.FAILURE, 'Fichier non ouvert.');
    if (attrs.size !== undefined) await resource.file.truncate(attrs.size);
    if (attrs.mode !== undefined) await resource.file.chmod(attrs.mode & 0o777);
    if (attrs.atime !== undefined || attrs.mtime !== undefined) {
      const current = await resource.file.stat();
      await resource.file.utimes(attrs.atime ?? current.atime, attrs.mtime ?? current.mtime);
    }
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('CLOSE', (requestId, rawHandle) => respond(requestId, async () => {
    const id = decodeHandle(rawHandle);
    const resource = resources.get(id);
    if (!resource) throw sftpError(STATUS.FAILURE, 'Ressource non ouverte.');
    resources.delete(id);
    if (resource.type === 'file') { await resource.file.close(); await applyOwner(base, resource.target); }
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('MKDIR', (requestId, requestedPath, attrs) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    await assertNoSymlink(base, target, true);
    await mkdir(target, { mode: attrs.mode ? attrs.mode & 0o777 : 0o775 });
    await applyOwner(base, target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('REMOVE', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath, false);
    await assertNoSymlink(base, target);
    await unlink(target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('RMDIR', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath, false);
    await assertNoSymlink(base, target);
    await rmdir(target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('RENAME', (requestId, oldPath, newPath) => respond(requestId, async () => {
    const source = resolveTarget(base, oldPath, false);
    const destination = resolveTarget(base, newPath, false);
    await assertNoSymlink(base, source);
    await assertNoSymlink(base, destination, true);
    await rename(source, destination);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('SETSTAT', (requestId, requestedPath, attrs) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    await assertNoSymlink(base, target);
    if (attrs.size !== undefined) await truncate(target, attrs.size);
    if (attrs.mode !== undefined) await chmod(target, attrs.mode & 0o777);
    if (attrs.atime !== undefined || attrs.mtime !== undefined) {
      const current = await stat(target);
      await utimes(target, attrs.atime ?? current.atime, attrs.mtime ?? current.mtime);
    }
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('READLINK', (requestId) => sftp.status(requestId, STATUS.OP_UNSUPPORTED, 'Les liens symboliques sont désactivés.'));
  sftp.on('SYMLINK', (requestId) => sftp.status(requestId, STATUS.OP_UNSUPPORTED, 'Les liens symboliques sont désactivés.'));
  sftp.on('EXTENDED', (requestId) => sftp.status(requestId, STATUS.OP_UNSUPPORTED));
  sftp.on('close', () => {
    for (const resource of resources.values()) if (resource.type === 'file') void resource.file.close().then(() => applyOwner(base, resource.target)).catch(() => undefined);
    resources.clear();
  });
}

async function loadOrCreateHostKey(hostKeyPath: string) {
  try { return await readFile(hostKeyPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path.dirname(hostKeyPath), { recursive: true });
    const generated = utils.generateKeyPairSync('ed25519');
    await writeFile(hostKeyPath, generated.private, { mode: 0o600 });
    return Buffer.from(generated.private);
  }
}

function validCredential(username: string, password: string, secret: string) {
  if (!/^[a-f0-9]{8}$/.test(username)) return false;
  const separator = password.indexOf('.');
  if (separator < 1) return false;
  const expiryValue = password.slice(0, separator);
  const signature = password.slice(separator + 1);
  const expiry = Number(expiryValue);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiry) || expiry < now || expiry > now + 3600) return false;
  const expected = createHmac('sha256', secret).update(`${username}:${expiry}`).digest('base64url');
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function resolveTarget(base: string, value: string, allowRoot = true) {
  if (value.includes('\0')) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin invalide.');
  const parts = value.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin hors du serveur.');
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin hors du serveur.');
  if (!allowRoot && target === base) throw sftpError(STATUS.PERMISSION_DENIED, 'Le dossier racine est protégé.');
  return target;
}

async function assertNoSymlink(base: string, target: string, allowMissing = false) {
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw sftpError(STATUS.PERMISSION_DENIED, 'Les liens symboliques sont désactivés.'); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function attributes(info: Stats): Attributes {
  return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) };
}

function longName(name: string, info: Stats) {
  const type = info.isDirectory() ? 'd' : '-';
  return `${type}rw-rw-r-- 1 padock padock ${info.size} ${new Date(info.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')} ${name}`;
}

function remotePath(base: string, target: string) {
  const relative = path.relative(base, target).split(path.sep).join('/');
  return relative ? `/${relative}` : '/';
}

function encodeHandle(id: number) { const handle = Buffer.alloc(4); handle.writeUInt32BE(id); return handle; }
function decodeHandle(handle: Buffer) { if (handle.length !== 4) throw sftpError(STATUS.FAILURE, 'Handle invalide.'); return handle.readUInt32BE(); }
function sftpError(code: number, message: string) { return Object.assign(new Error(message), { sftpCode: code }); }

function mapError(error: unknown) {
  const value = error as NodeJS.ErrnoException & { sftpCode?: number };
  if (value.sftpCode !== undefined) return { code: value.sftpCode, message: value.message };
  if (value.code === 'ENOENT') return { code: STATUS.NO_SUCH_FILE, message: 'Fichier introuvable.' };
  if (value.code === 'EACCES' || value.code === 'EPERM') return { code: STATUS.PERMISSION_DENIED, message: 'Permission refusée.' };
  if (value.code === 'EEXIST' || value.code === 'ENOTEMPTY') return { code: STATUS.FAILURE, message: 'La destination existe déjà ou n’est pas vide.' };
  return { code: STATUS.FAILURE, message: value.message || 'Erreur SFTP.' };
}

async function applyOwner(base: string, target: string) {
  const owner = await stat(base);
  await chown(target, owner.uid, owner.gid).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  });
}
