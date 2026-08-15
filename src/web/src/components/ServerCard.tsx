import type { Server } from '../api';
import { formatMemory } from '../App';
import { serverDiagnostic, serverStatusLabels } from '../server-status';

export function ServerCard({ server, onClick }: { server: Server; onClick: () => void }) {
  const diagnostic = serverDiagnostic(server);
  const description = server.platform === 'steamcmd' ? `${server.steam?.gameName ?? server.version} · SteamCMD` : server.software === 'CUSTOM' ? 'Jar personnalisé' : `${server.software} · ${server.version}`;
  return <button className="server-card" onClick={onClick}>
    <div className="server-card-head"><div className="server-avatar">{server.platform === 'steamcmd' ? 'S' : '▧'}</div><span className={`badge ${server.status}`}><span />{serverStatusLabels[server.status]}</span></div>
    <h3>{server.name}</h3><p>{description}</p>
    {diagnostic && <div className={`server-diagnostic ${diagnostic.level}`}>! {diagnostic.message}</div>}
    <div className="server-meta"><span><small>RAM</small>{formatMemory(server.memoryMb)}</span><span className="server-card-address"><small>{server.domain ? 'ADRESSE' : server.ports.length > 1 ? 'PORTS' : 'PORT'}</small>{server.domain ?? (server.ports.length > 1 ? `${server.port} +${server.ports.length - 1}` : server.port)}</span><span className="arrow">→</span></div>
  </button>;
}
