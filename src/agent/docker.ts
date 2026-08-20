import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import Docker from 'dockerode';
import { padockEnv } from './config.js';

const IMAGE = padockEnv('MINECRAFT_IMAGE') ?? 'itzg/minecraft-server:java25';
const STEAMCMD_IMAGE = padockEnv('STEAMCMD_IMAGE') ?? 'steamcmd/steamcmd:ubuntu-22';
const GATEWAY_ENABLED = padockEnv('GATEWAY_ENABLED') === 'true';
const GATEWAY_BACKEND_BIND = padockEnv('GATEWAY_BACKEND_BIND')?.trim() || '127.0.0.1';
export const MINECRAFT_INTERNAL_PORT = 25565;

interface DockerServerPort {
  name: string;
  internalPort: number;
  hostPort: number;
  protocol: 'tcp' | 'udp';
  allocationId: string;
}

interface DockerServerInput {
  id: string;
  name: string;
  platform: 'minecraft' | 'steamcmd';
  software: string;
  version: string;
  memoryMb: number;
  cpuPercent: number;
  diskMb: number;
  port: number;
  ports: DockerServerPort[];
  steam?: {
    presetId: string;
    gameName: string;
    appId: number;
    startupCommand: string;
  };
}

export type ServerStatus = 'running' | 'stopped' | 'missing' | 'starting';
export interface ServerState {
  status: ServerStatus;
  health?: string;
  exitCode?: number;
  oomKilled?: boolean;
  restartCount?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface ServerMetrics {
  status: ServerStatus;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskBytes: number;
  playersOnline?: number;
  playersMax?: number;
}

export interface NetworkCounterSample { rxBytes: number; txBytes: number; measuredAt: number }

export class NodeDocker {
  readonly docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock') });
  private readonly imageReady = new Map<string, Promise<void>>();
  private readonly diskUsageCache = new Map<string, { bytes: number; expiresAt: number }>();
  private readonly networkCounters = new Map<string, NetworkCounterSample>();

  constructor(private dataDir: string) {}

  async health() {
    await this.docker.ping();
  }

