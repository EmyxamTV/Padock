import { FormEvent, useCallback, useEffect, useState } from 'react';
import { io as connectSocket } from 'socket.io-client';
import { api, type AuditEntry, type GatewayStatus, type NetworkAllocation, type NodeRecord, type PanelJob, type PanelNotification, type PanelPermission, type PanelRole, type Server, type UserDirectoryEntry, type UserGroup, type UserRecord } from './api';
import { Auth } from './components/Auth';
import { CreateServer } from './components/CreateServer';
import { ServerCard } from './components/ServerCard';
import { ServerDetail } from './components/ServerDetail';
import { UsersView } from './components/UsersView';
import { AuditView } from './components/AuditView';
import { ProfileView } from './components/ProfileView';
import { OperationsView } from './components/OperationsView';

type Section = 'dashboard' | 'operations' | 'nodes' | 'users' | 'audit' | 'profile';

export function App() {
  const [auth, setAuth] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading');
  const [me, setMe] = useState<UserRecord>();
  const [servers, setServers] = useState<Server[]>([]);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [roles, setRoles] = useState<PanelRole[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [jobs, setJobs] = useState<PanelJob[]>([]);
  const [notifications, setNotifications] = useState<PanelNotification[]>([]);
  const [directory, setDirectory] = useState<UserDirectoryEntry[]>([]);
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
      const freshMe = await api<UserRecord>('/api/auth/me');
      if (!me || JSON.stringify(freshMe) !== JSON.stringify(me)) setMe(freshMe);
      const [serverList, nodeList, gatewayStatus, directoryList, jobList, notificationList] = await Promise.all([api<Server[]>('/api/servers'), api<NodeRecord[]>('/api/nodes'), api<GatewayStatus>('/api/gateway'), api<UserDirectoryEntry[]>('/api/users/directory'), api<PanelJob[]>('/api/jobs'), api<PanelNotification[]>('/api/notifications')]);
      setServers(serverList); setNodes(nodeList); setGateway(gatewayStatus); setDirectory(directoryList);
      setJobs(jobList); setNotifications(notificationList);
      if (canPanel(freshMe, 'users.manage')) {
        const [userList, roleList, groupList] = await Promise.all([api<UserRecord[]>('/api/users'), api<PanelRole[]>('/api/roles'), api<UserGroup[]>('/api/groups')]);
        setUsers(userList); setRoles(roleList); setGroups(groupList);
      } else { setUsers([]); setRoles([]); setGroups([]); }
      if (canPanel(freshMe, 'audit.view')) setAudits(await api<AuditEntry[]>('/api/audit')); else setAudits([]);
    } catch (err) { setError((err as Error).message); }
  }, [me]);

  useEffect(() => {
    Promise.all([api<{ initialized: boolean }>('/api/auth/status'), api<UserRecord>('/api/auth/me').catch(() => null)])
      .then(([status, user]) => { if (user) setMe(user); setAuth(user ? 'ready' : status.initialized ? 'login' : 'setup'); });
  }, []);

  useEffect(() => {
    if (auth !== 'ready' || !me) return;
    loadData(); const timer = window.setInterval(loadData, 30000);
    const socket = connectSocket(); socket.on('job:update', loadData); socket.on('notification:new', loadData); socket.on('connect', loadData);
    return () => { window.clearInterval(timer); socket.disconnect(); };
  }, [auth, me, loadData]);

  async function authenticated() { const user = await api<UserRecord>('/api/auth/me'); setMe(user); setAuth('ready'); }
  async function logout() { await api('/api/auth/logout', { method: 'POST' }); setServers([]); setUsers([]); setRoles([]); setMe(undefined); setAuth('login'); }
  function navigate(next: Section) { setSelectedId(undefined); setSection(next); }
  function openCreate() { setCreateError(''); setCreating(true); }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (creatingServer) return; setCreatingServer(true); setCreateError(''); const form = new FormData(event.currentTarget);
    try {
      const modpackProjectId = Number(form.get('modpackProjectId'));
      const modpackSlug = String(form.get('modpackSlug') ?? '');
      const subdomain = String(form.get('subdomain') ?? '').trim();
      const server = await api<Server>('/api/servers', { method: 'POST', body: JSON.stringify({
        name: form.get('name'), software: form.get('software'), version: form.get('version'), nodeId: form.get('nodeId'), ownerId: form.get('ownerId'),
        memoryMb: Number(form.get('memoryMb')), cpuPercent: Number(form.get('cpuPercent')), diskMb: Number(form.get('diskMb')),
        allocationId: form.get('allocationId'), subdomain: subdomain || undefined,
        modpack: modpackProjectId > 0 && modpackSlug ? { projectId: modpackProjectId, slug: modpackSlug } : undefined,
      }) });
      setServers((current) => [...current, server]); setCreating(false); setCreateError(''); setSelectedId(server.id);
    } catch (err) { setCreateError((err as Error).message); }
    finally { setCreatingServer(false); }
  }

  if (auth === 'loading') return <div className="splash"><div className="brand-mark">P</div><p>Chargement de Padock…</p></div>;
  if (auth !== 'ready') return <Auth mode={auth} onSuccess={authenticated} />;
  const selected = servers.find((server) => server.id === selectedId);
  const canCreateServers = canPanel(me, 'servers.create');
  const canManageAllServers = canPanel(me, 'servers.manage_all');
  const canViewNodes = canPanel(me, 'nodes.view') || canPanel(me, 'nodes.manage');
  const canManageNodes = canPanel(me, 'nodes.manage');
  const canManageUsers = canPanel(me, 'users.manage');
  const canViewAudit = canPanel(me, 'audit.view');
  const titles: Record<Section, string> = { dashboard: 'Vue générale', operations: 'Centre des opérations', nodes: 'Nœuds de calcul', users: 'Utilisateurs', audit: 'Journal d’audit', profile: 'Mon profil' };
  const unreadNotifications = notifications.filter((item) => !item.readAt).length;

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">P</span><div><strong>Padock</strong><small>SERVER CONTROL</small></div></div>
      <nav>
        <Nav active={!selected && section === 'dashboard'} icon="▦" label="Vue générale" onClick={() => navigate('dashboard')} />
        <Nav active={!selected && section === 'operations'} icon="◷" label={`Opérations${jobs.some((job) => job.status === 'running' || job.status === 'queued') ? ' · active' : ''}`} onClick={() => navigate('operations')} />
        {canViewNodes && <Nav active={!selected && section === 'nodes'} icon="⌘" label="Nœuds" onClick={() => navigate('nodes')} />}
        {(canManageUsers || canViewAudit) && <><div className="nav-label">ADMINISTRATION</div>
          {canManageUsers && <Nav active={!selected && section === 'users'} icon="♙" label="Utilisateurs" onClick={() => navigate('users')} />}
          {canViewAudit && <Nav active={!selected && section === 'audit'} icon="≡" label="Journal d’audit" onClick={() => navigate('audit')} />}
        </>}
        <div className="nav-label">SERVEURS</div>
        {servers.map((server) => <button key={server.id} className={selectedId === server.id ? 'nav-item active' : 'nav-item'} onClick={() => { setSelectedId(server.id); setSection('dashboard'); }}>
          <span className={`status-dot ${server.status}`} /><span className="truncate">{server.name}</span>
        </button>)}
      </nav>
      <button className={`sidebar-user ${!selected && section === 'profile' ? 'active' : ''}`} onClick={() => navigate('profile')}><span>{me?.username.slice(0, 1).toUpperCase()}</span><div><strong>{me?.username}</strong><small>Mon profil · {me?.role === 'admin' ? 'admin' : me?.customRole?.name ?? 'utilisateur'}</small></div></button>
      <button className="nav-item logout" onClick={logout}><span className="icon">↪</span> Déconnexion</button>
    </aside>

    <main>
      <header className="topbar"><div><p className="eyebrow">INFRASTRUCTURE</p><h1>{selected?.name ?? titles[section]}</h1></div><div className="topbar-actions"><button className="notification-button" onClick={() => navigate('operations')}>♢{unreadNotifications > 0 && <span>{unreadNotifications}</span>}</button>
        {!selected && section === 'dashboard' && canCreateServers && <button className="primary" onClick={openCreate}>＋ Nouveau serveur</button>}</div>
      </header>
      {error && <div className="alert" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {selected ? <ServerDetail server={selected} gateway={gateway} nodes={nodes} users={directory} onChanged={loadData} onDeleted={() => { setSelectedId(undefined); loadData(); }} />
        : section === 'operations' ? <OperationsView jobs={jobs} notifications={notifications} onChanged={loadData} onOpenServer={(id) => { setSelectedId(id); setSection('dashboard'); }} />
        : section === 'nodes' ? <NodesView nodes={nodes} servers={servers} admin={canManageNodes} onChanged={loadData} />
        : section === 'users' && canManageUsers ? <UsersView users={users} roles={roles} groups={groups} me={me!} onChanged={loadData} />
        : section === 'audit' ? <AuditView entries={audits} />
        : section === 'profile' ? <ProfileView user={me!} onChanged={(user) => { setMe(user); setUsers((current) => current.map((item) => item.id === user.id ? user : item)); }} />
        : <Dashboard servers={servers} nodes={nodes} admin={canCreateServers} onSelect={setSelectedId} onCreate={openCreate} />}
    </main>
    {creating && <CreateServer gateway={gateway} servers={servers} nodes={nodes} users={canManageAllServers ? directory : [{ id: me!.id, username: me!.username, email: me!.email }]} busy={creatingServer} submitError={createError} onClose={() => { if (!creatingServer) { setCreating(false); setCreateError(''); } }} onSubmit={handleCreate} />}
  </div>;
}

