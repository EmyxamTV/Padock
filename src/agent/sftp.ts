import { scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import type { Attributes, SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;
const scrypt = promisify(nodeScrypt);

const STATUS = utils.sftp.STATUS_CODE;

type OpenResource =
  | { type: 'file'; file: FileHandle; target: string; writable: boolean }
  | { type: 'directory'; entries: Array<{ filename: string; longname: string; attrs: Attributes }>; offset: number };

export interface AgentSftpAccount {
  id: string;
  serverId: string;
  username: string;
  passwordHash: string;
  salt: string;
  paths: string[];
  readOnly: boolean;
  enabled: boolean;
}

interface SftpAccessPolicy { paths: string[]; readOnly: boolean }

export class SftpAccountRegistry {
  private accounts = new Map<string, AgentSftpAccount>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load() {
    try {
      const values = JSON.parse(await readFile(this.file, 'utf8')) as AgentSftpAccount[];
      this.accounts = new Map(values.map((account) => [account.id, normalizeAccount(account)]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save();
    }
  }

  list(serverId?: string) {
    return [...this.accounts.values()].filter((account) => !serverId || account.serverId === serverId).map((account) => ({ ...account, paths: [...account.paths] }));
  }

  async upsert(input: AgentSftpAccount) {
    const account = normalizeAccount(input);
    const duplicate = [...this.accounts.values()].find((item) => item.id !== account.id && item.username.toLowerCase() === account.username.toLowerCase());
    if (duplicate) throw new Error('Ce nom d’utilisateur SFTP est déjà utilisé sur ce nœud.');
    this.accounts.set(account.id, account);
    await this.save();
    return { ...account, paths: [...account.paths] };
  }

  async remove(id: string) {
    this.accounts.delete(id);
    await this.save();
  }

  async removeServer(serverId: string) {
    for (const [id, account] of this.accounts) if (account.serverId === serverId) this.accounts.delete(id);
    await this.save();
  }

  async authenticate(username: string, password: string) {
    const account = [...this.accounts.values()].find((item) => item.enabled && item.username.toLowerCase() === username.toLowerCase());
    if (!account || !(await verifyPassword(password, account.salt, account.passwordHash))) return undefined;
    return { ...account, paths: [...account.paths] };
  }

  private async save() {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.accounts.values()], null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.queue;
  }
}

export async function startSftpServer(options: {
  host: string;
  port: number;
  serversDir: string;
  accounts: SftpAccountRegistry;
  hostKeyPath: string;
  log: (message: string) => void;
}) {
  const hostKey = await loadOrCreateHostKey(options.hostKeyPath);
  const server = new Server({ hostKeys: [hostKey], ident: 'SSH-2.0-Padock_SFTP_1.1.0' }, (client, info) => {
    let account: AgentSftpAccount | undefined;

    client.on('authentication', (context) => {
      if (context.method !== 'password') {
        context.reject(['password']); return;
      }
      void options.accounts.authenticate(context.username, context.password).then(async (authenticated) => {
        if (!authenticated) return context.reject(['password']);
        const info = await stat(path.join(options.serversDir, authenticated.serverId));
        if (!info.isDirectory()) return context.reject(['password']);
        account = authenticated;
        context.accept();
      }).catch(() => context.reject(['password']));
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => {
          if (!account) return;
          serveSftp(acceptSftp(), path.resolve(options.serversDir, account.serverId), { paths: account.paths, readOnly: account.readOnly });
        });
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

function serveSftp(sftp: SFTPWrapper, base: string, access: SftpAccessPolicy) {
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
    assertReadAccess(base, target, access);
    await assertNoSymlink(base, target);
    const info = await stat(target);
    const filename = remotePath(base, target);
    sftp.name(requestId, [{ filename, longname: longName(path.basename(filename) || '/', info), attrs: attributes(info) }]);
  }));

  const sendStat = (requestId: number, requestedPath: string) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    assertReadAccess(base, target, access);
    await assertNoSymlink(base, target);
    sftp.attrs(requestId, attributes(await stat(target)));
  });
  sftp.on('STAT', sendStat);
  sftp.on('LSTAT', sendStat);

  sftp.on('OPENDIR', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    assertReadAccess(base, target, access);
    await assertNoSymlink(base, target);
    const entries = await Promise.all((await readdir(target, { withFileTypes: true }))
      .filter((entry) => !entry.isSymbolicLink() && hasReadAccess(base, path.join(target, entry.name), access))
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
    const mode = utils.sftp.flagsToString(flags);
    if (!mode) throw sftpError(STATUS.BAD_MESSAGE, 'Mode d’ouverture invalide.');
    const writable = /[wa+]/.test(mode);
    if (writable) assertWriteAccess(base, target, access);
    else assertReadAccess(base, target, access);
    await assertNoSymlink(base, target, true);
    if (writable) await mkdir(path.dirname(target), { recursive: true });
    const file = await open(target, mode, attrs.mode ? attrs.mode & 0o777 : 0o664);
    const handleId = nextHandle++;
    resources.set(handleId, { type: 'file', file, target, writable });
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
    if (!resource || resource.type !== 'file' || !resource.writable) throw sftpError(STATUS.PERMISSION_DENIED, 'Fichier ouvert en lecture seule.');
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
    if (!resource || resource.type !== 'file' || !resource.writable) throw sftpError(STATUS.PERMISSION_DENIED, 'Fichier ouvert en lecture seule.');
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
    if (resource.type === 'file') { await resource.file.close(); if (resource.writable) await applyOwner(base, resource.target); }
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('MKDIR', (requestId, requestedPath, attrs) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    assertWriteAccess(base, target, access, true);
    await assertNoSymlink(base, target, true);
    await mkdir(target, { mode: attrs.mode ? attrs.mode & 0o777 : 0o775 });
    await applyOwner(base, target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('REMOVE', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath, false);
    assertWriteAccess(base, target, access, true);
    await assertNoSymlink(base, target);
    await unlink(target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('RMDIR', (requestId, requestedPath) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath, false);
    assertWriteAccess(base, target, access, true);
    await assertNoSymlink(base, target);
    await rmdir(target);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('RENAME', (requestId, oldPath, newPath) => respond(requestId, async () => {
    const source = resolveTarget(base, oldPath, false);
    const destination = resolveTarget(base, newPath, false);
    assertWriteAccess(base, source, access, true);
    assertWriteAccess(base, destination, access, true);
    await assertNoSymlink(base, source);
    await assertNoSymlink(base, destination, true);
    await rename(source, destination);
    sftp.status(requestId, STATUS.OK);
  }));

  sftp.on('SETSTAT', (requestId, requestedPath, attrs) => respond(requestId, async () => {
    const target = resolveTarget(base, requestedPath);
    assertWriteAccess(base, target, access, true);
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
    for (const resource of resources.values()) if (resource.type === 'file') void resource.file.close().then(() => resource.writable ? applyOwner(base, resource.target) : undefined).catch(() => undefined);
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

function resolveTarget(base: string, value: string, allowRoot = true) {
  if (value.includes('\0')) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin invalide.');
  const parts = value.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  if (parts.includes('..')) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin hors du serveur.');
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw sftpError(STATUS.PERMISSION_DENIED, 'Chemin hors du serveur.');
  if (!allowRoot && target === base) throw sftpError(STATUS.PERMISSION_DENIED, 'Le dossier racine est protégé.');
  return target;
}

function hasReadAccess(base: string, target: string, access: SftpAccessPolicy) {
  const relative = relativePath(base, target);
  if (!relative) return true;
  return access.paths.includes('.') || access.paths.some((allowed) => relative === allowed || relative.startsWith(`${allowed}/`) || allowed.startsWith(`${relative}/`));
}

function assertReadAccess(base: string, target: string, access: SftpAccessPolicy) {
  if (!hasReadAccess(base, target, access)) throw sftpError(STATUS.PERMISSION_DENIED, 'Ce compte n’a pas accès à ce dossier.');
}

function assertWriteAccess(base: string, target: string, access: SftpAccessPolicy, protectAllowedRoot = false) {
  if (access.readOnly) throw sftpError(STATUS.PERMISSION_DENIED, 'Ce compte est en lecture seule.');
  const relative = relativePath(base, target);
  const allowed = access.paths.find((item) => item === '.' || relative === item || relative.startsWith(`${item}/`));
  if (!relative || !allowed || (protectAllowedRoot && allowed !== '.' && relative === allowed)) {
    throw sftpError(STATUS.PERMISSION_DENIED, 'Ce compte ne peut pas modifier ce dossier.');
  }
}

function relativePath(base: string, target: string) {
  return path.relative(base, target).split(path.sep).filter(Boolean).join('/');
}

function normalizeAccount(account: AgentSftpAccount): AgentSftpAccount {
  const paths = [...new Set(account.paths.map(normalizeAllowedPath))];
  return { ...account, username: account.username.trim().toLowerCase(), paths: paths.includes('.') ? ['.'] : paths };
}

function normalizeAllowedPath(value: string) {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized === '.') return '.';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.includes('.') || parts.includes('..')) throw new Error('Chemin SFTP invalide.');
  return parts.join('/');
}

async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
