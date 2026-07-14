import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chown, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export class ServerFiles {
  constructor(private serversDir: string, private backupsDir: string) {}

  async list(serverId: string, relative = ''): Promise<FileEntry[]> {
    const directory = this.target(serverId, relative);
    await this.assertNotSymlink(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    const result = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map(async (entry) => {
      const target = path.join(directory, entry.name);
      const info = await stat(target);
      return {
        name: entry.name,
        path: this.relative(serverId, target),
        type: entry.isDirectory() ? 'directory' as const : 'file' as const,
        size: entry.isFile() ? info.size : 0,
        modifiedAt: info.mtime.toISOString(),
      };
    }));
    return result.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1);
  }

  async read(serverId: string, relative: string) {
    const target = this.target(serverId, relative);
    await this.assertNotSymlink(target);
    const info = await stat(target);
    if (!info.isFile()) throw httpError(400, 'Ce chemin n’est pas un fichier.');
    if (info.size > 2 * 1024 * 1024) throw httpError(413, 'Ce fichier dépasse la limite d’édition de 2 Mo.');
    return readFile(target, 'utf8');
  }

  async write(serverId: string, relative: string, content: string) {
    const target = this.target(serverId, relative);
    await this.assertSafeParents(serverId, path.dirname(target));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    await this.applyOwnership(serverId, target);
  }

  async writeBuffer(serverId: string, relative: string, content: Buffer) {
    const target = this.target(serverId, relative);
    await this.assertSafeParents(serverId, path.dirname(target));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    await this.applyOwnership(serverId, target);
  }

  async readBuffer(serverId: string, relative: string) {
    const target = this.target(serverId, relative);
    await this.assertNotSymlink(target);
    const info = await stat(target);
    if (!info.isFile()) throw httpError(400, 'Ce chemin n’est pas un fichier.');
    return { content: await readFile(target), size: info.size, name: path.basename(target) };
  }

  async move(serverId: string, source: string, destination: string) {
    if (!source || !destination) throw httpError(400, 'Les chemins source et destination sont obligatoires.');
    const sourceTarget = this.target(serverId, source);
    const destinationTarget = this.target(serverId, destination);
    await this.assertNotSymlink(sourceTarget);
    await this.assertSafeParents(serverId, path.dirname(destinationTarget));
    try { await lstat(destinationTarget); throw httpError(409, 'Un fichier existe déjà à cet emplacement.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(path.dirname(destinationTarget), { recursive: true });
    await rename(sourceTarget, destinationTarget);
  }

  async makeDirectory(serverId: string, relative: string) {
    const target = this.target(serverId, relative);
    await this.assertSafeParents(serverId, path.dirname(target));
    await mkdir(target, { recursive: false });
    await this.applyOwnership(serverId, target);
  }

  async remove(serverId: string, relative: string) {
    if (!relative || relative === '.') throw httpError(400, 'Le dossier racine ne peut pas être supprimé.');
    const target = this.target(serverId, relative);
    await this.assertNotSymlink(target);
    await rm(target, { recursive: true, force: false });
  }

  async listInstalled(serverId: string, kind: 'plugin' | 'mod') {
    const folder = kind === 'plugin' ? 'plugins' : 'mods';
    const directory = this.target(serverId, folder);
    await mkdir(directory, { recursive: true });
    return (await this.list(serverId, folder)).filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.jar'));
  }

  async installRemote(serverId: string, kind: 'plugin' | 'mod', url: string, filename: string, expectedHash: string, algorithm: 'sha1' | 'md5') {
    if (!/^[\w .+()\[\]-]{1,180}\.jar$/i.test(filename)) throw httpError(400, 'Nom de fichier d’extension invalide.');
    const folder = kind === 'plugin' ? 'plugins' : 'mods';
    const target = this.target(serverId, `${folder}/${filename}`);
    await mkdir(path.dirname(target), { recursive: true });
    await this.download(url, target, expectedHash, algorithm, 512 * 1024 * 1024);
    await this.applyOwnership(serverId, target);
    const info = await stat(target);
    return { name: filename, path: `${folder}/${filename}`, size: info.size };
  }

  async installServerPack(serverId: string, fileId: number, url: string, filename: string, expectedHash: string, algorithm: 'sha1' | 'md5') {
    if (!Number.isSafeInteger(fileId) || fileId < 1) throw httpError(400, 'Identifiant de server pack invalide.');
    if (!filename.toLowerCase().endsWith('.zip')) throw httpError(400, 'Le server pack doit être une archive ZIP.');
    const safeName = filename.normalize('NFKD').replace(/[^a-zA-Z0-9._+()-]+/g, '-').replace(/^-+/, '').slice(-180);
    if (!safeName || !safeName.toLowerCase().endsWith('.zip')) throw httpError(400, 'Nom de server pack invalide.');
    await mkdir(this.target(serverId, ''), { recursive: true });
    const relative = `.padock/server-packs/${fileId}-${safeName}`;
    const target = this.target(serverId, relative);
    await this.download(url, target, expectedHash, algorithm, 4 * 1024 * 1024 * 1024);
    await this.applyOwnership(serverId, target);
    const info = await stat(target);
    return { name: filename, path: relative, size: info.size };
  }

  async listBackups(serverId: string) {
    const directory = this.backupDirectory(serverId);
    await mkdir(directory, { recursive: true });
    return Promise.all((await readdir(directory)).filter((name) => name.endsWith('.tar.gz')).map(async (name) => {
      const info = await stat(path.join(directory, name));
      return { id: name, name, size: info.size, createdAt: info.mtime.toISOString() };
    }));
  }

  async createBackup(serverId: string, requestedName?: string) {
    const source = this.target(serverId, '');
    const directory = this.backupDirectory(serverId);
    await mkdir(directory, { recursive: true });
    const label = (requestedName ?? 'backup').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'backup';
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.tar.gz`;
    const destination = path.join(directory, id);
    await tar.c({ gzip: true, cwd: source, file: destination, portable: true }, ['.']);
    const info = await stat(destination);
    return { id, name: id, size: info.size, checksum: await sha256File(destination), createdAt: info.mtime.toISOString() };
  }

  async restoreBackup(serverId: string, backupId: string) {
    const archive = this.backupTarget(serverId, backupId);
    await tar.x({ file: archive, cwd: this.target(serverId, ''), preservePaths: false });
  }

  async deleteBackup(serverId: string, backupId: string) {
    await rm(this.backupTarget(serverId, backupId), { force: false });
  }

  async pruneBackups(serverId: string, retention: number) {
    const items = (await this.listBackups(serverId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const item of items.slice(Math.max(0, retention))) await this.deleteBackup(serverId, item.id);
    return { deleted: Math.max(0, items.length - Math.max(0, retention)) };
  }

  async openBackup(serverId: string, backupId: string) {
    const target = this.backupTarget(serverId, backupId); const info = await stat(target);
    return { stream: createReadStream(target), size: info.size, checksum: await sha256File(target), name: path.basename(target) };
  }

  async writeBackupStream(serverId: string, backupId: string, input: AsyncIterable<Uint8Array>, expectedHash: string, maximumSize = 16 * 1024 * 1024 * 1024) {
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw httpError(400, 'Empreinte de sauvegarde invalide.');
    const destination = this.backupTarget(serverId, backupId); const temporary = `${destination}.upload`;
    await mkdir(path.dirname(destination), { recursive: true }); await rm(temporary, { force: true });
    const output = await open(temporary, 'wx'); const hash = createHash('sha256'); let size = 0;
    try {
      for await (const value of input) { const chunk = Buffer.from(value); size += chunk.length; if (size > maximumSize) throw httpError(413, 'La sauvegarde dépasse la taille autorisée.'); hash.update(chunk); await output.write(chunk); }
    } catch (error) { await output.close(); await rm(temporary, { force: true }); throw error; }
    await output.close();
    if (hash.digest('hex').toLowerCase() !== expectedHash.toLowerCase()) { await rm(temporary, { force: true }); throw httpError(400, 'La sauvegarde transférée est corrompue.'); }
    await rm(destination, { force: true }); await rename(temporary, destination);
    return { id: backupId, name: backupId, size, checksum: expectedHash.toLowerCase(), createdAt: new Date().toISOString() };
  }

  async cloneServer(sourceId: string, destinationId: string) {
    const source = this.target(sourceId, ''); const destination = this.target(destinationId, '');
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, force: true, filter: (item) => !item.includes(`${path.sep}.padock${path.sep}server-packs${path.sep}`) || item.endsWith('.zip') });
    await this.applyOwnership(destinationId, destination);
  }

  async deleteServerData(serverId: string) { await rm(this.target(serverId, ''), { recursive: true, force: true }); }

  private target(serverId: string, relative: string) {
    if (!/^[a-f0-9]{8}$/.test(serverId)) throw httpError(400, 'Identifiant de serveur invalide.');
    if (relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw httpError(400, 'Chemin invalide.');
    const base = path.resolve(this.serversDir, serverId);
    const target = path.resolve(base, relative || '.');
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'Chemin hors du serveur.');
    return target;
  }

  private relative(serverId: string, target: string) {
    return path.relative(this.target(serverId, ''), target).split(path.sep).join('/');
  }

  private backupDirectory(serverId: string) {
    if (!/^[a-f0-9]{8}$/.test(serverId)) throw httpError(400, 'Identifiant de serveur invalide.');
    return path.resolve(this.backupsDir, serverId);
  }

  private backupTarget(serverId: string, backupId: string) {
    if (!/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(backupId)) throw httpError(400, 'Sauvegarde invalide.');
    return path.join(this.backupDirectory(serverId), backupId);
  }

  private async assertNotSymlink(target: string) {
    try { if ((await lstat(target)).isSymbolicLink()) throw httpError(400, 'Les liens symboliques ne sont pas autorisés.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async assertSafeParents(serverId: string, directory: string) {
    const base = this.target(serverId, '');
    let current = directory;
    while (current !== base && current.startsWith(base)) {
      await this.assertNotSymlink(current);
      current = path.dirname(current);
    }
  }

  private async applyOwnership(serverId: string, target: string) {
    const owner = await stat(this.target(serverId, ''));
    await chown(target, owner.uid, owner.gid).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    });
  }

  private async download(urlValue: string, destination: string, expectedHash: string, algorithm: 'sha1' | 'md5', maximumSize: number) {
    const url = new URL(urlValue);
    if (url.protocol !== 'https:' || !allowedCurseForgeHost(url.hostname)) throw httpError(400, 'La source de téléchargement n’est pas autorisée.');
    const expectedLength = algorithm === 'sha1' ? 40 : 32;
    if (!new RegExp(`^[a-f0-9]{${expectedLength}}$`, 'i').test(expectedHash)) throw httpError(400, 'Empreinte de fichier invalide.');
    await mkdir(path.dirname(destination), { recursive: true });
    if (await fileMatchesHash(destination, expectedHash, algorithm)) return;
    const temporary = `${destination}.padock-download`;
    await rm(temporary, { force: true });
    const response = await fetch(url, { headers: { 'User-Agent': 'Padock/1.0.0 (server manager)' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw httpError(502, `Téléchargement impossible (HTTP ${response.status}).`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maximumSize) throw httpError(413, 'Le fichier distant dépasse la taille autorisée.');
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || !allowedCurseForgeHost(finalUrl.hostname)) throw httpError(400, 'La redirection de téléchargement n’est pas autorisée.');

    const output = await open(temporary, 'wx');
    const hash = createHash(algorithm);
    let received = 0;
    try {
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maximumSize) throw httpError(413, 'Le fichier distant dépasse la taille autorisée.');
        hash.update(chunk);
        await output.write(chunk);
      }
    } catch (error) {
      await output.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await output.close();
    if (hash.digest('hex').toLowerCase() !== expectedHash.toLowerCase()) {
      await rm(temporary, { force: true });
      throw httpError(400, 'L’empreinte du fichier téléchargé ne correspond pas à CurseForge.');
    }
    await rm(destination, { force: true });
    await rename(temporary, destination);
  }
}

async function fileMatchesHash(file: string, expectedHash: string, algorithm: 'sha1' | 'md5') {
  const hash = createHash(algorithm);
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex').toLowerCase() === expectedHash.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(file: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function allowedCurseForgeHost(hostname: string) { return hostname === 'media.forgecdn.net' || hostname === 'mediafilez.forgecdn.net' || hostname === 'edge.forgecdn.net' || hostname.endsWith('.forgecdn.net'); }
