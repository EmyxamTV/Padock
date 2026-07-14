import type { MinecraftServer } from './types.js';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const CLASS_IDS = { plugin: 5, mod: 6, modpack: 4471 } as const;

export type ContentKind = keyof typeof CLASS_IDS;
type SoftwareContext = Pick<MinecraftServer, 'software'>;

export interface CurseForgeProject {
  id: number;
  slug: string;
  title: string;
  description: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  updatedAt: string;
  projectType: ContentKind;
  categories?: string[];
  minecraftVersion?: string;
  recommendedMemoryMb?: number;
  recommendedDiskMb?: number;
}

export interface CurseForgeFile {
  projectId: number;
  fileId: number;
  displayName: string;
  url: string;
  filename: string;
  hash: string;
  algorithm: 'sha1' | 'md5';
  size: number;
}

interface ApiProject {
  id: number;
  name: string;
  slug: string;
  summary: string;
  downloadCount: number;
  dateModified: string;
  authors: Array<{ name: string }>;
  logo?: { thumbnailUrl?: string };
  latestFiles?: ApiFile[];
  categories?: Array<{ name: string }>;
}

interface ApiFile {
  id: number;
  modId: number;
  displayName: string;
  fileName: string;
  releaseType: number;
  fileLength: number;
  downloadUrl?: string;
  hashes: Array<{ value: string; algo: number }>;
  dependencies: Array<{ modId: number; relationType: number }>;
  isServerPack?: boolean;
  serverPackFileId?: number;
  gameVersions?: string[];
  sortableGameVersions?: Array<{ gameVersion?: string; gameVersionName?: string }>;
}

export function curseForgeConfigured() { return Boolean(process.env.CURSEFORGE_API_KEY?.trim()); }

export function allowedKinds(server: SoftwareContext): ContentKind[] {
  if (server.software === 'PAPER' || server.software === 'PURPUR') return ['plugin'];
  if (server.software === 'FABRIC' || server.software === 'FORGE' || server.software === 'NEOFORGE') return ['mod', 'modpack'];
  return [];
}

export async function searchCurseForge(server: SoftwareContext, kind: ContentKind, query: string, minecraftVersion?: string): Promise<CurseForgeProject[]> {
  assertKind(server, kind);
  const params = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID), classId: String(CLASS_IDS[kind]), pageSize: '24', sortField: '2', sortOrder: 'desc',
  });
  if (query) params.set('searchFilter', query);
  if (minecraftVersion) params.set('gameVersion', minecraftVersion);
  const loader = loaderType(server);
  if (loader && kind !== 'plugin') params.set('modLoaderType', String(loader));
  const result = await request<{ data: ApiProject[] }>(`/mods/search?${params}`);
  const projects = kind === 'modpack'
    ? result.data.filter((project) => project.latestFiles?.some((file) => compatibleServerPackFile(file, server, minecraftVersion)))
    : result.data;
  return projects.map((project) => {
    const serverPackFile = kind === 'modpack'
      ? project.latestFiles?.find((file) => compatibleServerPackFile(file, server, minecraftVersion))
      : undefined;
    const recommendation = serverPackFile ? recommendedResources(project, serverPackFile) : undefined;
    return {
      id: project.id, slug: project.slug, title: project.name, description: project.summary,
      author: project.authors[0]?.name ?? 'CurseForge', iconUrl: project.logo?.thumbnailUrl,
      downloads: project.downloadCount, updatedAt: project.dateModified, projectType: kind,
      categories: project.categories?.map((category) => category.name) ?? [],
      minecraftVersion: serverPackFile ? detectMinecraftVersion(serverPackFile, minecraftVersion) : undefined,
      recommendedMemoryMb: recommendation?.memoryMb,
      recommendedDiskMb: recommendation?.diskMb,
    };
  });
}

