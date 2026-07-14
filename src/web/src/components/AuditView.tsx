import type { AuditEntry } from '../api';

export function AuditView({ entries }: { entries: AuditEntry[] }) {
  return <div className="table-card"><table><thead><tr><th>DATE</th><th>UTILISATEUR</th><th>ACTION</th><th>CIBLE</th><th>DÉTAILS</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString('fr-FR')}</td><td>{entry.user?.username ?? 'Système'}</td><td><code>{auditLabel(entry.action)}</code></td><td>{entry.targetType}{entry.targetId ? ` · ${entry.targetId}` : ''}</td><td className="audit-meta">{Object.keys(entry.metadata).length ? JSON.stringify(entry.metadata) : '—'}</td></tr>)}</tbody></table></div>;
}

function auditLabel(action: string) {
  const labels: Record<string, string> = {
    'panel.setup': 'Panel initialisé', 'auth.login': 'Connexion', 'auth.logout': 'Déconnexion',
    'user.create': 'Utilisateur créé', 'user.permissions_update': 'Droits utilisateur modifiés', 'user.profile_update': 'Profil modifié', 'user.delete': 'Utilisateur supprimé',
    'role.create': 'Rôle créé', 'role.update': 'Rôle modifié', 'role.delete': 'Rôle supprimé',
    'node.create': 'Nœud créé', 'node.update': 'Nœud modifié', 'allocation.create_range': 'Plage de ports ajoutée', 'allocation.delete': 'Allocation retirée',
    'server.member_update': 'Accès serveur modifié', 'server.member_remove': 'Accès serveur retiré',
  };
  return labels[action] ?? action.replaceAll('.', ' · ');
}
