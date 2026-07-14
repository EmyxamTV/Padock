import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AccountToken, Allocation, ApiKeyRecord, AuditEntry, CrashEvent, MinecraftServer, MetricSample, NodeRecord, PanelJob, PanelNotification, PanelRole, PanelState, ServerAccess, ServerSchedule, ServerTemplate, SftpAccount, UserGroup, UserRecord, UserSession } from './types.js';
import { decryptSecret, encryptSecret } from './secrets.js';

const { Pool } = pg;

export class Store {
  private state: PanelState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pool?: pg.Pool;
  private leaderClient?: pg.PoolClient;
  private leadershipAttempt?: Promise<boolean>;
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

  async tryBecomeLeader() {
    if (!this.pool) return true;
    if (this.leaderClient) return true;
    if (this.leadershipAttempt) return this.leadershipAttempt;
    this.leadershipAttempt = (async () => {
      const client = await this.pool!.connect();
      try {
        const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('padock-background-worker')) AS acquired");
        if (result.rows[0]?.acquired) { this.leaderClient = client; client.on('error', () => { this.leaderClient = undefined; }); return true; }
        client.release(); return false;
      } catch (error) { client.release(); throw error; }
      finally { this.leadershipAttempt = undefined; }
    })();
    return this.leadershipAttempt;
  }

  async update(mutator: (draft: PanelState) => void) {
    await this.transaction((draft) => mutator(draft));
  }

  /** Sérialise la mutation complète, pas uniquement l'écriture disque. */
  async transaction<T>(mutator: (draft: PanelState) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.state);
      try {
        const value = await mutator(draft);
        const previous = this.state;
        this.state = draft;
        try { await this.persist(); }
        catch (error) { this.state = previous; throw error; }
        resolveResult(value);
      } catch (error) { rejectResult(error); }
    });
    return result;
  }

  private async loadJson(): Promise<Partial<PanelState>> {
    try { return JSON.parse(await readFile(this.file, 'utf8')) as Partial<PanelState>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return {}; }
  }

  private async persist() { return this.pool ? this.savePostgres() : this.saveJson(); }

  private async saveJson() {
    const temporary = `${this.file}.tmp`;
    const secured = structuredClone(this.state);
    for (const node of secured.nodes) node.token = encryptSecret(node.token)!;
    for (const user of secured.users) user.twoFactorSecret = encryptSecret(user.twoFactorSecret);
    await writeFile(temporary, JSON.stringify(secured, null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async migrateDatabase() {
    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, role text NOT NULL,
        role_id text, permissions jsonb NOT NULL DEFAULT '[]', password_hash text NOT NULL, salt text NOT NULL, created_at timestamptz NOT NULL
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS group_ids jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS quota jsonb NOT NULL DEFAULT '{"maxServers":-1,"maxMemoryMb":-1,"maxDiskMb":-1,"maxBackups":-1}';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hashes jsonb NOT NULL DEFAULT '[]';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS user_groups (
        id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
        permissions jsonb NOT NULL DEFAULT '[]', server_permissions jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS user_groups_name_unique_idx ON user_groups(lower(name));
      CREATE TABLE IF NOT EXISTS panel_roles (
        id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '',
        permissions jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS panel_roles_name_unique_idx ON panel_roles(lower(name));
      CREATE TABLE IF NOT EXISTS nodes (
        id text PRIMARY KEY, name text NOT NULL, location text NOT NULL, url text NOT NULL,
        token text NOT NULL, maintenance boolean NOT NULL DEFAULT false, maintenance_message text,
        max_memory_mb integer, max_disk_mb integer, created_at timestamptz NOT NULL
      );
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS maintenance boolean NOT NULL DEFAULT false;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS maintenance_message text;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS max_memory_mb integer;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS max_disk_mb integer;
      CREATE TABLE IF NOT EXISTS servers (
        id text PRIMARY KEY, name text NOT NULL, software text NOT NULL, version text NOT NULL,
        memory_mb integer NOT NULL, cpu_percent integer NOT NULL, disk_mb integer NOT NULL, port integer NOT NULL,
        node_id text NOT NULL REFERENCES nodes(id), allocation_id text NOT NULL,
        owner_id text NOT NULL REFERENCES users(id), domain text, created_at timestamptz NOT NULL
      );
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS domain text;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS crash_policy jsonb NOT NULL DEFAULT '{"enabled":true,"maxRestarts":3,"windowMinutes":10,"cooldownMinutes":30}';
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS backup_policy jsonb NOT NULL DEFAULT '{"retention":5,"remoteEnabled":false}';
      CREATE TABLE IF NOT EXISTS allocations (
        id text PRIMARY KEY, node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, ip text NOT NULL,
        port integer NOT NULL, alias text, server_id text UNIQUE REFERENCES servers(id) ON DELETE SET NULL, reservation_id text,
        UNIQUE(node_id, ip, port)
      );
      ALTER TABLE allocations ADD COLUMN IF NOT EXISTS reservation_id text;
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
      CREATE TABLE IF NOT EXISTS sftp_accounts (
        id text PRIMARY KEY, server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        username text NOT NULL, password_hash text NOT NULL, salt text NOT NULL,
        paths jsonb NOT NULL DEFAULT '["."]', read_only boolean NOT NULL DEFAULT false,
        enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL,
        target_type text NOT NULL, target_id text, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panel_jobs (
        id text PRIMARY KEY, kind text NOT NULL, status text NOT NULL, progress integer NOT NULL,
        step text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', result jsonb, error text,
        attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
        user_id text REFERENCES users(id) ON DELETE SET NULL, server_id text, node_id text,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        started_at timestamptz, finished_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE CASCADE, level text NOT NULL,
        title text NOT NULL, message text NOT NULL, link text, read_at timestamptz, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metric_samples (
        id text PRIMARY KEY, server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE, status text NOT NULL,
        cpu_percent real NOT NULL, memory_bytes bigint NOT NULL, memory_limit_bytes bigint NOT NULL,
        network_rx_bytes bigint NOT NULL, network_tx_bytes bigint NOT NULL, disk_bytes bigint NOT NULL,
        players_online integer, players_max integer, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, ip text, user_agent text,
        created_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL,
        prefix text NOT NULL, secret_hash text NOT NULL, created_at timestamptz NOT NULL,
        last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS crash_events (
        id text PRIMARY KEY, server_id text NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        reason text NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_tokens (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, type text NOT NULL,
        token_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS server_templates (
        id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', software text NOT NULL,
        version text NOT NULL, memory_mb integer NOT NULL, cpu_percent integer NOT NULL, disk_mb integer NOT NULL,
        created_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS server_templates_name_unique_idx ON server_templates(lower(name));
      CREATE INDEX IF NOT EXISTS servers_owner_idx ON servers(owner_id);
      CREATE INDEX IF NOT EXISTS servers_node_idx ON servers(node_id);
      CREATE UNIQUE INDEX IF NOT EXISTS servers_domain_unique_idx ON servers(lower(domain)) WHERE domain IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS sftp_accounts_username_unique_idx ON sftp_accounts(lower(username));
      CREATE INDEX IF NOT EXISTS sftp_accounts_server_idx ON sftp_accounts(server_id);
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON panel_jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS metrics_server_created_idx ON metric_samples(server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON user_sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS crash_events_server_created_idx ON crash_events(server_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS account_tokens_hash_idx ON account_tokens(token_hash);
    `);
  }

  private async loadPostgres(): Promise<PanelState> {
    const [users, groups, roles, nodes, servers, allocations, access, schedules, sftpAccounts, jobs, notifications, metrics, sessions, apiKeys, crashEvents, accountTokens, templates, audit] = await Promise.all([
      this.pool!.query('SELECT * FROM users ORDER BY created_at'),
      this.pool!.query('SELECT * FROM user_groups ORDER BY name'),
      this.pool!.query('SELECT * FROM panel_roles ORDER BY name'),
      this.pool!.query('SELECT * FROM nodes ORDER BY created_at'),
      this.pool!.query('SELECT * FROM servers ORDER BY created_at'),
      this.pool!.query('SELECT * FROM allocations ORDER BY node_id, port'),
      this.pool!.query('SELECT * FROM server_access'),
      this.pool!.query('SELECT * FROM schedules ORDER BY created_at'),
      this.pool!.query('SELECT * FROM sftp_accounts ORDER BY created_at'),
      this.pool!.query('SELECT * FROM panel_jobs ORDER BY created_at DESC LIMIT 1000'),
      this.pool!.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 2000'),
      this.pool!.query("SELECT * FROM metric_samples WHERE created_at >= now() - interval '7 days' ORDER BY created_at"),
      this.pool!.query('SELECT * FROM user_sessions ORDER BY created_at DESC'),
      this.pool!.query('SELECT * FROM api_keys ORDER BY created_at DESC'),
      this.pool!.query("SELECT * FROM crash_events WHERE created_at >= now() - interval '7 days' ORDER BY created_at DESC"),
      this.pool!.query('SELECT * FROM account_tokens WHERE expires_at >= now() - interval \'7 days\''),
      this.pool!.query('SELECT * FROM server_templates ORDER BY name'),
      this.pool!.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000'),
    ]);
    return {
      users: users.rows.map((row) => ({ id: row.id, username: row.username, email: row.email, role: row.role, roleId: row.role_id ?? undefined, groupIds: row.group_ids ?? [], permissions: row.permissions ?? [], quota: row.quota ?? unlimitedQuota(), twoFactorSecret: decryptSecret(row.two_factor_secret ?? undefined), twoFactorEnabled: row.two_factor_enabled ?? false, recoveryCodeHashes: row.recovery_code_hashes ?? [], emailVerified: row.email_verified ?? false, passwordHash: row.password_hash, salt: row.salt, createdAt: date(row.created_at) })) as UserRecord[],
      groups: groups.rows.map((row) => ({ id: row.id, name: row.name, description: row.description, permissions: row.permissions ?? [], serverPermissions: row.server_permissions ?? [], createdAt: date(row.created_at), updatedAt: date(row.updated_at) })) as UserGroup[],
      roles: roles.rows.map((row) => ({ id: row.id, name: row.name, description: row.description, permissions: row.permissions ?? [], createdAt: date(row.created_at), updatedAt: date(row.updated_at) })) as PanelRole[],
      nodes: nodes.rows.map((row) => ({ id: row.id, name: row.name, location: row.location, url: row.url, token: decryptSecret(row.token)!, maintenance: row.maintenance ?? false, maintenanceMessage: row.maintenance_message ?? undefined, maxMemoryMb: row.max_memory_mb ?? undefined, maxDiskMb: row.max_disk_mb ?? undefined, createdAt: date(row.created_at) })) as NodeRecord[],
      servers: servers.rows.map((row) => ({ id: row.id, name: row.name, software: row.software, version: row.version, memoryMb: row.memory_mb, cpuPercent: row.cpu_percent, diskMb: row.disk_mb, port: row.port, nodeId: row.node_id, allocationId: row.allocation_id, ownerId: row.owner_id, domain: row.domain ?? undefined, crashPolicy: row.crash_policy ?? defaultCrashPolicy(), backupPolicy: row.backup_policy ?? defaultBackupPolicy(), createdAt: date(row.created_at) })) as MinecraftServer[],
      allocations: allocations.rows.map((row) => ({ id: row.id, nodeId: row.node_id, ip: row.ip, port: row.port, alias: row.alias ?? undefined, serverId: row.server_id ?? undefined, reservationId: row.reservation_id ?? undefined })) as Allocation[],
      serverAccess: access.rows.map((row) => ({ serverId: row.server_id, userId: row.user_id, permissions: row.permissions })) as ServerAccess[],
      schedules: schedules.rows.map((row) => ({ id: row.id, serverId: row.server_id, name: row.name, intervalMinutes: row.interval_minutes, action: row.action, payload: row.payload ?? undefined, enabled: row.enabled, nextRunAt: date(row.next_run_at), lastRunAt: row.last_run_at ? date(row.last_run_at) : undefined, lastStatus: row.last_status ?? undefined, createdAt: date(row.created_at) })) as ServerSchedule[],
      sftpAccounts: sftpAccounts.rows.map((row) => ({ id: row.id, serverId: row.server_id, username: row.username, passwordHash: row.password_hash, salt: row.salt, paths: row.paths, readOnly: row.read_only, enabled: row.enabled, createdAt: date(row.created_at), updatedAt: date(row.updated_at) })) as SftpAccount[],
      jobs: jobs.rows.map((row) => ({ id: row.id, kind: row.kind, status: row.status, progress: row.progress, step: row.step, payload: row.payload ?? {}, result: row.result ?? undefined, error: row.error ?? undefined, attempts: row.attempts, maxAttempts: row.max_attempts, userId: row.user_id ?? undefined, serverId: row.server_id ?? undefined, nodeId: row.node_id ?? undefined, createdAt: date(row.created_at), updatedAt: date(row.updated_at), startedAt: row.started_at ? date(row.started_at) : undefined, finishedAt: row.finished_at ? date(row.finished_at) : undefined })) as PanelJob[],
      notifications: notifications.rows.map((row) => ({ id: row.id, userId: row.user_id ?? undefined, level: row.level, title: row.title, message: row.message, link: row.link ?? undefined, readAt: row.read_at ? date(row.read_at) : undefined, createdAt: date(row.created_at) })) as PanelNotification[],
      metrics: metrics.rows.map((row) => ({ id: row.id, serverId: row.server_id, status: row.status, cpuPercent: Number(row.cpu_percent), memoryBytes: Number(row.memory_bytes), memoryLimitBytes: Number(row.memory_limit_bytes), networkRxBytes: Number(row.network_rx_bytes), networkTxBytes: Number(row.network_tx_bytes), diskBytes: Number(row.disk_bytes), playersOnline: row.players_online ?? undefined, playersMax: row.players_max ?? undefined, createdAt: date(row.created_at) })) as MetricSample[],
      sessions: sessions.rows.map((row) => ({ id: row.id, userId: row.user_id, ip: row.ip ?? undefined, userAgent: row.user_agent ?? undefined, createdAt: date(row.created_at), lastSeenAt: date(row.last_seen_at), expiresAt: date(row.expires_at), revokedAt: row.revoked_at ? date(row.revoked_at) : undefined })) as UserSession[],
      apiKeys: apiKeys.rows.map((row) => ({ id: row.id, userId: row.user_id, name: row.name, prefix: row.prefix, secretHash: row.secret_hash, createdAt: date(row.created_at), lastUsedAt: row.last_used_at ? date(row.last_used_at) : undefined, expiresAt: row.expires_at ? date(row.expires_at) : undefined, revokedAt: row.revoked_at ? date(row.revoked_at) : undefined })) as ApiKeyRecord[],
      crashEvents: crashEvents.rows.map((row) => ({ id: row.id, serverId: row.server_id, reason: row.reason, createdAt: date(row.created_at) })) as CrashEvent[],
      accountTokens: accountTokens.rows.map((row) => ({ id: row.id, userId: row.user_id, type: row.type, tokenHash: row.token_hash, expiresAt: date(row.expires_at), usedAt: row.used_at ? date(row.used_at) : undefined, createdAt: date(row.created_at) })) as AccountToken[],
      templates: templates.rows.map((row) => ({ id: row.id, name: row.name, description: row.description, software: row.software, version: row.version, memoryMb: row.memory_mb, cpuPercent: row.cpu_percent, diskMb: row.disk_mb, createdBy: row.created_by, createdAt: date(row.created_at), updatedAt: date(row.updated_at) })) as ServerTemplate[],
      auditLogs: audit.rows.map((row) => ({ id: row.id, userId: row.user_id ?? undefined, action: row.action, targetType: row.target_type, targetId: row.target_id ?? undefined, metadata: row.metadata, createdAt: date(row.created_at) })) as AuditEntry[],
    };
  }

  private async savePostgres() {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const group of this.state.groups) await client.query(
        `INSERT INTO user_groups (id,name,description,permissions,server_permissions,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET name=$2,description=$3,permissions=$4,server_permissions=$5,updated_at=$7`,
        [group.id, group.name, group.description, JSON.stringify(group.permissions), JSON.stringify(group.serverPermissions), group.createdAt, group.updatedAt]);
      for (const role of this.state.roles) await client.query(
        `INSERT INTO panel_roles (id,name,description,permissions,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=$2,description=$3,permissions=$4,updated_at=$6`,
        [role.id, role.name, role.description, JSON.stringify(role.permissions), role.createdAt, role.updatedAt]);
      for (const user of this.state.users) await client.query(
        `INSERT INTO users (id,username,email,role,role_id,group_ids,permissions,quota,two_factor_secret,two_factor_enabled,recovery_code_hashes,email_verified,password_hash,salt,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET username=$2,email=$3,role=$4,role_id=$5,group_ids=$6,permissions=$7,quota=$8,two_factor_secret=$9,two_factor_enabled=$10,recovery_code_hashes=$11,email_verified=$12,password_hash=$13,salt=$14`,
        [user.id, user.username, user.email, user.role, user.roleId ?? null, JSON.stringify(user.groupIds), JSON.stringify(user.permissions), JSON.stringify(user.quota), encryptSecret(user.twoFactorSecret) ?? null, user.twoFactorEnabled, JSON.stringify(user.recoveryCodeHashes), user.emailVerified, user.passwordHash, user.salt, user.createdAt]);
      for (const node of this.state.nodes) await client.query(
        `INSERT INTO nodes (id,name,location,url,token,maintenance,maintenance_message,max_memory_mb,max_disk_mb,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET name=$2,location=$3,url=$4,token=$5,maintenance=$6,maintenance_message=$7,max_memory_mb=$8,max_disk_mb=$9`,
        [node.id, node.name, node.location, node.url, encryptSecret(node.token), node.maintenance, node.maintenanceMessage ?? null, node.maxMemoryMb ?? null, node.maxDiskMb ?? null, node.createdAt]);
      for (const server of this.state.servers) await client.query(
        `INSERT INTO servers (id,name,software,version,memory_mb,cpu_percent,disk_mb,port,node_id,allocation_id,owner_id,domain,crash_policy,backup_policy,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET name=$2,software=$3,version=$4,memory_mb=$5,cpu_percent=$6,disk_mb=$7,port=$8,node_id=$9,allocation_id=$10,owner_id=$11,domain=$12,crash_policy=$13,backup_policy=$14`,
        [server.id, server.name, server.software, server.version, server.memoryMb, server.cpuPercent, server.diskMb, server.port, server.nodeId, server.allocationId, server.ownerId, server.domain ?? null, JSON.stringify(server.crashPolicy), JSON.stringify(server.backupPolicy), server.createdAt]);
      for (const allocation of this.state.allocations) await client.query(
        `INSERT INTO allocations (id,node_id,ip,port,alias,server_id,reservation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET node_id=$2,ip=$3,port=$4,alias=$5,server_id=$6,reservation_id=$7`,
        [allocation.id, allocation.nodeId, allocation.ip, allocation.port, allocation.alias ?? null, allocation.serverId ?? null, allocation.reservationId ?? null]);
      await client.query('DELETE FROM server_access');
      for (const item of this.state.serverAccess) await client.query('INSERT INTO server_access VALUES ($1,$2,$3)', [item.serverId, item.userId, JSON.stringify(item.permissions)]);
      for (const schedule of this.state.schedules) await client.query(
        `INSERT INTO schedules VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET name=$3,interval_minutes=$4,action=$5,payload=$6,enabled=$7,next_run_at=$8,last_run_at=$9,last_status=$10`,
        [schedule.id, schedule.serverId, schedule.name, schedule.intervalMinutes, schedule.action, schedule.payload ?? null, schedule.enabled, schedule.nextRunAt, schedule.lastRunAt ?? null, schedule.lastStatus ?? null, schedule.createdAt]);
      for (const account of this.state.sftpAccounts) await client.query(
        `INSERT INTO sftp_accounts (id,server_id,username,password_hash,salt,paths,read_only,enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET username=$3,password_hash=$4,salt=$5,paths=$6,read_only=$7,enabled=$8,updated_at=$10`,
        [account.id, account.serverId, account.username, account.passwordHash, account.salt, JSON.stringify(account.paths), account.readOnly, account.enabled, account.createdAt, account.updatedAt]);
      for (const job of this.state.jobs) await client.query(
        `INSERT INTO panel_jobs (id,kind,status,progress,step,payload,result,error,attempts,max_attempts,user_id,server_id,node_id,created_at,updated_at,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO UPDATE SET status=$3,progress=$4,step=$5,payload=$6,result=$7,error=$8,attempts=$9,max_attempts=$10,updated_at=$15,started_at=$16,finished_at=$17`,
        [job.id, job.kind, job.status, job.progress, job.step, JSON.stringify(job.payload), job.result ? JSON.stringify(job.result) : null, job.error ?? null, job.attempts, job.maxAttempts, job.userId ?? null, job.serverId ?? null, job.nodeId ?? null, job.createdAt, job.updatedAt, job.startedAt ?? null, job.finishedAt ?? null]);
      for (const notification of this.state.notifications) await client.query(
        `INSERT INTO notifications (id,user_id,level,title,message,link,read_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET read_at=$7`,
        [notification.id, notification.userId ?? null, notification.level, notification.title, notification.message, notification.link ?? null, notification.readAt ?? null, notification.createdAt]);
      for (const metric of this.state.metrics) await client.query(
        `INSERT INTO metric_samples (id,server_id,status,cpu_percent,memory_bytes,memory_limit_bytes,network_rx_bytes,network_tx_bytes,disk_bytes,players_online,players_max,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [metric.id, metric.serverId, metric.status, metric.cpuPercent, metric.memoryBytes, metric.memoryLimitBytes, metric.networkRxBytes, metric.networkTxBytes, metric.diskBytes, metric.playersOnline ?? null, metric.playersMax ?? null, metric.createdAt]);
      for (const session of this.state.sessions) await client.query(
        `INSERT INTO user_sessions (id,user_id,ip,user_agent,created_at,last_seen_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET last_seen_at=$6,revoked_at=$8`,
        [session.id, session.userId, session.ip ?? null, session.userAgent ?? null, session.createdAt, session.lastSeenAt, session.expiresAt, session.revokedAt ?? null]);
      for (const key of this.state.apiKeys) await client.query(
        `INSERT INTO api_keys (id,user_id,name,prefix,secret_hash,created_at,last_used_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET name=$3,last_used_at=$7,expires_at=$8,revoked_at=$9`,
        [key.id, key.userId, key.name, key.prefix, key.secretHash, key.createdAt, key.lastUsedAt ?? null, key.expiresAt ?? null, key.revokedAt ?? null]);
      for (const event of this.state.crashEvents) await client.query(
        `INSERT INTO crash_events (id,server_id,reason,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [event.id, event.serverId, event.reason, event.createdAt]);
      for (const token of this.state.accountTokens) await client.query(
        `INSERT INTO account_tokens (id,user_id,type,token_hash,expires_at,used_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET used_at=$6`,
        [token.id, token.userId, token.type, token.tokenHash, token.expiresAt, token.usedAt ?? null, token.createdAt]);
      for (const template of this.state.templates) await client.query(
        `INSERT INTO server_templates (id,name,description,software,version,memory_mb,cpu_percent,disk_mb,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET name=$2,description=$3,software=$4,version=$5,memory_mb=$6,cpu_percent=$7,disk_mb=$8,updated_at=$11`,
        [template.id, template.name, template.description, template.software, template.version, template.memoryMb, template.cpuPercent, template.diskMb, template.createdBy, template.createdAt, template.updatedAt]);
      for (const entry of this.state.auditLogs) await client.query(
        `INSERT INTO audit_logs VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [entry.id, entry.userId ?? null, entry.action, entry.targetType, entry.targetId ?? null, JSON.stringify(entry.metadata), entry.createdAt]);
      await client.query('DELETE FROM allocations WHERE id <> ALL($1::text[])', [this.state.allocations.map((item) => item.id)]);
      await client.query('DELETE FROM schedules WHERE id <> ALL($1::text[])', [this.state.schedules.map((item) => item.id)]);
      await client.query('DELETE FROM sftp_accounts WHERE id <> ALL($1::text[])', [this.state.sftpAccounts.map((item) => item.id)]);
      await client.query('DELETE FROM panel_jobs WHERE id <> ALL($1::text[])', [this.state.jobs.map((item) => item.id)]);
      await client.query('DELETE FROM notifications WHERE id <> ALL($1::text[])', [this.state.notifications.map((item) => item.id)]);
      await client.query('DELETE FROM metric_samples WHERE id <> ALL($1::text[])', [this.state.metrics.map((item) => item.id)]);
      await client.query('DELETE FROM user_sessions WHERE id <> ALL($1::text[])', [this.state.sessions.map((item) => item.id)]);
      await client.query('DELETE FROM api_keys WHERE id <> ALL($1::text[])', [this.state.apiKeys.map((item) => item.id)]);
      await client.query('DELETE FROM crash_events WHERE id <> ALL($1::text[])', [this.state.crashEvents.map((item) => item.id)]);
      await client.query('DELETE FROM account_tokens WHERE id <> ALL($1::text[])', [this.state.accountTokens.map((item) => item.id)]);
      await client.query('DELETE FROM server_templates WHERE id <> ALL($1::text[])', [this.state.templates.map((item) => item.id)]);
      await client.query('DELETE FROM servers WHERE id <> ALL($1::text[])', [this.state.servers.map((item) => item.id)]);
      await client.query('DELETE FROM nodes WHERE id <> ALL($1::text[])', [this.state.nodes.map((item) => item.id)]);
      await client.query('DELETE FROM users WHERE id <> ALL($1::text[])', [this.state.users.map((item) => item.id)]);
      await client.query('DELETE FROM user_groups WHERE id <> ALL($1::text[])', [this.state.groups.map((item) => item.id)]);
      await client.query('DELETE FROM panel_roles WHERE id <> ALL($1::text[])', [this.state.roles.map((item) => item.id)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

function emptyState(): PanelState { return { users: [], groups: [], roles: [], nodes: [], servers: [], allocations: [], serverAccess: [], schedules: [], sftpAccounts: [], jobs: [], notifications: [], metrics: [], sessions: [], apiKeys: [], crashEvents: [], accountTokens: [], templates: [], auditLogs: [] }; }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function hasData(raw: Partial<PanelState>) { return Boolean(raw.user || raw.users?.length || raw.nodes?.length || raw.servers?.length); }

function unlimitedQuota() { return { maxServers: -1, maxMemoryMb: -1, maxDiskMb: -1, maxBackups: -1 }; }
function defaultCrashPolicy() { return { enabled: true, maxRestarts: 3, windowMinutes: 10, cooldownMinutes: 30 }; }
function defaultBackupPolicy() { return { retention: 5, remoteEnabled: false }; }

function normalize(raw: Partial<PanelState>): PanelState {
  const roles = (raw.roles ?? []).map((role) => ({ ...role, description: role.description ?? '', updatedAt: role.updatedAt ?? role.createdAt })) as PanelRole[];
  const legacyUser = raw.user as Partial<UserRecord> | undefined;
  const users = (raw.users?.length ? raw.users : legacyUser ? [legacyUser as UserRecord] : []).map((user, index) => ({
    id: user.id ?? (index === 0 ? 'legacy-admin' : randomUUID().slice(0, 8)), username: user.username,
    email: user.email ?? `${user.username}@padock.local`, role: user.role ?? (index === 0 ? 'admin' : 'user'),
    roleId: user.role === 'admin' || !roles.some((role) => role.id === user.roleId) ? undefined : user.roleId,
    groupIds: user.groupIds ?? [],
    permissions: user.permissions ?? [],
    quota: user.quota ?? unlimitedQuota(), twoFactorSecret: decryptSecret(user.twoFactorSecret), twoFactorEnabled: user.twoFactorEnabled ?? false,
    recoveryCodeHashes: user.recoveryCodeHashes ?? [], emailVerified: user.emailVerified ?? false,
    passwordHash: user.passwordHash, salt: user.salt, createdAt: user.createdAt ?? new Date().toISOString(),
  })) as UserRecord[];
  const nodes = (raw.nodes ?? []).map((node) => ({ ...node, token: decryptSecret(node.token)!, maintenance: node.maintenance ?? false })) as NodeRecord[];
  const ownerId = users[0]?.id ?? '';
  const allocations: Allocation[] = raw.allocations ?? (raw.servers ?? []).map((server) => ({
    id: `legacy-${server.id}`, nodeId: server.nodeId ?? nodes[0]?.id ?? 'local001', ip: '0.0.0.0', port: server.port, serverId: server.id,
  }));
  const servers = (raw.servers ?? []).map((server) => ({
    ...server, nodeId: server.nodeId ?? nodes[0]?.id ?? 'local001', ownerId: server.ownerId ?? ownerId,
    allocationId: server.allocationId ?? `legacy-${server.id}`, cpuPercent: server.cpuPercent ?? 100, diskMb: server.diskMb ?? 10240,
    crashPolicy: server.crashPolicy ?? defaultCrashPolicy(), backupPolicy: server.backupPolicy ?? defaultBackupPolicy(),
  }));
  return {
    users, groups: raw.groups ?? [], roles, nodes, servers, allocations: allocations.map((item) => ({ ...item, reservationId: item.reservationId })),
    serverAccess: raw.serverAccess ?? [], schedules: raw.schedules ?? [], sftpAccounts: raw.sftpAccounts ?? [],
    jobs: raw.jobs ?? [], notifications: raw.notifications ?? [], metrics: raw.metrics ?? [], sessions: raw.sessions ?? [], apiKeys: raw.apiKeys ?? [], crashEvents: raw.crashEvents ?? [], accountTokens: raw.accountTokens ?? [], templates: raw.templates ?? [], auditLogs: raw.auditLogs ?? [],
  };
}