function compatibleServerPackFile(file: ApiFile, server: SoftwareContext, minecraftVersion?: string) {
  if (file.isServerPack || !file.serverPackFileId || !file.fileName.toLowerCase().endsWith('.zip')) return false;
  const versions = file.gameVersions?.map((value) => value.toLowerCase()) ?? [];
  if (minecraftVersion && !versions.includes(minecraftVersion.toLowerCase())) return false;
  return versions.includes(server.software.toLowerCase());
}

function recommendedResources(project: ApiProject, file: ApiFile) {
  const categories = project.categories?.map((category) => category.name.toLowerCase()) ?? [];
  const sizeMb = file.fileLength / 1024 / 1024;
  if (categories.includes('extra large') || sizeMb >= 150) return { memoryMb: 10240, diskMb: 32768 };
  if (sizeMb >= 75) return { memoryMb: 8192, diskMb: 24576 };
  return { memoryMb: 6144, diskMb: 16384 };
}

export async function resolveCurseForgeFiles(server: SoftwareContext, kind: 'plugin' | 'mod', projectId: number, minecraftVersion?: string) {
  assertKind(server, kind);
  const first = await compatibleFile(server, kind, projectId, minecraftVersion, '.jar');
  if (!first) throw httpError(404, `Aucun fichier CurseForge compatible${minecraftVersion ? ` avec Minecraft ${minecraftVersion}` : ''}.`);
  const resolved: CurseForgeFile[] = [];
  const visited = new Set<number>();
  await resolveWithDependencies(first, server, kind, minecraftVersion, resolved, visited);
  return resolved;
}

export async function resolveCurseForgeModpack(server: SoftwareContext, projectId: number, slug: string, minecraftVersion?: string) {
  assertKind(server, 'modpack');
  if (!/^[a-z0-9-]{2,100}$/i.test(slug)) throw httpError(400, 'Slug CurseForge invalide.');
  const file = await compatibleFile(server, 'modpack', projectId, minecraftVersion, '.zip');
  if (!file) throw httpError(404, `Aucun server pack CurseForge compatible${minecraftVersion ? ` avec Minecraft ${minecraftVersion}` : ''} et ce loader.`);
  if (!file.serverPackFileId) throw httpError(409, `${file.fileName} ne fournit aucun server pack CurseForge.`);
  const result = await request<{ data: ApiFile }>(`/mods/${projectId}/files/${file.serverPackFileId}`);
  const serverPack = result.data;
  if (!serverPack.isServerPack || !serverPack.fileName.toLowerCase().endsWith('.zip')) {
    throw httpError(409, 'Le fichier serveur CurseForge est absent ou n’est pas une archive ZIP compatible.');
  }
  return {
    ...await downloadable(serverPack),
    mainFileId: file.id,
    mainFilename: file.fileName,
    minecraftVersion: minecraftVersionFor(file, minecraftVersion),
    slug,
  };
}

async function resolveWithDependencies(file: ApiFile, server: SoftwareContext, kind: 'plugin' | 'mod', minecraftVersion: string | undefined, resolved: CurseForgeFile[], visited: Set<number>) {
  if (visited.has(file.modId)) return;
  if (visited.size >= 25) throw httpError(400, 'La chaîne de dépendances dépasse la limite de sécurité.');
  visited.add(file.modId);
  resolved.push(await downloadable(file));
  for (const dependency of file.dependencies.filter((item) => item.relationType === 3)) {
    const dependencyFile = await compatibleFile(server, kind, dependency.modId, minecraftVersion, '.jar');
    if (dependencyFile) await resolveWithDependencies(dependencyFile, server, kind, minecraftVersion, resolved, visited);
  }
}

async function compatibleFile(server: SoftwareContext, kind: ContentKind, projectId: number, minecraftVersion: string | undefined, extension: '.jar' | '.zip') {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw httpError(400, 'Projet CurseForge invalide.');
  const params = new URLSearchParams({ pageSize: '50' });
  if (minecraftVersion) params.set('gameVersion', minecraftVersion);
  const loader = loaderType(server);
  if (loader && kind !== 'plugin') params.set('modLoaderType', String(loader));
  const result = await request<{ data: ApiFile[] }>(`/mods/${projectId}/files?${params}`);
  // La sélection initiale porte sur le fichier principal afin de trouver son
  // serverPackFileId. L’archive effectivement installée est ensuite le server pack.
  const candidates = result.data.filter((file) => file.fileName.toLowerCase().endsWith(extension) && (kind !== 'modpack' || (!file.isServerPack && Boolean(file.serverPackFileId))));
  return candidates.find((file) => file.releaseType === 1) ?? candidates[0];
}