  async create(input: DockerServerInput, serverPack?: { relativePath: string; projectId: number; fileId: number; filename: string }) {
    const serverDir = path.join(this.dataDir, input.id);
    await mkdir(serverDir, { recursive: true });
    if (input.platform === 'steamcmd') return await this.createSteamServer(input, serverDir);
    const genericPack = serverPack ? containerPackPath(serverPack.relativePath) : undefined;
    await this.ensureImage(IMAGE);
    const env = [
      'EULA=TRUE', `TYPE=${input.software}`, `VERSION=${input.version}`, ...javaMemoryEnvironment(input.memoryMb),
      'ENABLE_RCON=true', 'ONLINE_MODE=true', 'USE_AIKAR_FLAGS=true',
    ];
    if (input.software === 'CUSTOM') env.push('CUSTOM_SERVER=/data/server.jar');
    if (genericPack) env.push(`GENERIC_PACK=${genericPack}`, 'USE_MODPACK_START_SCRIPT=true');
    const labels: Record<string, string> = { 'padock.managed': 'true', 'padock.platform': 'minecraft', 'padock.server-id': input.id, 'padock.server-name': input.name, 'padock.memory-mb': String(input.memoryMb), 'padock.disk-mb': String(input.diskMb), 'padock.cpu-percent': String(input.cpuPercent) };
    if (serverPack) {
      labels['padock.modpack-provider'] = 'curseforge';
      labels['padock.modpack-mode'] = 'server-pack';
      labels['padock.modpack-project-id'] = String(serverPack.projectId);
      labels['padock.modpack-file-id'] = String(serverPack.fileId);
      labels['padock.modpack-filename'] = serverPack.filename;
    }
    const ports = input.ports.length ? input.ports : [{ name: 'Minecraft', internalPort: MINECRAFT_INTERNAL_PORT, hostPort: input.port, protocol: 'tcp' as const, allocationId: '' }];
    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }>> = {};
    for (const port of ports) {
      const key = `${port.internalPort}/${port.protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: GATEWAY_ENABLED && port.internalPort === MINECRAFT_INTERNAL_PORT ? GATEWAY_BACKEND_BIND : undefined, HostPort: String(port.hostPort) }];
    }
    const container = await this.docker.createContainer({
      name: this.containerName(input.id),
      Image: IMAGE,
      Env: env,
      Labels: labels,
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: [`${serverDir}:/data`],
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: input.memoryMb * 1024 * 1024,
        MemorySwap: input.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(input.cpuPercent / 100 * 1_000_000_000),
      },
    });
    return container.id;
  }

  private async createSteamServer(input: DockerServerInput, serverDir: string) {
    if (!input.steam || !input.ports.length) throw Object.assign(new Error('Configuration SteamCMD incomplète.'), { statusCode: 400 });
    await this.ensureImage(STEAMCMD_IMAGE);
    await this.installSteamApp(input, serverDir);

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    for (const port of input.ports) {
      const key = `${port.internalPort}/${port.protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(port.hostPort) }];
    }
    const uniqueInternalPorts = [...new Set(input.ports.map((port) => port.internalPort))];
    const labels: Record<string, string> = {
      'padock.managed': 'true',
      'padock.platform': 'steamcmd',
      'padock.server-id': input.id,
      'padock.server-name': input.name,
      'padock.steam-preset': input.steam.presetId,
      'padock.steam-app-id': String(input.steam.appId),
      'padock.memory-mb': String(input.memoryMb),
      'padock.disk-mb': String(input.diskMb),
      'padock.cpu-percent': String(input.cpuPercent),
    };
    const env = [
      `STEAM_APP_ID=${input.steam.appId}`,
      `PADOCK_SERVER_NAME=${input.name}`,
      `PADOCK_STARTUP_COMMAND=${input.steam.startupCommand}`,
      `PADOCK_GAME_PORT=${uniqueInternalPorts[0]}`,
      `PADOCK_QUERY_PORT=${uniqueInternalPorts[1] ?? uniqueInternalPorts[0]}`,
    ];
    const command = [
      'set -e',
      'mkdir -p /data/server',
      '/usr/bin/steamcmd +force_install_dir /data/server +login anonymous +app_update "$STEAM_APP_ID" +quit',
      'cd /data/server',
      'exec /bin/bash -lc "$PADOCK_STARTUP_COMMAND"',
    ].join('\n');
    const container = await this.docker.createContainer({
      name: this.containerName(input.id),
      Image: STEAMCMD_IMAGE,
      Entrypoint: ['/bin/bash', '-lc'],
      Cmd: [command],
      Env: env,
      Labels: labels,
      WorkingDir: '/data/server',
      OpenStdin: true,
      StdinOnce: false,
      Tty: true,
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: [`${serverDir}:/data`],
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: input.memoryMb * 1024 * 1024,
        MemorySwap: input.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(input.cpuPercent / 100 * 1_000_000_000),
      },
    });
    return container.id;
  }

  private async installSteamApp(input: DockerServerInput, serverDir: string) {
    const installer = await this.docker.createContainer({
      name: `padock-install-${input.id}-${Date.now()}`,
      Image: STEAMCMD_IMAGE,
      Cmd: ['+force_install_dir', '/data/server', '+login', 'anonymous', '+app_update', String(input.steam!.appId), 'validate', '+quit'],
      HostConfig: { Binds: [`${serverDir}:/data`] },
    });
    try {
      await installer.start();
      const result = await installer.wait();
      if (result.StatusCode !== 0) {
        const logs = await installer.logs({ stdout: true, stderr: true, tail: 80 });
        throw Object.assign(new Error(`SteamCMD a échoué pour l’App ID ${input.steam!.appId} (code ${result.StatusCode}).\n${logs.toString().slice(-4000)}`), { statusCode: 502 });
      }
    } finally {
      await installer.remove({ force: true }).catch(() => undefined);
    }
  }

  async status(id: string): Promise<ServerStatus> {
    return (await this.state(id)).status;
  }

  async state(id: string): Promise<ServerState> {
    try {
      const info = await (await this.container(id)).inspect();
      const status = info.State.Running ? (info.State.Health?.Status === 'starting' ? 'starting' : 'running') : 'stopped';
      return {
        status,
        health: info.State.Health?.Status,
        exitCode: info.State.ExitCode,
        oomKilled: info.State.OOMKilled,
        restartCount: info.RestartCount,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
        error: info.State.Error || undefined,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return { status: 'missing' };
      throw error;
    }
  }

  async states(ids: string[]) {
    const result: Record<string, ServerState> = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(16, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) result[id] = await this.state(id);
      }
    });
    await Promise.all(workers);
    return result;
  }

  async metrics(id: string): Promise<ServerMetrics> {
    const state = await this.state(id);
    const diskBytes = await this.diskUsage(id);
    if (state.status !== 'running') return { status: state.status, cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes };
    const stats = await this.stats(id);
    let playersOnline: number | undefined;
    let playersMax: number | undefined;
    if (await this.platform(id).catch(() => 'minecraft') === 'minecraft') {
      const players = await this.minecraftStatus(id).catch(() => null);
      if (players) { playersOnline = players.online; playersMax = players.max; }
    }
    return { status: state.status, ...stats, diskBytes, playersOnline, playersMax };
  }

  async metricsMany(ids: string[]) {
    const result: Record<string, ServerMetrics> = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) result[id] = await this.metrics(id);
      }
    });
    await Promise.all(workers);
    return result;
  }

  async action(id: string, action: 'start' | 'stop' | 'restart' | 'kill') {
    const container = await this.container(id);
    if (action === 'start') {
      const info = await container.inspect();
      const diskMb = Number(readLabel(info.Config.Labels, 'disk-mb') ?? 0);
      if (diskMb && await directorySize(path.join(this.dataDir, id)) > diskMb * 1024 * 1024) {
        throw Object.assign(new Error(`Quota disque dépassé (${diskMb} Mo).`), { statusCode: 409 });
      }
    }
    if (action === 'start') await container.start();
    if (action === 'stop') await container.stop({ t: 20 });
    if (action === 'restart') await container.restart({ t: 20 });
    if (action === 'kill') await container.kill();
  }

  async remove(id: string) {
    try { await (await this.container(id)).remove({ force: true }); }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
    this.networkCounters.delete(id);
  }

  async updateResources(id: string, input: { memoryMb: number; cpuPercent: number; diskMb: number }) {
    if (await this.status(id) !== 'stopped') throw Object.assign(new Error('Arrêtez le serveur avant de modifier ses ressources.'), { statusCode: 409 });
    const usedBytes = await directorySize(path.join(this.dataDir, id));
    if (usedBytes > input.diskMb * 1024 * 1024) {
      throw Object.assign(new Error(`Le dossier utilise déjà ${Math.ceil(usedBytes / 1024 / 1024)} Mo. Choisissez un quota disque supérieur.`), { statusCode: 409 });
    }
    const container = await this.container(id);
    const info = await container.inspect();
    const originalEnv = info.Config.Env ?? [];
    const env = readLabel(info.Config.Labels, 'platform') === 'steamcmd'
      ? originalEnv
      : originalEnv.filter((entry) => !['MEMORY=', 'INIT_MEMORY=', 'MAX_MEMORY='].some((prefix) => entry.startsWith(prefix))).concat(javaMemoryEnvironment(input.memoryMb));
    const labels: Record<string, string> = {
      ...info.Config.Labels,
      'padock.memory-mb': String(input.memoryMb),
      'padock.cpu-percent': String(input.cpuPercent),
      'padock.disk-mb': String(input.diskMb),
    };
    await container.remove({ force: true });
    try { await this.recreate(info, env, labels, input.memoryMb, input.cpuPercent); }
    catch (error) {
      await this.recreate(info, originalEnv, info.Config.Labels ?? {}).catch(() => undefined);
      throw error;
    }
  }

  async updateCrashPolicy(id: string, input: { enabled: boolean; maxRestarts: number }) {
    await (await this.container(id)).update({ RestartPolicy: input.enabled ? { Name: 'on-failure', MaximumRetryCount: input.maxRestarts } : { Name: 'no', MaximumRetryCount: 0 } });
  }

  async repair(input: DockerServerInput) {
    const current = await this.state(input.id);
    if (current.status === 'running' || current.status === 'starting') {
      throw Object.assign(new Error('Arrêtez le serveur avant de réparer son conteneur.'), { statusCode: 409 });
    }
    if (current.status === 'missing') {
      const serverPack = await existingServerPack(this.dataDir, input.id);
      await this.create(input, serverPack);
      return;
    }

    if (input.platform === 'steamcmd') {
      await (await this.container(input.id)).remove({ force: true });
      await this.create(input);
      return;
    }

    const container = await this.container(input.id);
    const info = await container.inspect();
    const originalEnv = info.Config.Env ?? [];
    const env = originalEnv.filter((entry) => !['TYPE=', 'VERSION=', 'MEMORY=', 'INIT_MEMORY=', 'MAX_MEMORY='].some((prefix) => entry.startsWith(prefix))).concat([
      `TYPE=${input.software}`,
      `VERSION=${input.version}`,
      ...javaMemoryEnvironment(input.memoryMb),
    ]);
    const labels: Record<string, string> = {
      ...info.Config.Labels,
      'padock.server-name': input.name,
      'padock.memory-mb': String(input.memoryMb),
      'padock.cpu-percent': String(input.cpuPercent),
      'padock.disk-mb': String(input.diskMb),
    };
    await container.remove({ force: true });
    try { await this.recreate(info, env, labels, input.memoryMb, input.cpuPercent); }
    catch (error) {
      await this.recreate(info, originalEnv, info.Config.Labels ?? {}).catch(() => undefined);
      throw error;
    }
  }

  async configureCurseForgeServerPack(id: string, input: { software: string; version: string; memoryMb?: number; relativePath: string; projectId: number; fileId: number; filename: string }) {
    if (await this.status(id) !== 'stopped') throw Object.assign(new Error('Arrêtez le serveur avant de changer de modpack.'), { statusCode: 409 });
    const genericPack = containerPackPath(input.relativePath);
    const container = await this.container(id);
    const info = await container.inspect();
    const originalEnv = info.Config.Env ?? [];
    const managedPrefixes = ['TYPE=', 'VERSION=', 'MODPACK_PLATFORM=', 'MOD_PLATFORM=', 'CF_API_KEY=', 'CF_PAGE_URL=', 'CF_SLUG=', 'CF_FILE_ID=', 'CF_FILENAME_MATCHER=', 'CF_FORCE_SYNCHRONIZE=', 'GENERIC_PACK=', 'GENERIC_PACKS=', 'FORCE_GENERIC_PACK_UPDATE=', 'SKIP_GENERIC_PACK_UPDATE_CHECK=', 'SKIP_GENERIC_PACK_CHECKSUM=', 'USE_MODPACK_START_SCRIPT='];
    if (input.memoryMb) managedPrefixes.push('MEMORY=', 'INIT_MEMORY=', 'MAX_MEMORY=');
    const env = originalEnv.filter((entry) => !managedPrefixes.some((prefix) => entry.startsWith(prefix))).concat([
      `TYPE=${input.software}`, `VERSION=${input.version}`, `GENERIC_PACK=${genericPack}`, 'USE_MODPACK_START_SCRIPT=true',
      ...(input.memoryMb ? javaMemoryEnvironment(input.memoryMb) : []),
    ]);
    const labels: Record<string, string> = { ...info.Config.Labels, 'padock.modpack-provider': 'curseforge', 'padock.modpack-mode': 'server-pack', 'padock.modpack-project-id': String(input.projectId), 'padock.modpack-file-id': String(input.fileId), 'padock.modpack-filename': input.filename };
    if (input.memoryMb) labels['padock.memory-mb'] = String(input.memoryMb);
    delete labels['panelmc.modpack-page'];
    delete labels['padock.modpack-page'];
    await container.remove({ force: true });
    try { await this.recreate(info, env, labels, input.memoryMb); }
    catch (error) {
      await this.recreate(info, originalEnv, info.Config.Labels ?? {}).catch(() => undefined);
      throw error;
    }
  }

  async command(id: string, command: string) {
    const container = await this.container(id);
    const info = await container.inspect();
    if (readLabel(info.Config.Labels, 'platform') === 'steamcmd') {
      const stream = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
      stream.write(`${command}\n`);
      stream.end();
      return 'Commande envoyée à l’entrée standard du serveur.';
    }
    const exec = await container.exec({ Cmd: ['rcon-cli', command], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true });
    return await new Promise<string>((resolve, reject) => {
      let output = '';
      stream.on('data', (chunk: Buffer) => { output += chunk.length > 8 ? chunk.subarray(8).toString() : chunk.toString(); });
      stream.on('end', () => resolve(output.trim()));
      stream.on('error', reject);
    });
  }

  async logs(id: string, tail: number) {
    return (await this.container(id)).logs({ follow: true, stdout: true, stderr: true, timestamps: false, tail });
  }

  async minecraftStatus(id: string) {
    const info = await (await this.container(id)).inspect();
    const binding = (info.NetworkSettings?.Ports?.[`${MINECRAFT_INTERNAL_PORT}/tcp`] ?? []).find((entry) => entry !== undefined);
    const host = binding?.HostIp === '0.0.0.0' || binding?.HostIp == null ? '127.0.0.1' : binding.HostIp;
    const port = Number(binding?.HostPort ?? MINECRAFT_INTERNAL_PORT);
    return statusPing(host, port, 3000);
  }

  async updatePorts(id: string, ports: Array<{ internalPort: number; protocol: 'tcp' | 'udp'; hostPort?: number }>) {
    const container = await this.container(id);
    const info = await container.inspect();
    if (readLabel(info.Config.Labels, 'platform') === 'steamcmd') throw Object.assign(new Error('Les ports des serveurs SteamCMD sont définis par le preset du jeu.'), { statusCode: 409 });
    const current = (info.HostConfig.PortBindings as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined) ?? {};
    const gameKey = `${MINECRAFT_INTERNAL_PORT}/tcp`;
    const bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }>> = {};
    const exposed: Record<string, object> = {};
    if (current[gameKey]) { bindings[gameKey] = current[gameKey]!.map((binding) => ({ ...binding })); exposed[gameKey] = {}; }
    for (const port of ports) {
      const key = `${port.internalPort}/${port.protocol}`;
      const existing = current[key]?.[0]?.HostPort ? Number(current[key]![0]!.HostPort) : undefined;
      const hostPort = port.hostPort ?? existing ?? await findFreeHostPort(port.internalPort);
      bindings[key] = [{ HostIp: undefined, HostPort: String(hostPort) }];
      exposed[key] = {};
    }
    info.Config.ExposedPorts = exposed;
    info.HostConfig.PortBindings = bindings;
    const originalExposed = info.Config.ExposedPorts;
    const originalBindings = info.HostConfig.PortBindings;
    await container.remove({ force: true });
    try { await this.recreate(info, info.Config.Env ?? [], info.Config.Labels ?? {}); }
    catch (error) {
      info.Config.ExposedPorts = originalExposed;
      info.HostConfig.PortBindings = originalBindings;
      await this.recreate(info, info.Config.Env ?? [], info.Config.Labels ?? {}).catch(() => undefined);
      throw error;
    }
    return Object.keys(bindings).filter((key) => key !== gameKey).map((key) => {
      const [internalPort, protocol] = key.split('/');
      return { internalPort: Number(internalPort), protocol: protocol as 'tcp' | 'udp', hostPort: Number(bindings[key]![0]!.HostPort ?? 0) };
    });
  }

  async platform(id: string) {
    const info = await (await this.container(id)).inspect();
    return readLabel(info.Config.Labels, 'platform') === 'steamcmd' ? 'steamcmd' as const : 'minecraft' as const;
  }

  async stats(id: string) {
    const value = await (await this.container(id)).stats({ stream: false });
    const cpuDelta = value.cpu_stats.cpu_usage.total_usage - value.precpu_stats.cpu_usage.total_usage;
    const systemDelta = value.cpu_stats.system_cpu_usage - value.precpu_stats.system_cpu_usage;
    const cores = value.cpu_stats.online_cpus ?? value.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
    const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? cpuDelta / systemDelta * cores * 100 : 0;
    const cache = value.memory_stats.stats?.inactive_file ?? value.memory_stats.stats?.cache ?? 0;
    const memoryBytes = Math.max(0, (value.memory_stats.usage ?? 0) - cache);
    const networks = Object.values(value.networks ?? {});
    const currentNetwork: NetworkCounterSample = {
      rxBytes: networks.reduce((total, item) => total + item.rx_bytes, 0),
      txBytes: networks.reduce((total, item) => total + item.tx_bytes, 0),
      measuredAt: Date.now(),
    };
    const networkRates = calculateNetworkRates(currentNetwork, this.networkCounters.get(id));
    this.networkCounters.set(id, currentNetwork);
    return {
      cpuPercent: Math.round(cpuPercent * 100) / 100,
      memoryBytes,
      memoryLimitBytes: value.memory_stats.limit ?? 0,
      networkRxBytes: networkRates.rxBytesPerSecond,
      networkTxBytes: networkRates.txBytesPerSecond,
    };
  }

  async diskUsage(id: string) {
    const cached = this.diskUsageCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.bytes;
    try {
      const bytes = await directorySize(path.join(this.dataDir, id));
      this.diskUsageCache.set(id, { bytes, expiresAt: Date.now() + 60_000 });
      return bytes;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }

  private async container(id: string) {
    const current = this.docker.getContainer(this.containerName(id));
    try { await current.inspect(); return current; }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const legacy = this.docker.getContainer(`panelmc-${id}`);
      try { await legacy.inspect(); return legacy; }
      catch (legacyError) {
        if ((legacyError as { statusCode?: number }).statusCode !== 404) throw legacyError;
        throw Object.assign(new Error(`Conteneur Padock ${id} introuvable.`), { statusCode: 404, code: 'PADOCK_CONTAINER_NOT_FOUND' });
      }
    }
  }

  private containerName(id: string) { return `padock-${id}`; }

  private async recreate(info: Docker.ContainerInspectInfo, env: string[], labels: Record<string, string>, memoryMb?: number, cpuPercent?: number) {
    const memoryBytes = memoryMb ? memoryMb * 1024 * 1024 : info.HostConfig.Memory;
    const originalPortBindings = info.HostConfig.PortBindings as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined;
    const portBindings = GATEWAY_ENABLED && readLabel(labels, 'platform') !== 'steamcmd'
      ? Object.fromEntries(Object.entries(originalPortBindings ?? {}).map(([key, bindings]) => [key, bindings?.map((binding) => key === `${MINECRAFT_INTERNAL_PORT}/tcp` ? { ...binding, HostIp: GATEWAY_BACKEND_BIND } : { ...binding }) ?? []]))
      : info.HostConfig.PortBindings;
    await this.docker.createContainer({
      name: info.Name.replace(/^\//, ''),
      Image: info.Config.Image,
      Env: env,
      Labels: labels,
      ExposedPorts: info.Config.ExposedPorts,
      Cmd: info.Config.Cmd,
      Entrypoint: info.Config.Entrypoint,
      WorkingDir: info.Config.WorkingDir,
      OpenStdin: info.Config.OpenStdin,
      StdinOnce: info.Config.StdinOnce,
      Tty: info.Config.Tty,
      HostConfig: {
        Binds: info.HostConfig.Binds,
        PortBindings: portBindings,
        RestartPolicy: info.HostConfig.RestartPolicy,
        Memory: memoryBytes,
        MemorySwap: memoryMb ? memoryBytes : info.HostConfig.MemorySwap,
        NanoCpus: cpuPercent ? Math.round(cpuPercent / 100 * 1_000_000_000) : info.HostConfig.NanoCpus,
      },
    });
  }

  private async ensureImage(image: string) {
    const current = this.imageReady.get(image);
    if (current) return current;
    const pending = this.prepareImage(image);
    this.imageReady.set(image, pending);
    try { await pending; }
    catch (error) { this.imageReady.delete(image); throw error; }
  }

  private async prepareImage(image: string) {
    try { await this.docker.getImage(image).inspect(); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve()));
    }
  }
}

