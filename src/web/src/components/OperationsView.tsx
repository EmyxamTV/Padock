import { api, type PanelJob, type PanelNotification } from '../api';

export function OperationsView({ jobs, notifications, onChanged, onOpenServer }: { jobs: PanelJob[]; notifications: PanelNotification[]; onChanged: () => void; onOpenServer: (id: string) => void }) {
  async function retry(id: string) { await api(`/api/jobs/${id}/retry`, { method: 'POST' }); onChanged(); }
  async function cancel(id: string) { if (!confirm('Annuler cette opération en attente ?')) return; await api(`/api/jobs/${id}`, { method: 'DELETE' }); onChanged(); }
  async function readAll() { await api('/api/notifications/read-all', { method: 'POST' }); onChanged(); }
  return <div className="operations-layout">
    <section className="content-panel operations-panel">
      <div className="content-toolbar"><div><p className="eyebrow">FILE PERSISTANTE</p><h2>Opérations</h2><small>Les opérations continuent même si vous fermez cette page.</small></div><span className="role-badge active">{jobs.filter((job) => job.status === 'running' || job.status === 'queued').length} active(s)</span></div>
      <div className="operation-list">{jobs.map((job) => <article key={job.id} className={`operation-item ${job.status}`}>
        <span className="operation-icon">{jobIcon(job.kind)}</span><div className="operation-main"><div><strong>{jobLabel(job.kind)}</strong><span className={`result ${job.status}`}>{statusLabel(job.status)}</span></div><small>{job.step} · {new Date(job.updatedAt).toLocaleString('fr-FR')}</small><progress value={job.progress} max={100}/>{job.error && <p className="operation-error">{job.error}</p>}</div>
        <div className="operation-actions">{job.serverId && <button className="secondary compact" onClick={() => onOpenServer(job.serverId!)}>Serveur</button>}{job.status === 'failed' && <button className="secondary compact" onClick={() => retry(job.id)}>Relancer</button>}{job.status === 'queued' && <button className="table-action" onClick={() => cancel(job.id)}>Annuler</button>}</div>
      </article>)}{!jobs.length && <p className="panel-empty">Aucune opération enregistrée.</p>}</div>
    </section>
    <section className="content-panel notification-panel">
      <div className="content-toolbar"><div><p className="eyebrow">ALERTES</p><h2>Notifications</h2><small>Crashs, stockage, sauvegardes et infrastructure</small></div><button className="secondary compact" onClick={readAll}>Tout marquer comme lu</button></div>
      <div className="notification-list">{notifications.map((item) => <button key={item.id} className={`${item.level} ${item.readAt ? 'read' : ''}`} onClick={() => item.link?.startsWith('server:') && onOpenServer(item.link.slice(7))}><span>{notificationIcon(item.level)}</span><div><strong>{item.title}</strong><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleString('fr-FR')}</small></div></button>)}{!notifications.length && <p className="panel-empty">Aucune notification.</p>}</div>
    </section>
  </div>;
}

function jobLabel(kind: PanelJob['kind']) { return ({ 'server.create': 'Création de serveur', 'server.clone': 'Clonage de serveur', 'server.transfer': 'Transfert entre nœuds', 'server.repair': 'Réparation du conteneur', 'server.upgrade': 'Mise à niveau Minecraft', 'backup.create': 'Création de sauvegarde', 'backup.restore': 'Restauration de sauvegarde', 'content.modpack': 'Installation du modpack' })[kind]; }
function jobIcon(kind: PanelJob['kind']) { if (kind.startsWith('backup.')) return '◫'; if (kind === 'server.transfer') return '⇄'; if (kind === 'server.clone') return '⧉'; if (kind === 'content.modpack') return '◆'; return '▧'; }
function statusLabel(status: PanelJob['status']) { return ({ queued: 'En attente', running: 'En cours', completed: 'Terminée', failed: 'Échec', cancelled: 'Annulée' })[status]; }
function notificationIcon(level: PanelNotification['level']) { return level === 'error' ? '!' : level === 'warning' ? '△' : level === 'success' ? '✓' : 'i'; }
