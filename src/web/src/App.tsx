import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type AuditEntry, type GatewayStatus, type NodeRecord, type Server, type UserRecord } from './api';
import { Auth } from './components/Auth';
import { CreateServer } from './components/CreateServer';
import { ServerCard } from './components/ServerCard';
import { ServerDetail } from './components/ServerDetail';
import { UsersView } from './components/UsersView';
import { AuditView } from './components/AuditView';
import { ProfileView } from './components/ProfileView';

type Section = 'dashboard' | 'nodes' | 'users' | 'audit' | 'profile';

export function App() {
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [me, setMe] = useState<UserRecord>();
  const [servers, setServers] = useState<Server[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [gateway, setGateway] = useState<GatewayStatus>({ enabled: false, configured: false, publicPort: 25565, routes: 0 });
  const [selectedId, setSelectedId] = useState<string>();
  const [section, setSection] = useState<Section>('dashboard');
  const [creating, setCreating] = useState(false);
  const [creatingServer, setCreatingServer] = useState(false);
  const [createError, setCreateError] = useState('');
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [serverList, nodeList, gatewayStatus] = await Promise.all([api<Server[]>('/api/servers'), api<NodeRecord[]>('/api/nodes'), api<GatewayStatus>('/api/gateway')]);
      setServers(serverList); setNodes(nodeList); setGateway(gatewayStatus);
      if (me?.role === 'admin') {
        const [userList, auditList] = await Promise.all([api<UserRecord[]>('/api/users'), api<AuditEntry[]>('/api/audit')]);
        setUsers(userList); setAudits(auditList);
      }
    } catch (err) { setError((err as Error).message); }
  }, [me?.role]);

  useEffect(() => {
    Promise.all([api<{ initialized: boolean }>('/api/auth/status'), api<UserRecord>('/api/auth/me').catch(() => null)])
      .then(([status, user]) => { if (user) setMe(user); setAuth(user ? 'ready' : status.initialized ? 'login' : 'setup'); });
  }, []);

  useEffect(() => {
    if (auth !== 'ready' || !me) return;
    loadData(); const timer = window.setInterval(loadData, 5000);
    return () => window.clearInterval(timer);
  }, [auth, me, loadData]);

  async function authenticated() { const user = await api<UserRecord>('/api/auth/me'); setMe(user); setAuth('ready'); }
  async function logout() { await api('/api/auth/logout', { method: 'POST' }); setServers([]); setMe(undefined); setAuth('login'); }
  function navigate(next: Section) { setSelectedId(undefined); setSection(next); }
  function openCreate() { setCreateError(''); setCreating(true); }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (creatingServer) return; setCreatingServer(true); setCreateError(''); const form = new FormData(event.currentTarget);
    try {
      const modpackProjectId = Number(form.get('modpackProjectId'));
      const modpackSlug = String(form.get('modpackSlug') ?? '');
      const portValue = form.get('port');
      const subdomain = String(form.get('subdomain') ?? '').trim();
      const server = await api<Server>('/api/servers', { method: 'POST', body: JSON.stringify({
        name: form.get('name'), software: form.get('software'), version: form.get('version'), nodeId: form.get('nodeId'), ownerId: form.get('ownerId'),
        memoryMb: Number(form.get('memoryMb')), cpuPercent: Number(form.get('cpuPercent')), diskMb: Number(form.get('diskMb')),
        port: portValue ? Number(portValue) : undefined, subdomain: subdomain || undefined,
        modpack: modpackProjectId > 0 && modpackSlug ? { projectId: modpackProjectId, slug: modpackSlug } : undefined,
      }) });
      setServers((current) => [...current, server]); setCreating(false); setCreateError(''); setSelectedId(server.id);
    } catch (err) { setCreateError((err as Error).message); }
    finally { setCreatingServer(false); }
  }

  if (auth === 'loading') return <div className="splash"><div className="brand-mark">P</div><p>Chargement de Padock…</p></div>;
  if (auth !== 'ready') return <Auth mode={auth} onSuccess={authenticated} />;
  const selected = servers.find((server) => server.id === selectedId);
  const admin = me?.role === 'admin';
  const titles: Record<Section, string> = { dashboard: 'Vue générale', nodes: 'Nœuds de calcul', users: 'Utilisateurs', audit: 'Journal d’audit', profile: 'Mon profil' };

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">P</span><div><strong>Padock</strong><small>SERVER CONTROL</small></div></div>
      <nav>
        <Nav active={!selected && section === 'dashboard'} icon="▦" label="Vue générale" onClick={() => navigate('dashboard')} />
        <Nav active={!selected && section === 'nodes'} icon="⌘" label="Nœuds" onClick={() => navigate('nodes')} />
        {admin && <><div className="nav-label">ADMINISTRATION</div>
          <Nav active={!selected && section === 'users'} icon="♙" label="Utilisateurs" onClick={() => navigate('users')} />
          <Nav active={!selected && section === 'audit'} icon="≡" label="Journal d’audit" onClick={() => navigate('audit')} />
        </>}
        <div className="nav-label">SERVEURS</div>
        {servers.map((server) => <button key={server.id} className={selectedId === server.id ? 'nav-item active' : 'nav-item'} onClick={() => { setSelectedId(server.id); setSection('dashboard'); }}>
          <span className={`status-dot ${server.status}`} /><span className="truncate">{server.name}</span>
        </button>)}
      </nav>
      <button className={`sidebar-user ${!selected && section === 'profile' ? 'active' : ''}`} onClick={() => navigate('profile')}><span>{me?.username.slice(0, 1).toUpperCase()}</span><div><strong>{me?.username}</strong><small>Mon profil · {me?.role}</small></div></button>
      <button className="nav-item logout" onClick={logout}><span className="icon">↪</span> Déconnexion</button>
    </aside>

    <main>
      <header className="topbar"><div><p className="eyebrow">INFRASTRUCTURE</p><h1>{selected?.name ?? titles[section]}</h1></div>
        {!selected && section === 'dashboard' && admin && <button className="primary" onClick={openCreate}>＋ Nouveau serveur</button>}
      </header>
      {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {selected ? <ServerDetail server={selected} gateway={gateway} users={users} me={me!} onChanged={loadData} onDeleted={() => { setSelectedId(undefined); loadData(); }} />
        : section === 'nodes' ? <NodesView nodes={nodes} servers={servers} admin={admin} onChanged={loadData} />
        : section === 'users' ? <UsersView users={users} onChanged={loadData} />
        : section === 'audit' ? <AuditView entries={audits} />
        : section === 'profile' ? <ProfileView user={me!} onChanged={(user) => { setMe(user); setUsers((current) => current.map((item) => item.id === user.id ? user : item)); }} />
        : <Dashboard servers={servers} nodes={nodes} admin={admin} onSelect={setSelectedId} onCreate={openCreate} />}
    </main>
    {creating && <CreateServer gateway={gateway} servers={servers} nodes={nodes} users={users} busy={creatingServer} submitError={createError} onClose={() => { if (!creatingServer) { setCreating(false); setCreateError(''); } }} onSubmit={handleCreate} />}
  </div>;
}