export function javaMemoryEnvironment(containerMemoryMb: number) {
  const maximumMb = Math.max(768, Math.floor(containerMemoryMb * 0.8));
  const initialMb = Math.min(maximumMb, Math.max(512, Math.min(2048, Math.floor(maximumMb * 0.25))));
  return [`INIT_MEMORY=${initialMb}M`, `MAX_MEMORY=${maximumMb}M`];
}

export function calculateNetworkRates(current: NetworkCounterSample, previous?: NetworkCounterSample) {
  if (!previous || current.measuredAt <= previous.measuredAt || current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return { rxBytesPerSecond: 0, txBytesPerSecond: 0 };
  }
  const elapsedSeconds = (current.measuredAt - previous.measuredAt) / 1000;
  return {
    rxBytesPerSecond: Math.round((current.rxBytes - previous.rxBytes) / elapsedSeconds),
    txBytesPerSecond: Math.round((current.txBytes - previous.txBytes) / elapsedSeconds),
  };
}

function containerPackPath(relativePath: string) {
  if (!/^\.(?:padock|panelmc)\/server-packs\/[a-zA-Z0-9._+()-]+\.zip$/.test(relativePath)) {
    throw Object.assign(new Error('Chemin de server pack invalide.'), { statusCode: 400 });
  }
  return `/data/${relativePath}`;
}

