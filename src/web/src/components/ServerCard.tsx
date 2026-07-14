import type { Server } from '../api';
import { formatMemory } from '../App';
import { serverDiagnostic, serverStatusLabels } from '../server-status';

export function ServerCard({ server, onClick }: { server: Server; onClick: () => void }) {
  const diagnostic = serverDiagnostic(server);
  return <button className="server-card" onClick={onClick}>
    <div className="server-card-head"><div className="server-avatar">▧</div><span className={`badge ${server.status}`}><span />{serverStatusLabels[server.status]}</span></div>
    <h3>{server.name}</h3><p>{server.software} · {server.version}</p>
    {diagnostic && <div className={`server-diagnostic ${diagnostic.level}`}>! {diagnostic.message}</div>}
    <div className="server-meta"><span><small>RAM</small>{formatMemory(server.memoryMb)}</span><span className="server-card-address"><small>{server.domain ? 'ADRESSE' : 'PORT'}</small>{server.domain ?? server.port}</span><span className="arrow">→</span></div>
  </button>;
}