function Nav({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) { return <button className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}><span className="icon">{icon}</span>{label}</button>; }

function Dashboard({ servers, nodes, admin, onSelect, onCreate }: { servers: Server[]; nodes: NodeRecord[]; admin: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Server['status']>('all');
  const running = servers.filter((server) => server.status === 'running').length;
  const memory = servers.reduce((total, server) => total + server.memoryMb, 0);
  const totalMemory = Math.floor(nodes.reduce((total, node) => total + (node.health?.memory.total ?? 0), 0) / 1024 / 1024);
  const offlineNodes = nodes.filter((node) => !node.online).length;
  const order: Record<Server['status'], number> = { running: 0, starting: 1, installing: 2, stopped: 3, unavailable: 4, missing: 5 };
  const normalizedQuery = query.trim().toLocaleLowerCase('fr');
  const sortedServers = servers.filter((server) => (status === 'all' || server.status === status) && (!normalizedQuery || `${server.name} ${server.software} ${server.version} ${server.address ?? ''}`.toLocaleLowerCase('fr').includes(normalizedQuery))).sort((left, right) => order[left.status] - order[right.status] || left.name.localeCompare(right.name, 'fr'));
  return <><section className="stats-grid">
    <div className="stat"><span className="stat-icon purple">◆</span><div><strong>{servers.length}</strong><small>SERVEURS</small></div></div>
    <div className="stat"><span className="stat-icon green">●</span><div><strong>{running}</strong><small>EN LIGNE</small></div></div>
    <div className="stat"><span className="stat-icon blue">▥</span><div><strong>{formatMemory(memory)}</strong><small>RAM ALLOUÉE{totalMemory ? ` · ${formatMemory(totalMemory)} TOTAL` : ''}</small></div></div>
    <div className="stat"><span className="stat-icon purple">⌘</span><div><strong>{nodes.filter((node) => node.online).length}/{nodes.length}</strong><small>NŒUDS ACTIFS</small></div></div>
  </section>
  {offlineNodes > 0 && <div className="infrastructure-notice danger"><strong>{offlineNodes} nœud{offlineNodes > 1 ? 's' : ''} hors ligne</strong><span>Les serveurs associés sont temporairement indisponibles.</span></div>}
  <section className="section-head"><div><p className="eyebrow">VOS INSTANCES</p><h2>Serveurs Minecraft</h2></div><span>{sortedServers.length === servers.length ? `${servers.length} au total` : `${sortedServers.length} sur ${servers.length}`}</span></section>
  {servers.length > 0 && <div className="dashboard-controls"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un serveur, logiciel, version…"/><select value={status} onChange={(event) => setStatus(event.target.value as 'all' | Server['status'])}><option value="all">Tous les états</option><option value="running">En ligne</option><option value="stopped">Arrêtés</option><option value="starting">Démarrage</option><option value="installing">Installation</option><option value="missing">À réparer</option><option value="unavailable">Indisponibles</option></select></div>}
  {sortedServers.length ? <div className="server-grid">{sortedServers.map((server) => <ServerCard key={server.id} server={server} onClick={() => onSelect(server.id)} />)}</div>
    : servers.length ? <div className="empty compact-empty"><div className="empty-cube">⌕</div><h2>Aucun résultat</h2><p>Modifiez la recherche ou le filtre d’état.</p><button className="secondary" onClick={() => { setQuery(''); setStatus('all'); }}>Réinitialiser</button></div>
    : <div className="empty"><div className="empty-cube">◇</div><h2>Aucun serveur</h2><p>{admin ? 'Créez la première instance Minecraft de votre infrastructure.' : 'Aucun serveur ne vous a encore été attribué.'}</p>{admin && <button className="primary" onClick={onCreate}>Créer un serveur</button>}</div>}</>;
}

function NodesView({ nodes, servers, admin, onChanged }: { nodes: NodeRecord[]; servers: Server[]; admin: boolean; onChanged: () => void }) {
  const [showForm, setShowForm] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: form.get('name'), location: form.get('location'), url: form.get('url'), token: form.get('token'), ip: form.get('ip'), portStart: Number(form.get('portStart')), portEnd: Number(form.get('portEnd')) }) }); setShowForm(false); onChanged(); } catch (err) { setError((err as Error).message); } }
  return <><div className="section-actions">{admin && <button className="primary" onClick={() => setShowForm(!showForm)}>＋ Ajouter un nœud</button>}</div>
    {showForm && <form className="inline-form" onSubmit={submit}><h2>Connecter un agent Linux</h2>{error && <div className="alert">{error}</div>}<div className="form-row"><label>Nom<input name="name" required /></label><label>Localisation<input name="location" required placeholder="Paris, FR" /></label></div><label>URL de l’agent<input name="url" type="url" required placeholder="https://node1.example.com" /></label><label>Jeton de nœud<input name="token" type="password" minLength={32} required /></label><div className="form-row"><label>Adresse d’allocation<input name="ip" defaultValue="0.0.0.0" /></label><label>Ports<input name="portStart" type="number" defaultValue="25565" /><input name="portEnd" type="number" defaultValue="25664" /></label></div><button className="primary">Connecter</button></form>}
    <div className="node-grid">{nodes.map((node) => { const usedMemory = servers.filter((server) => server.nodeId === node.id).reduce((sum, server) => sum + server.memoryMb, 0); const totalMemory = node.health ? Math.round(node.health.memory.total / 1024 / 1024) : 0; return <article className="node-card" key={node.id}>
      <div className="node-head"><div className="server-avatar">⌘</div><span className={`badge ${node.online ? 'running' : 'missing'}`}>{node.online ? 'Connecté' : 'Hors ligne'}</span></div>
      <h2>{node.name}</h2><p>{node.location} · {node.health?.hostname ?? node.url}</p>
      <div className="node-bars"><span><label>RAM allouée</label><strong>{formatMemory(usedMemory)} / {totalMemory ? formatMemory(totalMemory) : '—'}</strong></span><progress value={usedMemory} max={totalMemory || 1} /></div>
      <div className="allocation-line"><strong>{node.allocations.free}</strong><span>ports libres sur {node.allocations.total}</span></div>
      <div className="node-footer"><span>{servers.filter((server) => server.nodeId === node.id).length} serveurs</span><span>{node.health?.cpu.cores ?? '—'} cœurs CPU</span><span>Agent {node.health?.version ?? '—'}</span></div>
    </article>; })}</div></>;
}

export function formatMemory(value: number) { return value >= 1024 ? `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} Go` : `${value} Mo`; }
