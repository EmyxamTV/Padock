export interface Server {
  id: string;
  name: string;
  software: 'PAPER' | 'VANILLA' | 'PURPUR' | 'FABRIC' | 'FORGE' | 'NEOFORGE';
  version: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  port: number;
  address?: string;
  domain?: string;
  allocationId: string;
  ownerId: string;
  nodeId: string;
  status: 'running' | 'stopped' | 'missing' | 'starting' | 'installing' | 'unavailable';
  runtime?: {
    status: 'running' | 'stopped' | 'missing' | 'starting' | 'unavailable';
    health?: string;
    exitCode?: number;
    oomKilled?: boolean;
    restartCount?: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  };
  createdAt: string;
}

export interface GatewayStatus {
  enabled: boolean;
  configured: boolean;
  baseDomain?: string;
  publicPort: number;
  wildcard?: string;
  dnsTarget?: string;
  routes: number;
}

export interface NodeRecord {
  id: string;
  name: string;
  location: string;
  url: string;
  online: boolean;
  allocations: { total: number; used: number; free: number };
  health?: {
    hostname: string;
    version: string;
    memory: { total: number; free: number };
    cpu: { cores: number; load: number[] };
  };
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  user?: UserRecord;
}

export interface ServerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskBytes: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export interface BackupEntry {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

export interface ServerSchedule {
  id: string;
  serverId: string;
  name: string;
  intervalMinutes: number;
  action: 'start' | 'stop' | 'restart' | 'command' | 'backup';
  payload?: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastStatus?: 'success' | 'failed';
}

export interface CurseForgeProject {
  id: number;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  updatedAt: string;
  projectType: 'plugin' | 'mod' | 'modpack';
  categories?: string[];
  minecraftVersion?: string;
  recommendedMemoryMb?: number;
  recommendedDiskMb?: number;
}

export interface SftpCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  expiresAt: string;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Erreur HTTP ${response.status}`);
  return body as T;
}

export async function upload(url: string, file: File) {
  const response = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Erreur HTTP ${response.status}`);
  return body as { ok: true };
}
