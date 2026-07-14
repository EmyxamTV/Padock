import type { AuditEntry } from '../api';

export function AuditView({ entries }: { entries: AuditEntry[] }) {
  return <div className="table-card"><table><thead><tr><th>DATE</th><th>UTILISATEUR</th><th>ACTION</th><th>CIBLE</th><th>DÉTAILS</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString('fr-FR')}</td><td>{entry.user?.username ?? 'Système'}</td><td><code>{entry.action}</code></td><td>{entry.targetType}{entry.targetId ? ` · ${entry.targetId}` : ''}</td><td className="audit-meta">{Object.keys(entry.metadata).length ? JSON.stringify(entry.metadata) : '—'}</td></tr>)}</tbody></table></div>;
}