async function downloadable(file: ApiFile): Promise<CurseForgeFile> {
  const sha1 = file.hashes.find((hash) => hash.algo === 1);
  const md5 = file.hashes.find((hash) => hash.algo === 2);
  const hash = sha1 ?? md5;
  if (!hash) throw httpError(404, `${file.fileName} ne fournit aucune empreinte vérifiable.`);
  let url = file.downloadUrl;
  if (!url) {
    const result = await request<{ data?: string }>(`/mods/${file.modId}/files/${file.id}/download-url`);
    url = result.data;
  }
  if (!url) throw httpError(409, `${file.fileName} interdit le téléchargement par des applications tierces.`);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !allowedCdnHost(parsed.hostname)) throw httpError(400, 'La source du fichier CurseForge n’est pas autorisée.');
  return {
    projectId: file.modId, fileId: file.id, displayName: file.displayName, url, filename: file.fileName,
    hash: hash.value, algorithm: hash.algo === 1 ? 'sha1' : 'md5', size: file.fileLength,
  };
}

function assertKind(server: SoftwareContext, kind: ContentKind) {
  if (!allowedKinds(server).includes(kind)) throw httpError(400, `${kind === 'plugin' ? 'Les plugins' : 'Ce contenu'} ne sont pas compatibles avec ${server.software}.`);
}

function loaderType(server: SoftwareContext) {
  if (server.software === 'FORGE') return 1;
  if (server.software === 'FABRIC') return 4;
  if (server.software === 'NEOFORGE') return 6;
  return undefined;
}

function minecraftVersionFor(file: ApiFile, requested?: string) {
  const detected = detectMinecraftVersion(file, requested);
  if (detected) return detected;
  throw httpError(409, `Impossible de déterminer la version Minecraft de ${file.fileName}. Indiquez une version précise.`);
}

function detectMinecraftVersion(file: ApiFile, requested?: string) {
  if (requested) return requested;
  const sortableVersion = file.sortableGameVersions
    ?.map((entry) => entry.gameVersion?.trim())
    .find((version): version is string => Boolean(version));
  if (sortableVersion) return sortableVersion;
  const loaderNames = new Set(['forge', 'neoforge', 'fabric', 'quilt', 'liteloader', 'rift', 'java']);
  const fileVersion = file.gameVersions
    ?.map((version) => version.trim())
    .find((version) => version && !loaderNames.has(version.toLowerCase()));
  if (fileVersion) return fileVersion;
  return undefined;
}

function allowedCdnHost(hostname: string) {
  return hostname === 'media.forgecdn.net' || hostname === 'mediafilez.forgecdn.net' || hostname === 'edge.forgecdn.net' || hostname.endsWith('.forgecdn.net');
}

async function request<T>(route: string): Promise<T> {
  const apiKey = process.env.CURSEFORGE_API_KEY?.trim();
  if (!apiKey) throw httpError(503, 'Ajoutez CURSEFORGE_API_KEY dans le fichier .env pour activer le catalogue CurseForge.');
  const response = await fetch(`${API}${route}`, { headers: { 'x-api-key': apiKey, Accept: 'application/json', 'User-Agent': 'Padock/1.0.0' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const message = response.status === 403 ? 'La clé API CurseForge est invalide ou n’a pas accès à cette ressource.' : `CurseForge a répondu HTTP ${response.status}.`;
    throw httpError(response.status === 404 ? 404 : response.status === 403 ? 503 : 502, message);
  }
  return await response.json() as T;
}

function httpError(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
