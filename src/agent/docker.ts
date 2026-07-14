import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import Docker from 'dockerode';
import { padockEnv } from './config.js';

const IMAGE = padockEnv('MINECRAFT_IMAGE') ?? 'itzg/minecraft-server:java25';
const GATEWAY_ENABLED = padockEnv('GATEWAY_ENABLED') === 'true';
const GATEWAY_BACKEND_BIND = padockEnv('GATEWAY_BACKEND_BIND')?.trim() || '127.0.0.1';

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

export interface NetworkCounterSample { rxBytes: number; txBytes: number; measuredAt: number }

export class NodeDocker {
  readonly docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock') });
  private imageReady?: Promise<void>;
  private readonly diskUsageCache = new Map<string, { bytes: number; expiresAt: number }>();
  private readonly networkCounters = new Map<string, NetworkCounterSample>();

  constructor(private dataDir: string) {}

  async health() {
    await this.docker.ping();
  }

  async create(input: { id: string; name: string; software: string; version: string; memoryMb: number; cpuPercent: number; diskMb: number; port: number }, serverPack?: { relativePath: string; projectId: number; fileId: number; filename: string }) {
    const serverDir = path.join(this.dataDir, input.id);
    const genericPack = serverPack ? containerPackPath(serverPack.relativePath) : undefined;
    await mkdir(serverDir, { recursive: true });
    await this.ensureImage();
    const env = [
      'EULA=TRUE', `TYPE=${input.software}`, `VERSION=${input.version}`, ...javaMemoryEnvironment(input.memoryMb),
      'ENABLE_RCON=true', 'ONLINE_MODE=true', 'USE_AIKAR_FLAGS=true',
    ];
    if (genericPack) env.push(`GENERIC_PACK=${genericPack}`, 'USE_MODPACK_START_SCRIPT=true');
    const labels: Record<string, string> = { 'padock.managed': 'true', 'padock.server-id': input.id, 'padock.server-name': input.name, 'padock.memory-mb': String(input.memoryMb), 'padock.disk-mb': String(input.diskMb), 'padock.cpu-percent': String(input.cpuPercent) };
    if (serverPack) {
      labels['padock.modpack-provider'] = 'curseforge';
      labels['padock.modpack-mode'] = 'server-pack';
      labels['padock.modpack-project-id'] = String(serverPack.projectId);
      labels['padock.modpack-file-id'] = String(serverPack.fileId);
      labels['padock.modpack-filename'] = serverPack.filename;
    }
    const container = await this.docker.createContainer({
      name: this.containerName(input.id),
      Image: IMAGE,
      Env: env,
      Labels: labels,
      ExposedPorts: { '25565/tcp': {} },
      HostConfig: {
        Binds: [`${serverDir}:/data`],
        PortBindings: { '25565/tcp': [{ HostIp: GATEWAY_ENABLED ? GATEWAY_BACKEND_BIND : undefined, HostPort: String(input.port) }] },
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: input.memoryMb * 1024 * 1024,
        MemorySwap: input.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(input.cpuPercent / 100 * 1_000_000_000),
      },
    });
    return container.id;
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
    const env = originalEnv.filter((entry) => !['MEMORY=', 'INIT_MEMORY=', 'MAX_MEMORY='].some((prefix) => entry.startsWith(prefix)))
      .concat(javaMemoryEnvironment(input.memoryMb));
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

  async repair(input: { id: string; name: string; software: string; version: string; memoryMb: number; cpuPercent: number; diskMb: number; port: number }) {
    const current = await this.state(input.id);
    if (current.status === 'running' || current.status === 'starting') {
      throw Object.assign(new Error('Arrêtez le serveur avant de réparer son conteneur.'), { statusCode: 409 });
    }
    if (current.status === 'missing') {
      const serverPack = await existingServerPack(this.dataDir, input.id);
      await this.create(input, serverPack);
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
    const exec = await (await this.container(id)).exec({ Cmd: ['rcon-cli', command], AttachStdout: true, AttachStderr: true });
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
    const portBindings = GATEWAY_ENABLED
      ? Object.fromEntries(Object.entries(originalPortBindings ?? {}).map(([key, bindings]) => [key, bindings?.map((binding) => ({ ...binding, HostIp: GATEWAY_BACKEND_BIND })) ?? []]))
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

  private async ensureImage() {
    if (this.imageReady) return this.imageReady;
    this.imageReady = this.prepareImage();
    try { await this.imageReady; }
    catch (error) { this.imageReady = undefined; throw error; }
  }

  private async prepareImage() {
    try { await this.docker.getImage(IMAGE).inspect(); }
    catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      const stream = await this.docker.pull(IMAGE);
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
