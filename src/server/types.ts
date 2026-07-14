export type ServerSoftware = 'PAPER' | 'VANILLA' | 'PURPUR' | 'FABRIC' | 'FORGE' | 'NEOFORGE';

export interface MinecraftServer {
  id: string;
  name: string;
  software: ServerSoftware;
  version: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  port: number;
  nodeId: string;
  allocationId: string;
  ownerId: string;
  domain?: string;
  crashPolicy: CrashPolicy;
  backupPolicy: BackupPolicy;
  createdAt: string;
}

export interface CrashPolicy {
  enabled: boolean;
  maxRestarts: number;
  windowMinutes: number;
  cooldownMinutes: number;
}

export interface BackupPolicy {
  retention: number;
  remoteEnabled: boolean;
}

export interface NodeRecord {
  id: string;
  name: string;
  location: string;
  url: string;
  token: string;
  maintenance: boolean;
  maintenanceMessage?: string;
  maxMemoryMb?: number;
  maxDiskMb?: number;
  createdAt: string;
}

export interface UserQuota {
  maxServers: number;
  maxMemoryMb: number;
  maxDiskMb: number;
  maxBackups: number;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  roleId?: string;
  groupIds: string[];
  permissions: PanelPermission[];
  quota: UserQuota;
  twoFactorSecret?: string;
  twoFactorEnabled: boolean;
  recoveryCodeHashes: string[];
  emailVerified: boolean;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface UserGroup {
  id: string;
  name: string;
  description: string;
  permissions: PanelPermission[];
  serverPermissions: ServerPermission[];
  createdAt: string;
  updatedAt: string;
}

export type PanelPermission = 'servers.create' | 'servers.manage_all' | 'nodes.view' | 'nodes.manage' | 'users.manage' | 'audit.view';

export interface PanelRole {
  id: string;
  name: string;
  description: string;
  permissions: PanelPermission[];
  createdAt: string;
  updatedAt: string;
}

export type ServerPermission =
  | 'console.read' | 'console.command'
  | 'power.start' | 'power.stop' | 'power.restart'
  | 'files.read' | 'files.write' | 'content.manage'
  | 'settings.manage' | 'backups.manage' | 'schedules.manage'
  | 'sftp.manage' | 'members.manage' | 'server.delete';

export interface ServerAccess {
  serverId: string;
  userId: string;
  permissions: ServerPermission[];
}

export interface Allocation {
  id: string;
  nodeId: string;
  ip: string;
  port: number;
  alias?: string;
  serverId?: string;
  reservationId?: string;
}

export interface AuditEntry {
  id: string;
  userId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata: Record<string, unknown>;
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
  createdAt: string;
}

export interface SftpAccount {
  id: string;
  serverId: string;
  username: string;
  passwordHash: string;
  salt: string;
  paths: string[];
  readOnly: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type JobKind = 'server.create' | 'server.clone' | 'server.transfer' | 'server.repair' | 'server.upgrade' | 'backup.create' | 'backup.restore' | 'content.modpack';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PanelJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  step: string;
  payload: Record<string, unknown>;
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

export interface MetricSample {
  id: string;
  serverId: string;
  status: 'running' | 'stopped' | 'missing' | 'starting' | 'unavailable';
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskBytes: number;
  playersOnline?: number;
  playersMax?: number;
  createdAt: string;
}

export interface UserSession {
  id: string;
  userId: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  secretHash: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface CrashEvent {
  id: string;
  serverId: string;
  reason: string;
  createdAt: string;
}

export interface AccountToken {
  id: string;
  userId: string;
  type: 'password_reset' | 'email_verification';
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface ServerTemplate {
  id: string;
  name: string;
  description: string;
  software: ServerSoftware;
  version: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PanelState {
  /** Ancien format v0.1/v0.2, conservé uniquement pour la migration. */
  user?: UserRecord;
  users: UserRecord[];
  groups: UserGroup[];
  roles: PanelRole[];
  nodes: NodeRecord[];
  servers: MinecraftServer[];
  allocations: Allocation[];
  serverAccess: ServerAccess[];
  schedules: ServerSchedule[];
  sftpAccounts: SftpAccount[];
  jobs: PanelJob[];
  notifications: PanelNotification[];
  metrics: MetricSample[];
  sessions: UserSession[];
  apiKeys: ApiKeyRecord[];
  crashEvents: CrashEvent[];
  accountTokens: AccountToken[];
  templates: ServerTemplate[];
  auditLogs: AuditEntry[];
}
