export type SteamPortProtocol = 'tcp' | 'udp';

export interface SteamGamePortPreset {
  name: string;
  internalPort: number;
  allocationOffset: number;
  protocol: SteamPortProtocol;
}

export interface SteamGamePreset {
  id: string;
  name: string;
  description: string;
  appId: number;
  startupCommand: string;
  ports: SteamGamePortPreset[];
  recommendedMemoryMb: number;
  recommendedDiskMb: number;
}

export const steamGames: SteamGamePreset[] = [
  {
    id: 'rust',
    name: 'Rust',
    description: 'Serveur Rust vanilla avec monde procédural et mise à jour automatique au démarrage.',
    appId: 258550,
    startupCommand: './RustDedicated -batchmode +server.port "$PADOCK_GAME_PORT" +server.queryport "$PADOCK_QUERY_PORT" +server.identity padock +server.hostname "$PADOCK_SERVER_NAME" +server.maxplayers 50 +server.worldsize 3000',
    ports: [
      { name: 'Jeu', internalPort: 28015, allocationOffset: 0, protocol: 'udp' },
      { name: 'Requêtes Steam', internalPort: 28016, allocationOffset: 1, protocol: 'udp' },
    ],
    recommendedMemoryMb: 12288,
    recommendedDiskMb: 30720,
  },
  {
    id: 'garrys-mod',
    name: "Garry's Mod",
    description: 'Serveur sandbox Garry’s Mod démarré sur gm_construct avec 16 joueurs.',
    appId: 4020,
    startupCommand: './srcds_run -game garrysmod -console -usercon -port "$PADOCK_GAME_PORT" +gamemode sandbox +map gm_construct +maxplayers 16',
    ports: [
      { name: 'Jeu TCP', internalPort: 27015, allocationOffset: 0, protocol: 'tcp' },
      { name: 'Jeu UDP', internalPort: 27015, allocationOffset: 0, protocol: 'udp' },
    ],
    recommendedMemoryMb: 4096,
    recommendedDiskMb: 15360,
  },
  {
    id: '7-days-to-die',
    name: '7 Days to Die',
    description: 'Serveur dédié 7 Days to Die utilisant le fichier serverconfig.xml fourni par le jeu.',
    appId: 294420,
    startupCommand: './startserver.sh -configfile=serverconfig.xml',
    ports: [
      { name: 'Jeu TCP', internalPort: 26900, allocationOffset: 0, protocol: 'tcp' },
      { name: 'Jeu UDP', internalPort: 26900, allocationOffset: 0, protocol: 'udp' },
      { name: 'Steam UDP', internalPort: 26901, allocationOffset: 1, protocol: 'udp' },
      { name: 'Steam UDP secondaire', internalPort: 26902, allocationOffset: 2, protocol: 'udp' },
    ],
    recommendedMemoryMb: 8192,
    recommendedDiskMb: 30720,
  },
];

export function steamGameById(id: string) {
  return steamGames.find((game) => game.id === id);
}

export function steamAllocationOffsets(game: SteamGamePreset) {
  return [...new Set(game.ports.map((port) => port.allocationOffset))].sort((left, right) => left - right);
}
