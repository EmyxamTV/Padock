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
  createdAt: string;
}

export interface NodeRecord {
  id: string;
  name: string;
  location: string;
  url: string;
  token: string;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export type ServerPermission = 'console.read' | 'console.command' | 'power.start' | 'power.stop' | 'power.restart' | 'files.read' | 'files.write' | 'backups.manage' | 'schedules.manage';

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

export interface PanelState {
  /** Ancien format v0.1/v0.2, conservé uniquement pour la migration. */
  user?: UserRecord;
  users: UserRecord[];
  nodes: NodeRecord[];
  servers: MinecraftServer[];
  allocations: Allocation[];
  serverAccess: ServerAccess[];
  schedules: ServerSchedule[];
  auditLogs: AuditEntry[];
}
