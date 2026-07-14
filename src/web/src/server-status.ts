import type { Server } from './api';

export const serverStatusLabels: Record<Server['status'], string> = {
  running: 'En ligne',
  stopped: 'Arrêté',
  missing: 'Introuvable',
  starting: 'Démarrage',
  installing: 'Installation',
  failed: 'Installation échouée',
  unavailable: 'Nœud hors ligne',
};

export function serverDiagnostic(server: Server): { level: 'warning' | 'danger'; message: string } | undefined {
  if (server.status === 'unavailable') return { level: 'danger', message: 'L’agent du nœud ne répond pas.' };
  if (server.status === 'missing') return { level: 'danger', message: 'Le conteneur Docker est introuvable.' };
  if (server.status === 'failed') return { level: 'danger', message: 'L’installation a échoué. Consultez le centre des opérations pour relancer.' };
  if (server.status === 'running' && server.runtime?.health === 'unhealthy') return { level: 'warning', message: 'Minecraft ne répond pas encore au healthcheck.' };
  if (server.status !== 'stopped') return undefined;
  if (server.runtime?.oomKilled || server.runtime?.exitCode === 137) {
    return { level: 'danger', message: 'Dernier démarrage interrompu par manque de mémoire.' };
  }
  if (server.runtime?.exitCode && server.runtime.exitCode !== 0) {
    return { level: 'warning', message: `Dernier arrêt avec le code ${server.runtime.exitCode}. Consultez la console.` };
  }
  if (server.runtime?.error) return { level: 'warning', message: server.runtime.error };
  return undefined;
}
