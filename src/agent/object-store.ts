import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { padockEnv } from './config.js';

export class BackupObjectStore {
  readonly bucket = padockEnv('S3_BUCKET')?.trim();
  readonly prefix = (padockEnv('S3_PREFIX')?.trim() || 'padock/backups').replace(/^\/+|\/+$/g, '');
  private readonly client?: S3Client;

  constructor() {
    const accessKeyId = padockEnv('S3_ACCESS_KEY')?.trim(); const secretAccessKey = padockEnv('S3_SECRET_KEY')?.trim();
    if (!this.bucket || !accessKeyId || !secretAccessKey) return;
    this.client = new S3Client({
      region: padockEnv('S3_REGION')?.trim() || 'auto', endpoint: padockEnv('S3_ENDPOINT')?.trim() || undefined,
      forcePathStyle: padockEnv('S3_FORCE_PATH_STYLE') === 'true', credentials: { accessKeyId, secretAccessKey },
    });
  }

  get configured() { return Boolean(this.client && this.bucket); }

  async upload(serverId: string, backupId: string, body: import('node:stream').Readable, size: number, checksum: string) {
    this.assertConfigured();
    await this.client!.send(new PutObjectCommand({ Bucket: this.bucket!, Key: this.key(serverId, backupId), Body: body, ContentLength: size, ContentType: 'application/gzip', Metadata: { sha256: checksum } }));
    return { remote: true };
  }

  async download(serverId: string, backupId: string) {
    this.assertConfigured();
    const response = await this.client!.send(new GetObjectCommand({ Bucket: this.bucket!, Key: this.key(serverId, backupId) }));
    const checksum = response.Metadata?.sha256; const body = response.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body || !checksum) throw new Error('La sauvegarde distante ne contient pas de flux ou d’empreinte SHA-256.');
    return { body, checksum };
  }

  async exists(serverId: string, backupId: string) {
    if (!this.configured) return false;
    try { await this.client!.send(new HeadObjectCommand({ Bucket: this.bucket!, Key: this.key(serverId, backupId) })); return true; }
    catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false; throw error; }
  }

  async list(serverId: string) {
    if (!this.configured) return [];
    const prefix = `${this.prefix}/${serverId}/`; const response = await this.client!.send(new ListObjectsV2Command({ Bucket: this.bucket!, Prefix: prefix }));
    return (response.Contents ?? []).filter((item) => item.Key?.endsWith('.tar.gz')).map((item) => ({ id: item.Key!.slice(prefix.length), name: item.Key!.slice(prefix.length), size: item.Size ?? 0, createdAt: item.LastModified?.toISOString() ?? new Date(0).toISOString(), remote: true }));
  }

  async delete(serverId: string, backupId: string) { if (this.configured) await this.client!.send(new DeleteObjectCommand({ Bucket: this.bucket!, Key: this.key(serverId, backupId) })); }
  private key(serverId: string, backupId: string) { if (!/^[a-f0-9]{8}$/.test(serverId) || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(backupId)) throw new Error('Identifiant de sauvegarde distant invalide.'); return `${this.prefix}/${serverId}/${backupId}`; }
  private assertConfigured() { if (!this.configured) throw Object.assign(new Error('Le stockage S3 n’est pas configuré sur ce nœud.'), { statusCode: 409 }); }
}
