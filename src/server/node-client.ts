import { Readable } from 'node:stream';
import type { MinecraftServer, NodeRecord, ServerSoftware } from './types.js';

export interface NodeHealth {
  ok: boolean;
  docker: boolean;
  hostname: string;
  version: string;
  memory: { total: number; free: number };
  cpu: { cores: number; load: number[] };
  sftp?: { enabled: boolean; port: number };
  curseForge?: { configured: boolean };
  gateway?: { enabled: boolean; port: number };
}

export interface ServerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskBytes: number;
}

export interface RemoteServerState {
  status: 'running' | 'stopped' | 'missing' | 'starting';
  health?: string;
  exitCode?: number;
  oomKilled?: boolean;
  restartCount?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface RemoteServerPack {
  projectId: number;
  fileId: number;
  url: string;
  filename: string;
  hash: string;
  algorithm: 'sha1' | 'md5';
}

export class NodeClient {
  constructor(private node: NodeRecord) {}

  health() {
    return this.request<NodeHealth>('/v1/health');
  }

  create(input: {
    id: string;
    name: string;
    software: ServerSoftware;
    version: string;
    memoryMb: number;
    cpuPercent: number;
    diskMb: number;
    port: number;
  }, serverPack?: RemoteServerPack) {
    return this.request<{ dockerId: string }>('/v1/servers', { method: 'POST', body: JSON.stringify({ ...input, serverPack }) }, 30 * 60_000);
  }

  status(server: MinecraftServer) {
    return this.state(server).then((result) => result.status);
  }

  state(server: MinecraftServer) { return this.request<RemoteServerState>(`/v1/servers/${server.id}/status`); }
  updateResources(server: MinecraftServer, input: { memoryMb: number; cpuPercent: number; diskMb: number }) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/resources`, { method: 'PUT', body: JSON.stringify(input) }, 60_000); }

  stats(server: MinecraftServer) { return this.request<ServerStats>(`/v1/servers/${server.id}/stats`); }
  files(server: MinecraftServer, relative = '') { return this.request<Array<{ name: string; path: string; type: 'file' | 'directory'; size: number; modifiedAt: string }>>(`/v1/servers/${server.id}/files?path=${encodeURIComponent(relative)}`); }
  readFile(server: MinecraftServer, relative: string) { return this.request<{ content: string }>(`/v1/servers/${server.id}/files/content?path=${encodeURIComponent(relative)}`); }
  writeFile(server: MinecraftServer, relative: string, content: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/files/content`, { method: 'PUT', body: JSON.stringify({ path: relative, content }) }); }
  uploadFile(server: MinecraftServer, relative: string, content: Buffer) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/files/upload?path=${encodeURIComponent(relative)}`, { method: 'PUT', body: Uint8Array.from(content), headers: { 'Content-Type': 'application/octet-stream' } }, 10 * 60_000); }
  downloadFile(server: MinecraftServer, relative: string) { return this.requestBuffer(`/v1/servers/${server.id}/files/download?path=${encodeURIComponent(relative)}`, 10 * 60_000); }
  renameFile(server: MinecraftServer, source: string, destination: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/files/rename`, { method: 'POST', body: JSON.stringify({ source, destination }) }); }
  makeDirectory(server: MinecraftServer, relative: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/files/directory`, { method: 'POST', body: JSON.stringify({ path: relative }) }); }
  deleteFile(server: MinecraftServer, relative: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/files`, { method: 'DELETE', body: JSON.stringify({ path: relative }) }); }
  runtime(server: MinecraftServer) { return this.request<{ minecraftVersion?: string }>(`/v1/servers/${server.id}/runtime`); }
  installedContent(server: MinecraftServer, kind: 'plugin' | 'mod') { return this.request<Array<{ name: string; path: string; size: number; modifiedAt: string }>>(`/v1/servers/${server.id}/content?kind=${kind}`); }
  installContent(server: MinecraftServer, input: { kind: 'plugin' | 'mod'; url: string; filename: string; hash: string; algorithm: 'sha1' | 'md5' }) { return this.request<{ name: string; path: string; size: number }>(`/v1/servers/${server.id}/content/install`, { method: 'POST', body: JSON.stringify(input) }, 30 * 60_000); }
  configureCurseForgeModpack(server: MinecraftServer, serverPack: RemoteServerPack) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/content/modpack`, { method: 'POST', body: JSON.stringify({ software: server.software, version: server.version, serverPack }) }, 30 * 60_000); }
  backups(server: MinecraftServer) { return this.request<Array<{ id: string; name: string; size: number; createdAt: string }>>(`/v1/servers/${server.id}/backups`); }
  createBackup(server: MinecraftServer, name?: string) { return this.request<{ id: string; name: string; size: number; createdAt: string }>(`/v1/servers/${server.id}/backups`, { method: 'POST', body: JSON.stringify({ name }) }, 30 * 60_000); }
  restoreBackup(server: MinecraftServer, backupId: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/backups/${encodeURIComponent(backupId)}/restore`, { method: 'POST' }, 30 * 60_000); }
  deleteBackup(server: MinecraftServer, backupId: string) { return this.request<{ ok: true }>(`/v1/servers/${server.id}/backups/${encodeURIComponent(backupId)}`, { method: 'DELETE' }); }

  action(server: MinecraftServer, action: 'start' | 'stop' | 'restart' | 'kill') {
    return this.request<{ ok: true }>(`/v1/servers/${server.id}/${action}`, { method: 'POST' });
  }

  repair(server: MinecraftServer) {
    return this.request<{ ok: true }>(`/v1/servers/${server.id}/repair`, { method: 'POST', body: JSON.stringify(server) }, 2 * 60_000);
  }

  command(server: MinecraftServer, command: string) {
    return this.request<{ output: string }>(`/v1/servers/${server.id}/command`, { method: 'POST', body: JSON.stringify({ command }) });
  }

  remove(server: MinecraftServer) {
    return this.request<{ ok: true }>(`/v1/servers/${server.id}`, { method: 'DELETE' });
  }

  async logs(server: MinecraftServer, tail = 200) {
    const response = await fetch(this.url(`/v1/servers/${server.id}/logs?tail=${tail}`), { headers: this.headers() });
    if (!response.ok || !response.body) throw new Error(await errorFrom(response));
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  }

  private async request<T>(route: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.node.token}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(this.url(route), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(await errorFrom(response));
    return await response.json() as T;
  }

  private async requestBuffer(route: string, timeoutMs: number) {
    const response = await fetch(this.url(route), { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(await errorFrom(response));
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'download.bin';
    return { content: Buffer.from(await response.arrayBuffer()), name, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private headers() {
    return { Authorization: `Bearer ${this.node.token}` };
  }

  private url(route: string) {
    return `${this.node.url.replace(/\/$/, '')}${route}`;
  }
}

async function errorFrom(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? `Le nœud a répondu HTTP ${response.status}.`;
}