function readLabel(labels: Record<string, string> | undefined, name: string) {
  return labels?.[`padock.${name}`] ?? labels?.[`panelmc.${name}`];
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset: number) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: value >>> 0, offset: index };
}

function statusPing(host: string, port: number, timeoutMs: number): Promise<{ online: number; max: number } | null> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result: { online: number; max: number } | null) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolve(result); } };
    timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('connect', () => {
      try {
        const address = Buffer.from(host, 'utf8');
        const handshake = Buffer.concat([writeVarInt(0), writeVarInt(-1), writeVarInt(address.length), address, ushort(port), writeVarInt(1)]);
        socket.write(Buffer.concat([writeVarInt(handshake.length), handshake, writeVarInt(1), writeVarInt(0)]));
      } catch { finish(null); }
    });
    let received = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      try {
        const { value: frameLength, offset: afterLength } = readVarInt(received, 0);
        if (afterLength + frameLength > received.length) return;
        const { value: packetId, offset: afterId } = readVarInt(received, afterLength);
        if (packetId !== 0) return finish(null);
        const { value: jsonLength, offset: jsonStart } = readVarInt(received, afterId);
        if (jsonStart + jsonLength > received.length) return;
        const status = JSON.parse(received.subarray(jsonStart, jsonStart + jsonLength).toString('utf8')) as { players?: { online?: number; max?: number } };
        finish(status.players?.online != null && status.players?.max != null ? { online: status.players.online, max: status.players.max } : null);
      } catch { return; }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

function ushort(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function findFreeHostPort(preferred: number) {
  return isPortListening(preferred).then((occupied) => occupied ? ephemeralFreePort() : preferred);
}

function isPortListening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function ephemeralFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function existingServerPack(dataDir: string, id: string) {
  for (const metadataDirectory of ['.padock', '.panelmc']) {
    const directory = path.join(dataDir, id, metadataDirectory, 'server-packs');
    try {
      const archives = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
        .sort((left, right) => left.name.localeCompare(right.name));
      const archive = archives.at(-1);
      if (archive) return { relativePath: `${metadataDirectory}/server-packs/${archive.name}`, projectId: 0, fileId: 0, filename: archive.name };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
