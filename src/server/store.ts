import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Allocation, AuditEntry, MinecraftServer, NodeRecord, PanelState, ServerAccess, ServerSchedule, UserRecord } from './types.js';

const { Pool } = pg;

export class Store {
  private state: PanelState = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private readonly pool?: pg.Pool;
  readonly file: string;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'panel.json');
    if (process.env.DATABASE_URL) this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    const legacy = await this.loadJson();
    if (!this.pool) {
      this.state = normalize(legacy);
      await this.saveJson();
      return;
    }

    await this.migrateDatabase();
    const count = await this.pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    if (Number(count.rows[0]?.count ?? 0) === 0 && hasData(legacy)) {
      this.state = normalize(legacy);
      await this.savePostgres();
    } else {
      this.state = await this.loadPostgres();
    }
  }

  get snapshot(): PanelState {
    return structuredClone(this.state);
  }

  async update(mutator: (draft: PanelState) => void) {
    const draft = structuredClone(this.state);
    mutator(draft);
    const previous = this.state;
    this.state = draft;
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
  }

  private async loadJson(): Promise<Partial<PanelState>> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as Partial<PanelState>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return {}; }
  }

  private async save() {
    this.queue = this.queue.catch(() => undefined).then(() => this.pool ? this.savePostgres() : this.saveJson());
    return this.queue;
  }

  private async saveJson() {
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async migrateDatabase() {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, role text NOT NULL,
        password_hash text NOT NULL, salt text NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id text PRIMARY KEY, name text NOT NULL, location text NOT NULL, url text NOT NULL,
        token text NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS servers (
        id text PRIMARY KEY, name text NOT NULL, software text NOT NULL, version text NOT NULL,
        memory_mb integer NOT NULL, cpu_percent integer NOT NULL, disk_mb integer NOT NULL, port integer NOT NULL,
        node_id text NOT NULL REFERENCES nodes(id), allocation_id text NOT NULL,
        owner_id text NOT NULL REFERENCES users(id), domain text, created_at timestamptz NOT NULL
      );
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS domain text;
      CREATE TABLE IF NOT EXISTS allocations (
        id text PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, ip text NOT NULL,
        port integer NOT NULL, alias text, server_id text UNIQUE REFERENCES servers(id) ON DELETE SET NULL,
        UNIQUE(node_id, ip, port)
      );
      CREATE TABLE IF NOT EXISTS server_access (
        server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permissions jsonb NOT NULL DEFAULT '[]', PRIMARY KEY(server_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id text PRIMARY KEY, server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name text NOT NULL, interval_minutes integer NOT NULL, action text NOT NULL, payload text,
        enabled boolean NOT NULL DEFAULT true, next_run_at timestamptz NOT NULL,
        last_run_at timestamptz, last_status text, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL,
        target_type text NOT NULL, target_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS servers_owner_idx ON servers(owner_id);
      CREATE INDEX IF NOT EXISTS servers_node_idx ON servers(node_id);
      CREATE UNIQUE INDEX IF NOT EXISTS servers_domain_unique_idx ON servers(lower(domain)) WHERE domain IS NOT NULL;
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
    `);
  }

  private async loadPostgres(): Promise<PanelState> {
    const [users, nodes, servers, allocations, access, schedules, audit] = await Promise.all([
      this.pool!.query('SELECT * FROM users ORDER BY created_at'),
      this.pool!.query('SELECT * FROM nodes ORDER BY created_at'),
      this.pool!.query('SELECT * FROM servers ORDER BY created_at'),
      this.pool!.query('SELECT * FROM allocations ORDER BY node_id, port'),
      this.pool!.query('SELECT * FROM server_access'),
      this.pool!.query('SELECT * FROM schedules ORDER BY created_at'),
      this.pool!.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000'),
    ]);
    return {
      users: users.rows.map((row) => ({ id: row.id, username: row.username, email: row.email, role: row.role, passwordHash: row.password_hash, salt: row.salt, createdAt: date(row.created_at) })) as UserRecord[],
      nodes: nodes.rows.map((row) => ({ id: row.id, name: row.name, location: row.location, url: row.url, token: row.token, createdAt: date(row.created_at) })) as NodeRecord[],
      servers: servers.rows.map((row) => ({ id: row.id, name: row.name, software: row.software, version: row.version, memoryMb: row.memory_mb, cpuPercent: row.cpu_percent, diskMb: row.disk_mb, port: row.port, nodeId: row.node_id, allocationId: row.allocation_id, ownerId: row.owner_id, domain: row.domain ?? undefined, createdAt: date(row.created_at) })) as MinecraftServer[],
      allocations: allocations.rows.map((row) => ({ id: row.id, nodeId: row.node_id, ip: row.ip, port: row.port, alias: row.alias ?? undefined, serverId: row.server_id ?? undefined })) as Allocation[],
      serverAccess: access.rows.map((row) => ({ serverId: row.server_id, userId: row.user_id, permissions: row.permissions })) as ServerAccess[],
      schedules: schedules.rows.map((row) => ({ id: row.id, serverId: row.server_id, name: row.name, intervalMinutes: row.interval_minutes, action: row.action, payload: row.payload ?? undefined, enabled: row.enabled, nextRunAt: date(row.next_run_at), lastRunAt: row.last_run_at ? date(row.last_run_at) : undefined, lastStatus: row.last_status ?? undefined, createdAt: date(row.created_at) })) as ServerSchedule[],
      auditLogs: audit.rows.map((row) => ({ id: row.id, userId: row.user_id ?? undefined, action: row.action, targetType: row.target_type, targetId: row.target_id ?? undefined, metadata: row.metadata, createdAt: date(row.created_at) })) as AuditEntry[],
    };
  }

  private async savePostgres() {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const user of this.state.users) await client.query(
        `INSERT INTO users VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET username=$2,email=$3,role=$4,password_hash=$5,salt=$6`,
        [user.id, user.username, user.email, user.role, user.passwordHash, user.salt, user.createdAt]);
      for (const node of this.state.nodes) await client.query(
        `INSERT INTO nodes VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=$2,location=$3,url=$4,token=$5`,
        [node.id, node.name, node.location, node.url, node.token, node.createdAt]);
      for (const server of this.state.servers) await client.query(
        `INSERT INTO servers (id,name,software,version,memory_mb,cpu_percent,disk_mb,port,node_id,allocation_id,owner_id,domain,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO UPDATE SET name=$2,software=$3,version=$4,memory_mb=$5,cpu_percent=$6,disk_mb=$7,port=$8,node_id=$9,allocation_id=$10,owner_id=$11,domain=$12`,
        [server.id, server.name, server.software, server.version, server.memoryMb, server.cpuPercent, server.diskMb, server.port, server.nodeId, server.allocationId, server.ownerId, server.domain ?? null, server.createdAt]);
      for (const allocation of this.state.allocations) await client.query(
        `INSERT INTO allocations (id,node_id,ip,port,alias,server_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET node_id=$2,ip=$3,port=$4,alias=$5,server_id=$6`,
        [allocation.id, allocation.nodeId, allocation.ip, allocation.port, allocation.alias ?? null, allocation.serverId ?? null]);
      await client.query('DELETE FROM server_access');
      for (const item of this.state.serverAccess) await client.query('INSERT INTO server_access VALUES ($1,$2,$3)', [item.serverId, item.userId, JSON.stringify(item.permissions)]);
      for (const schedule of this.state.schedules) await client.query(
        `INSERT INTO schedules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET name=$3,interval_minutes=$4,action=$5,payload=$6,enabled=$7,next_run_at=$8,last_run_at=$9,last_status=$10`,
        [schedule.id, schedule.serverId, schedule.name, schedule.intervalMinutes, schedule.action, schedule.payload ?? null, schedule.enabled, schedule.nextRunAt, schedule.lastRunAt ?? null, schedule.lastStatus ?? null, schedule.createdAt]);
      for (const entry of this.state.auditLogs) await client.query(
        `INSERT INTO audit_logs VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [entry.id, entry.userId ?? null, entry.action, entry.targetType, entry.targetId ?? null, JSON.stringify(entry.metadata), entry.createdAt]);
      await client.query('DELETE FROM allocations WHERE id <> ALL($1::text[])', [this.state.allocations.map((item) => item.id)]);
      await client.query('DELETE FROM schedules WHERE id <> ALL($1::text[])', [this.state.schedules.map((item) => item.id)]);
      await client.query('DELETE FROM servers WHERE id <> ALL($1::text[])', [this.state.servers.map((item) => item.id)]);
      await client.query('DELETE FROM nodes WHERE id <> ALL($1::text[])', [this.state.nodes.map((item) => item.id)]);
      await client.query('DELETE FROM users WHERE id <> ALL($1::text[])', [this.state.users.map((item) => item.id)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

function emptyState(): PanelState { return { users: [], nodes: [], servers: [], allocations: [], serverAccess: [], schedules: [], auditLogs: [] }; }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function hasData(raw: Partial<PanelState>) { return Boolean(raw.user || raw.users?.length || raw.nodes?.length || raw.servers?.length); }

function normalize(raw: Partial<PanelState>): PanelState {
  const legacyUser = raw.user as Partial<UserRecord> | undefined;
  const users = (raw.users?.length ? raw.users : legacyUser ? [legacyUser as UserRecord] : []).map((user, index) => ({
    id: user.id ?? (index === 0 ? 'legacy-admin' : randomUUID().slice(0, 8)), username: user.username,
    email: user.email ?? `${user.username}@padock.local`, role: user.role ?? (index === 0 ? 'admin' : 'user'),
    passwordHash: user.passwordHash, salt: user.salt, createdAt: user.createdAt ?? new Date().toISOString(),
  })) as UserRecord[];
  const nodes = raw.nodes ?? [];
  const ownerId = users[0]?.id ?? '';
  const allocations: Allocation[] = raw.allocations ?? (raw.servers ?? []).map((server) => ({
    id: `legacy-${server.id}`, nodeId: server.nodeId ?? nodes[0]?.id ?? 'local001', ip: '0.0.0.0', port: server.port, serverId: server.id,
  }));
  const servers = (raw.servers ?? []).map((server) => ({
    ...server, nodeId: server.nodeId ?? nodes[0]?.id ?? 'local001', ownerId: server.ownerId ?? ownerId,
    allocationId: server.allocationId ?? `legacy-${server.id}`, cpuPercent: server.cpuPercent ?? 100, diskMb: server.diskMb ?? 10240,
  }));
  return { users, nodes, servers, allocations, serverAccess: raw.serverAccess ?? [], schedules: raw.schedules ?? [], auditLogs: raw.auditLogs ?? [] };
}