function canPanel(user: UserRecord | undefined, permission: PanelPermission) { return Boolean(user && (user.role === 'admin' || user.permissions.includes(permission))); }

function Nav({ active, icon, label, onClick }: { active: boolean; icon: string; label: string; onClick: () => void }) { return <button className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}><span className="icon">{icon}</span>{label}</button>; }

function Dashboard({ servers, nodes, admin, onSelect, onCreate }: { servers: Server[]; nodes: NodeRecord[]; admin: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | Server['status']>('all');
  const running = servers.filter((server) => server.status === 'running').length;
  const memory = servers.reduce((total, server) => total + server.memoryMb, 0);
  const totalMemory = Math.floor(nodes.reduce((total, node) => total + (node.health?.memory.total ?? 0), 0) / 1024 / 1024);
  const offlineNodes = nodes.filter((node) => !node.online).length;
  const order: Record<Server['status'], number> = { running: 0, starting: 1, installing: 2, stopped: 3, failed: 4, unavailable: 5, missing: 6 };
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
  const [showForm, setShowForm] = useState(false); const [editingId, setEditingId] = useState<string>(); const [error, setError] = useState('');
  const editing = nodes.find((node) => node.id === editingId);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api('/api/nodes', { method: 'POST', body: JSON.stringify({ name: form.get('name'), location: form.get('location'), url: form.get('url'), token: form.get('token'), ip: form.get('ip'), portStart: Number(form.get('portStart')), portEnd: Number(form.get('portEnd')), maxMemoryMb: Number(form.get('maxMemoryMb')) || undefined, maxDiskMb: Number(form.get('maxDiskMb')) || undefined }) }); setShowForm(false); onChanged(); } catch (err) { setError((err as Error).message); } }
  return <><div className="section-actions">{admin && <button className="primary" onClick={() => { setShowForm(!showForm); setEditingId(undefined); }}>＋ Ajouter un nœud</button>}</div>
    {showForm && <form className="inline-form" onSubmit={submit}><h2>Connecter un agent Linux</h2>{error && <div className="alert">{error}</div>}<div className="form-row"><label>Nom<input name="name" required /></label><label>Localisation<input name="location" required placeholder="Paris, FR" /></label></div><label>URL de l’agent<input name="url" type="url" required placeholder="https://node1.example.com" /></label><label>Jeton de nœud<input name="token" type="password" minLength={32} required /></label><div className="form-row"><label>Capacité RAM (Mo)<input name="maxMemoryMb" type="number" min="1024" placeholder="Vide = illimitée"/></label><label>Capacité disque (Mo)<input name="maxDiskMb" type="number" min="1024" placeholder="Vide = illimitée"/></label></div><div className="form-row"><label>Adresse d’allocation<input name="ip" defaultValue="0.0.0.0" /></label><label>Ports<input name="portStart" type="number" defaultValue="25565" /><input name="portEnd" type="number" defaultValue="25664" /></label></div><button className="primary">Connecter</button></form>}
    {editing && <NodeEditor node={editing} servers={servers} onClose={() => setEditingId(undefined)} onChanged={onChanged} />}
    <div className="node-grid">{nodes.map((node) => { const usedMemory = servers.filter((server) => server.nodeId === node.id).reduce((sum, server) => sum + server.memoryMb, 0); const totalMemory = node.health ? Math.round(node.health.memory.total / 1024 / 1024) : 0; return <article className="node-card" key={node.id}>
      <div className="node-head"><div className="server-avatar">⌘</div><div className="node-card-actions">{node.maintenance && <span className="badge starting">Maintenance</span>}<span className={`badge ${node.online ? 'running' : 'missing'}`}>{node.online ? 'Connecté' : 'Hors ligne'}</span>{admin && <button className="secondary compact" onClick={() => { setEditingId(node.id); setShowForm(false); }}>Modifier</button>}</div></div>
      <h2>{node.name}</h2><p>{node.location} · {node.health?.hostname ?? node.url}</p>
      <div className="node-bars"><span><label>RAM allouée</label><strong>{formatMemory(usedMemory)} / {node.maxMemoryMb ? formatMemory(node.maxMemoryMb) : totalMemory ? formatMemory(totalMemory) : '—'}</strong></span><progress value={usedMemory} max={node.maxMemoryMb || totalMemory || 1} /></div>
      <div className="allocation-line"><strong>{node.allocations.free}</strong><span>ports libres sur {node.allocations.total}</span></div>
      <div className="node-footer"><span>{servers.filter((server) => server.nodeId === node.id).length} serveurs</span><span>{node.health?.cpu.cores ?? '—'} cœurs CPU</span><span>Agent {node.health?.version ?? '—'}</span></div>
    </article>; })}</div></>;
}

