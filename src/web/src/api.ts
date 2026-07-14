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
  permissions: ServerPermission[];
  status: 'running' | 'stopped' | 'missing' | 'starting' | 'installing' | 'failed' | 'unavailable';
  crashPolicy: { enabled: boolean; maxRestarts: number; windowMinutes: number; cooldownMinutes: number };
  backupPolicy: { retention: number; remoteEnabled: boolean };
  activeJob?: PanelJob;
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
  maintenance: boolean;
  maintenanceMessage?: string;
  maxMemoryMb?: number;
  maxDiskMb?: number;
  allocations: { total: number; used: number; reserved?: number; free: number };
  capacity?: { memoryMb: number; diskMb: number; maxMemoryMb?: number; maxDiskMb?: number; serverCount: number };
  health?: {
    hostname: string;
    version: string;
    memory: { total: number; free: number };
    cpu: { cores: number; load: number[] };
    backups?: { remoteConfigured: boolean };
  };
}

export interface NetworkAllocation {
  id: string;
  nodeId: string;
  ip: string;
  port: number;
  alias?: string;
  serverId?: string;
  reservationId?: string;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  roleId?: string;
  customRole?: { id: string; name: string };
  groupIds: string[];
  groups: Array<{ id: string; name: string }>;
  permissions: PanelPermission[];
  directPermissions: PanelPermission[];
  quota: { maxServers: number; maxMemoryMb: number; maxDiskMb: number; maxBackups: number };
  twoFactorEnabled: boolean;
  recoveryCodesRemaining: number;
  emailVerified: boolean;
  createdAt: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  permissions: PanelPermission[];
  serverPermissions: ServerPermission[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PanelRole {
  id: string;
  name: string;
  description: string;
  permissions: PanelPermission[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserDirectoryEntry {
  id: string;
  username: string;
}

export type PanelPermission = 'servers.create' | 'servers.manage_all' | 'nodes.view' | 'nodes.manage' | 'users.manage' | 'audit.view';

export type ServerPermission =
  | 'console.read' | 'console.command'
  | 'power.start' | 'power.stop' | 'power.restart'
  | 'files.read' | 'files.write' | 'content.manage'
  | 'settings.manage' | 'backups.manage' | 'schedules.manage'
  | 'sftp.manage' | 'members.manage' | 'server.delete';

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
  checksum?: string;
  local?: boolean;
  remote?: boolean;
}

export interface PanelJob {
  id: string;
  kind: 'server.create' | 'server.clone' | 'server.transfer' | 'server.repair' | 'server.upgrade' | 'backup.create' | 'backup.restore' | 'content.modpack';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  step: string;
  result?: Record<string, unknown>;
  error?: string;
  attempts: number;
  maxAttempts: number;
  userId?: string;
  serverId?: string;
  nodeId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface PanelNotification {
  id: string;
  userId?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  link?: string;
  readAt?: string;
  createdAt: string;
}

export interface MetricSample extends ServerStats {
  id: string;
  serverId: string;
  status: 'running' | 'stopped' | 'missing' | 'starting' | 'unavailable';
  playersOnline?: number;
  playersMax?: number;
  createdAt: string;
}

export interface UserSession {
  id: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  software: Server['software'];
  version: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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

export interface SftpAccount {
  id: string;
  serverId: string;
  username: string;
  paths: string[];
  readOnly: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SftpAccountsResponse {
  host: string;
  port: number;
  enabled: boolean;
  accounts: SftpAccount[];
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