function NodeEditor({ node, servers, onClose, onChanged }: { node: NodeRecord; servers: Server[]; onClose: () => void; onChanged: () => void }) {
  const [allocations, setAllocations] = useState<NetworkAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const loadAllocations = useCallback(async () => {
    setLoading(true);
    try { setAllocations(await api<NetworkAllocation[]>(`/api/nodes/${node.id}/allocations`)); }
    catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [node.id]);
  useEffect(() => { void loadAllocations(); }, [loadAllocations]);

  async function saveNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('node'); setError(''); setMessage('');
    const form = new FormData(event.currentTarget); const token = String(form.get('token') ?? '');
    try {
      await api(`/api/nodes/${node.id}`, { method: 'PUT', body: JSON.stringify({ name: form.get('name'), location: form.get('location'), url: form.get('url'), maintenance: form.get('maintenance') === 'on', maintenanceMessage: form.get('maintenanceMessage') || null, maxMemoryMb: Number(form.get('maxMemoryMb')) || null, maxDiskMb: Number(form.get('maxDiskMb')) || null, ...(token ? { token } : {}) }) });
      setMessage('Configuration du nœud enregistrée.'); onChanged();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }
  async function addRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('range'); setError(''); setMessage(''); const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ created: number }>(`/api/nodes/${node.id}/allocations`, { method: 'POST', body: JSON.stringify({ ip: form.get('ip'), portStart: Number(form.get('portStart')), portEnd: Number(form.get('portEnd')) }) });
      setMessage(`${result.created} allocation${result.created > 1 ? 's' : ''} ajoutée${result.created > 1 ? 's' : ''}.`); await loadAllocations(); onChanged();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }
  async function removeAllocation(allocation: NetworkAllocation) {
    if (allocation.serverId || allocation.reservationId || !confirm(`Retirer l’allocation ${allocation.ip}:${allocation.port} ?`)) return;
    setBusy(allocation.id); setError(''); setMessage('');
    try { await api(`/api/nodes/${node.id}/allocations/${allocation.id}`, { method: 'DELETE' }); setMessage(`Allocation ${allocation.ip}:${allocation.port} retirée.`); await loadAllocations(); onChanged(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  return <section className="content-panel node-editor">
    <div className="content-toolbar"><div><p className="eyebrow">CONFIGURATION DU NŒUD</p><h2>{node.name}</h2><small>Modifiez l’agent et les ports disponibles pour les nouveaux serveurs.</small></div><button className="close" onClick={onClose}>×</button></div>
    {error && <div className="alert">{error}<button onClick={() => setError('')}>×</button></div>}{message && <div className="success-banner">{message}</div>}
    <form className="node-settings-form" onSubmit={saveNode}><div className="form-row"><label>Nom<input name="name" defaultValue={node.name} required minLength={2} maxLength={40}/></label><label>Localisation<input name="location" defaultValue={node.location} required minLength={2} maxLength={60}/></label></div><div className="form-row"><label>URL de l’agent<input name="url" type="url" defaultValue={node.url} required/><small>Une nouvelle adresse doit utiliser HTTPS en production.</small></label><label>Nouveau jeton<input name="token" type="password" minLength={32} placeholder="Laisser vide pour conserver le jeton actuel"/><small>La connexion est testée avant d’enregistrer une nouvelle URL ou un nouveau jeton.</small></label></div><div className="form-row"><label>Capacité RAM (Mo)<input name="maxMemoryMb" type="number" min="1024" defaultValue={node.maxMemoryMb}/></label><label>Capacité disque (Mo)<input name="maxDiskMb" type="number" min="1024" defaultValue={node.maxDiskMb}/></label></div><label className="sftp-mode-toggle"><input name="maintenance" type="checkbox" defaultChecked={node.maintenance}/><span><strong>Mode maintenance / drain</strong><small>Bloque les nouvelles créations et les destinations de transfert sur ce nœud.</small></span></label><label>Message de maintenance<input name="maintenanceMessage" defaultValue={node.maintenanceMessage} maxLength={200} placeholder="Maintenance planifiée"/></label><div className="modal-actions"><button className="primary" disabled={!!busy}>{busy === 'node' ? 'Vérification…' : 'Enregistrer le nœud'}</button></div></form>
    <div className="allocation-editor-head"><div><h3>Allocations réseau</h3><small>{allocations.filter((item) => !item.serverId && !item.reservationId).length} libres sur {allocations.length}</small></div></div>
    <form className="allocation-range-form" onSubmit={addRange}><label>Adresse IP<input name="ip" defaultValue="0.0.0.0" required/></label><label>Premier port<input name="portStart" type="number" min="1024" max="65535" defaultValue="25565" required/></label><label>Dernier port<input name="portEnd" type="number" min="1024" max="65535" defaultValue="25664" required/></label><button className="secondary" disabled={!!busy}>{busy === 'range' ? 'Ajout…' : 'Ajouter la plage'}</button></form>
    <div className="table-card allocation-table"><table><thead><tr><th>ADRESSE</th><th>PORT</th><th>ÉTAT</th><th>SERVEUR</th><th /></tr></thead><tbody>{allocations.map((allocation) => { const server = servers.find((item) => item.id === allocation.serverId); const locked = Boolean(allocation.serverId || allocation.reservationId); return <tr key={allocation.id}><td>{allocation.alias ?? allocation.ip}</td><td><code>{allocation.port}</code></td><td><span className={`role-badge ${locked ? '' : 'active'}`}>{allocation.serverId ? 'Utilisée' : allocation.reservationId ? 'Réservée' : 'Libre'}</span></td><td>{server?.name ?? allocation.serverId ?? (allocation.reservationId ? `Opération ${allocation.reservationId}` : '—')}</td><td><button className="table-action" disabled={locked || busy === allocation.id} title={locked ? 'Cette allocation est utilisée ou réservée.' : undefined} onClick={() => void removeAllocation(allocation)}>{busy === allocation.id ? 'Retrait…' : 'Retirer'}</button></td></tr>; })}{!loading && !allocations.length && <tr><td colSpan={5}>Aucune allocation configurée.</td></tr>}</tbody></table>{loading && <div className="panel-empty">Chargement des allocations…</div>}</div>
  </section>;
}

export function formatMemory(value: number) { return value >= 1024 ? `${(value / 1024).toFixed(value % 1024 ? 1 : 0)} Go` : `${value} Mo`; }
