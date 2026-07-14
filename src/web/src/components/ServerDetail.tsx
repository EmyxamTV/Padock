import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, upload, type AuditEntry, type BackupEntry, type CurseForgeProject, type FileEntry, type GatewayStatus, type Server, type ServerSchedule, type ServerStats, type SftpCredentials, type UserRecord } from '../api';
import { formatMemory } from '../App';
import { serverDiagnostic, serverStatusLabels } from '../server-status';

type ServerTab = 'console' | 'files' | 'content' | 'settings' | 'backups' | 'schedules' | 'sftp' | 'activity';

export function ServerDetail({ server, gateway, users, me, onChanged, onDeleted }: { server: Server; gateway: GatewayStatus; users: UserRecord[]; me: UserRecord; onChanged: () => void; onDeleted: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [tab, setTab] = useState<ServerTab>('console');
  const [stats, setStats] = useState<ServerStats>({ cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, diskBytes: 0 });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    const socket: Socket = io();
    socket.on('connect', () => socket.emit('console:subscribe', server.id));
    socket.on('console:line', (line: string) => setLines((current) => [...current, ...line.split('\n').filter(Boolean)].slice(-500)));
    socket.on('console:error', setError);
    return () => { socket.disconnect(); };
  }, [server.id, server.status]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  useEffect(() => {
    const load = () => api<ServerStats>(`/api/servers/${server.id}/stats`).then(setStats).catch(() => undefined);
    void load(); const timer = window.setInterval(load, server.status === 'running' || server.status === 'starting' ? 3000 : 15000); return () => window.clearInterval(timer);
  }, [server.id, server.status]);

  async function action(name: 'start' | 'stop' | 'restart' | 'kill') {
    setBusy(name); setError('');
    try { await api(`/api/servers/${server.id}/${name}`, { method: 'POST' }); setTimeout(onChanged, 700); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }

  async function forceStop() {
    if (!confirm('Forcer l’arrêt immédiatement ? Utilisez ceci seulement si l’arrêt normal ne répond plus.')) return;
    await action('kill');
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(server.address ?? `${window.location.hostname}:${server.port}`);
    setCopiedAddress(true); window.setTimeout(() => setCopiedAddress(false), 1600);
  }

  async function command(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const input = event.currentTarget.elements.namedItem('command') as HTMLInputElement;
    const value = input.value.trim(); if (!value) return; input.value = ''; setLines((current) => [...current, `> ${value}`]);
    try { const result = await api<{ output: string }>(`/api/servers/${server.id}/command`, { method: 'POST', body: JSON.stringify({ command: value }) }); if (result.output) setLines((current) => [...current, result.output]); }
    catch (err) { setError((err as Error).message); }
  }

  async function remove() {
    if (!confirm(`Supprimer l'instance « ${server.name} » ? Le dossier du monde sera conservé sur le serveur Linux.`)) return;
    await api(`/api/servers/${server.id}`, { method: 'DELETE' }); onDeleted();
  }

  const statusLabel = serverStatusLabels[server.status];
  const diagnostic = serverDiagnostic(server);
  const consoleLive = server.status === 'running' || server.status === 'starting';
  const owner = me.role === 'admin' || me.id === server.ownerId;
  const supportsContent = server.software !== 'VANILLA';

  return <div className="detail">
    <div className="detail-summary">
      <div className="detail-state"><span className={`status-orb ${server.status}`} /><div><span className={`badge ${server.status}`}>{statusLabel}</span><p>{server.software} {server.version}</p></div></div>
      <div className="detail-metrics live-metrics"><div><small>CPU</small><strong>{stats.cpuPercent.toFixed(1)}%</strong></div><div><small>RAM</small><strong>{formatBytes(stats.memoryBytes)} / {formatMemory(server.memoryMb)}</strong></div><div><small>DISQUE</small><strong>{formatBytes(stats.diskBytes)} / {formatMemory(server.diskMb)}</strong></div><div><small>RÉSEAU ↓</small><strong>{formatBytes(stats.networkRxBytes)}</strong></div><div><small>ADRESSE</small><button className="copy-address" onClick={copyAddress}>{copiedAddress ? 'Copiée' : server.address ?? `${window.location.hostname}:${server.port}`}</button></div></div>
      <div className="detail-actions">
        {server.status === 'running' ? <button className="danger-soft" disabled={!!busy} onClick={() => action('stop')}>{busy === 'stop' ? 'Arrêt…' : '■ Arrêter'}</button> : <button className="primary" disabled={!!busy || ['missing', 'installing', 'unavailable'].includes(server.status)} onClick={() => action('start')}>{busy === 'start' ? 'Démarrage…' : '▶ Démarrer'}</button>}
        <button className="secondary" disabled={!!busy || server.status !== 'running'} onClick={() => action('restart')}>{busy === 'restart' ? 'Redémarrage…' : '↻ Redémarrer'}</button>
        {owner && server.status === 'running' && <button className="force-stop" disabled={!!busy} onClick={forceStop}>{busy === 'kill' ? 'Arrêt forcé…' : 'Forcer'}</button>}
      </div>
    </div>
    {diagnostic && <div className={`runtime-diagnostic ${diagnostic.level}`}><strong>{diagnostic.level === 'danger' ? 'Action requise' : 'À vérifier'}</strong><span>{diagnostic.message}</span>{server.runtime?.finishedAt && <small>Dernier arrêt : {new Date(server.runtime.finishedAt).toLocaleString('fr-FR')}</small>}</div>}
    {error && <div className="alert">{error}<button onClick={() => setError('')}>×</button></div>}

    <div className="server-tabs">
      <Tab active={tab === 'console'} onClick={() => setTab('console')}>⌁ Console</Tab>
      <Tab active={tab === 'files'} onClick={() => setTab('files')}>▤ Fichiers</Tab>
      {supportsContent && <Tab active={tab === 'content'} onClick={() => setTab('content')}>◆ Extensions</Tab>}
      <Tab active={tab === 'settings'} onClick={() => setTab('settings')}>⚙ Configuration</Tab>
      <Tab active={tab === 'backups'} onClick={() => setTab('backups')}>◫ Sauvegardes</Tab>
      <Tab active={tab === 'schedules'} onClick={() => setTab('schedules')}>◷ Tâches</Tab>
      <Tab active={tab === 'sftp'} onClick={() => setTab('sftp')}>⇅ SFTP</Tab>
      <Tab active={tab === 'activity'} onClick={() => setTab('activity')}>≡ Activité</Tab>
    </div>

    {tab === 'console' && <section className="console-panel">
      <div className="console-head"><div><span className="terminal-dot red"/><span className="terminal-dot yellow"/><span className="terminal-dot green"/></div><strong>Console du serveur</strong><div className="console-tools"><button type="button" onClick={() => setLines([])} disabled={!lines.length}>Effacer</button><span className={`live ${consoleLive ? '' : 'offline'}`}><i /> {consoleLive ? 'LIVE' : 'HORS LIGNE'}</span></div></div>
      <div className="console-output">{lines.length ? lines.map((line, index) => <div className={logLineClass(line)} key={index}><span>{String(index + 1).padStart(3, '0')}</span>{line}</div>) : <p className="console-empty">{consoleLive ? 'Connexion à la console…' : 'Démarrez le serveur pour afficher les logs en direct.'}</p>}<div ref={endRef} /></div>
      <form className="command" onSubmit={command}><span>›</span><input name="command" placeholder="Entrez une commande sans /" disabled={server.status !== 'running'} autoComplete="off"/><button disabled={server.status !== 'running'}>Envoyer</button></form>
    </section>}
    {tab === 'files' && <FilesPanel server={server} />}
    {tab === 'content' && supportsContent && <ContentPanel server={server} />}
    {tab === 'settings' && <div className="settings-stack">{owner && <ServerManagementPanel server={server} gateway={gateway} onChanged={onChanged} />}<ResourcesPanel server={server} onChanged={onChanged} /><PropertiesPanel server={server} /></div>}
    {tab === 'backups' && <BackupsPanel server={server} />}
    {tab === 'schedules' && <SchedulesPanel server={server} />}
    {tab === 'sftp' && <SftpPanel server={server} />}
    {tab === 'activity' && <ActivityPanel server={server} />}
    {owner && <Members server={server} users={users} />}
    {owner && <div className="danger-zone"><div><strong>Supprimer l’instance</strong><p>Le conteneur sera supprimé, mais les fichiers du monde seront conservés.</p></div><button className="danger" onClick={remove}>Supprimer</button></div>}
  </div>;
}

function Tab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) { return <button className={active ? 'active' : ''} onClick={onClick}>{children}</button>; }

function ServerManagementPanel({ server, gateway, onChanged }: { server: Server; gateway: GatewayStatus; onChanged: () => void }) {
  const currentSubdomain = gateway.baseDomain && server.domain?.endsWith(`.${gateway.baseDomain}`) ? server.domain.slice(0, -(gateway.baseDomain.length + 1)) : '';
  const [name, setName] = useState(server.name); const [subdomain, setSubdomain] = useState(currentSubdomain); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { setName(server.name); setSubdomain(currentSubdomain); }, [server.id, server.name, server.domain, gateway.baseDomain]);
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('rename'); setError(''); setMessage('');
    try { await api(`/api/servers/${server.id}`, { method: 'PUT', body: JSON.stringify({ name }) }); setMessage('Nom du serveur mis à jour.'); await onChanged(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  }
  async function repair() {
    if (!confirm('Recréer le conteneur Docker ? Le monde, les extensions et les sauvegardes seront conservés.')) return;
    setBusy('repair'); setError(''); setMessage('');
    try { await api(`/api/servers/${server.id}/repair`, { method: 'POST' }); setMessage('Conteneur réparé. Les fichiers du serveur ont été conservés.'); await onChanged(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  }
  async function saveDomain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('domain'); setError(''); setMessage('');
    try {
      await api(`/api/servers/${server.id}/domain`, { method: 'PUT', body: JSON.stringify({ subdomain: subdomain || null }) });
      setMessage(subdomain ? `Adresse ${subdomain}.${gateway.baseDomain} activée.` : 'Adresse personnalisée retirée.');
      await onChanged();
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  }
  const repairable = server.status === 'stopped' || server.status === 'missing';
  return <section className="content-panel management-panel"><div className="content-toolbar"><div><h2>Gestion de l’instance</h2><small>Identité, domaine et maintenance du conteneur</small></div></div>{error && <div className="alert">{error}</div>}{message && <div className="success-banner">{message}</div>}<div className="management-grid"><form onSubmit={rename}><label>Nom affiché<input value={name} minLength={2} maxLength={40} onChange={(event) => setName(event.target.value)} /></label><button className="secondary" disabled={busy === 'rename' || name.trim() === server.name}>{busy === 'rename' ? 'Renommage…' : 'Renommer'}</button></form><div className="repair-card"><div><strong>Réparer le conteneur</strong><p>Recrée la couche Docker et conserve le monde, les mods, les plugins et la configuration.</p></div><button className="secondary" disabled={!!busy || !repairable} onClick={repair}>{busy === 'repair' ? 'Réparation…' : server.status === 'running' ? 'Serveur à arrêter' : 'Réparer'}</button></div></div>{gateway.configured && gateway.baseDomain && <form className="gateway-domain-form" onSubmit={saveDomain}><div><strong>Adresse de connexion</strong><p>Le sous-domaine est routé automatiquement par Gate, sans exposer le port interne aux joueurs.</p></div><label><span>Sous-domaine</span><div className="domain-input"><input value={subdomain} maxLength={63} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" placeholder="survie" onChange={(event) => setSubdomain(toSubdomain(event.target.value))} /><span>.{gateway.baseDomain}</span></div></label><button className="secondary" disabled={!!busy || subdomain === currentSubdomain}>{busy === 'domain' ? 'Application…' : subdomain ? 'Appliquer' : 'Retirer'}</button></form>}</section>;
}

function ActivityPanel({ server }: { server: Server }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]); const [error, setError] = useState('');
  const load = useCallback(() => api<AuditEntry[]>(`/api/servers/${server.id}/activity`).then((result) => { setEntries(result); setError(''); }).catch((err) => setError(err.message)), [server.id]);
  useEffect(() => { void load(); }, [load]);
  return <section className="content-panel activity-panel"><div className="content-toolbar"><div><h2>Historique du serveur</h2><small>Les 100 dernières actions de gestion</small></div><button className="secondary compact" onClick={() => void load()}>Actualiser</button></div>{error && <div className="alert">{error}</div>}<div className="activity-list">{entries.map((entry) => <article key={entry.id}><span className="activity-icon">{activityIcon(entry.action)}</span><div><strong>{activityLabel(entry.action)}</strong><small>{entry.user?.username ?? 'Système'} · {new Date(entry.createdAt).toLocaleString('fr-FR')}</small></div>{Object.keys(entry.metadata).length > 0 && <code>{summarizeMetadata(entry.metadata)}</code>}</article>)}{!entries.length && !error && <p className="panel-empty">Aucune activité enregistrée pour ce serveur.</p>}</div></section>;
}

function FilesPanel({ server }: { server: Server }) {
  const [directory, setDirectory] = useState(''); const [entries, setEntries] = useState<FileEntry[]>([]); const [editing, setEditing] = useState<{ path: string; content: string }>(); const [folderName, setFolderName] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const uploadInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async (path = directory) => { try { setEntries(await api(`/api/servers/${server.id}/files?path=${encodeURIComponent(path)}`)); setDirectory(path); setEditing(undefined); setError(''); } catch (err) { setError((err as Error).message); } }, [directory, server.id]);
  useEffect(() => { void load(''); }, [server.id]);
  async function open(entry: FileEntry) { if (entry.type === 'directory') return load(entry.path); try { const result = await api<{ content: string }>(`/api/servers/${server.id}/files/content?path=${encodeURIComponent(entry.path)}`); setEditing({ path: entry.path, content: result.content }); } catch (err) { setError((err as Error).message); } }
  async function save() { if (!editing) return; setBusy(true); try { await api(`/api/servers/${server.id}/files/content`, { method: 'PUT', body: JSON.stringify(editing) }); await load(directory); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function mkdir() { if (!folderName.trim()) return; const path = [directory, folderName.trim()].filter(Boolean).join('/'); try { await api(`/api/servers/${server.id}/files/directory`, { method: 'POST', body: JSON.stringify({ path }) }); setFolderName(''); await load(directory); } catch (err) { setError((err as Error).message); } }
  async function remove(entry: FileEntry) { if (!confirm(`Supprimer « ${entry.name} » ?`)) return; try { await api(`/api/servers/${server.id}/files`, { method: 'DELETE', body: JSON.stringify({ path: entry.path }) }); await load(directory); } catch (err) { setError((err as Error).message); } }
  async function renameEntry(entry: FileEntry) { const name = prompt('Nouveau nom', entry.name)?.trim(); if (!name || name === entry.name || /[\\/]/.test(name)) return; const destination = [directory, name].filter(Boolean).join('/'); try { await api(`/api/servers/${server.id}/files/rename`, { method: 'POST', body: JSON.stringify({ source: entry.path, destination }) }); await load(directory); } catch (err) { setError((err as Error).message); } }
  async function uploadFile(file?: File) { if (!file) return; if (file.size > 128 * 1024 * 1024) return setError('La taille maximale par upload est de 128 Mo.'); const destination = [directory, file.name].filter(Boolean).join('/'); setBusy(true); try { await upload(`/api/servers/${server.id}/files/upload?path=${encodeURIComponent(destination)}`, file); await load(directory); } catch (err) { setError((err as Error).message); } finally { setBusy(false); if (uploadInput.current) uploadInput.current.value = ''; } }
  function download(entry: FileEntry) { const link = document.createElement('a'); link.href = `/api/servers/${server.id}/files/download?path=${encodeURIComponent(entry.path)}`; link.download = entry.name; document.body.appendChild(link); link.click(); link.remove(); }
  const parent = directory.split('/').slice(0, -1).join('/');
  return <section className="content-panel">{error && <div className="alert">{error}</div>}
    {editing ? <><div className="content-toolbar"><button className="secondary" onClick={() => setEditing(undefined)}>← Retour</button><code>{editing.path}</code><button className="primary" disabled={busy} onClick={save}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></div><textarea className="file-editor" value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })} spellCheck={false} /></>
      : <><div className="content-toolbar"><button className="secondary" disabled={!directory} onClick={() => load(parent)}>← Dossier parent</button><code>/{directory}</code><input ref={uploadInput} className="hidden-input" type="file" onChange={(event) => void uploadFile(event.target.files?.[0])}/><button className="primary" disabled={busy} onClick={() => uploadInput.current?.click()}>{busy ? 'Transfert…' : 'Importer'}</button><div className="folder-create"><input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Nouveau dossier"/><button className="secondary" onClick={mkdir}>Créer</button></div></div>
      <div className="file-list"><div className="file-row header"><span>NOM</span><span>TAILLE</span><span>MODIFIÉ</span><span>ACTIONS</span></div>{entries.map((entry) => <div className="file-row" key={entry.path}><button className="file-name" onClick={() => open(entry)}><i>{entry.type === 'directory' ? '▰' : '▤'}</i>{entry.name}</button><span>{entry.type === 'file' ? formatBytes(entry.size) : '—'}</span><span>{new Date(entry.modifiedAt).toLocaleString('fr-FR')}</span><div className="file-actions">{entry.type === 'file' && <button className="secondary compact" onClick={() => download(entry)}>Télécharger</button>}<button className="secondary compact" onClick={() => renameEntry(entry)}>Renommer</button><button className="table-action" onClick={() => remove(entry)}>Supprimer</button></div></div>)}</div></>}
  </section>;
}

type ContentKind = 'plugin' | 'mod' | 'modpack';

function ContentPanel({ server }: { server: Server }) {
  const kinds: ContentKind[] = server.software === 'PAPER' || server.software === 'PURPUR' ? ['plugin'] : ['mod', 'modpack'];
  const [kind, setKind] = useState<ContentKind>(kinds[0]); const [query, setQuery] = useState(''); const [projects, setProjects] = useState<CurseForgeProject[]>([]); const [installed, setInstalled] = useState<FileEntry[]>([]); const [minecraftVersion, setMinecraftVersion] = useState(''); const [configured, setConfigured] = useState(true); const [busy, setBusy] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = useCallback(async (search = '') => {
    setLoading(true); setError('');
    try {
      const installedKind = kind === 'plugin' ? 'plugin' : 'mod';
      const [catalog, files] = await Promise.all([
        api<{ configured: boolean; minecraftVersion?: string; projects: CurseForgeProject[] }>(`/api/servers/${server.id}/content/search?kind=${kind}&query=${encodeURIComponent(search)}`),
        api<FileEntry[]>(`/api/servers/${server.id}/content/installed?kind=${installedKind}`),
      ]);
      setProjects(catalog.projects); setInstalled(files); setConfigured(catalog.configured); setMinecraftVersion(catalog.minecraftVersion ?? 'version non détectée');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }, [kind, server.id]);
  useEffect(() => { setQuery(''); setMessage(''); void load(''); }, [load]);
  async function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await load(query.trim()); }
  async function install(project: CurseForgeProject) {
    setBusy(String(project.id)); setError(''); setMessage('');
    try {
      const result = await api<{ restartRequired: boolean; startRequired?: boolean; message?: string }>(`/api/servers/${server.id}/content/install`, { method: 'POST', body: JSON.stringify({ kind, projectId: project.id, slug: project.slug }) });
      setMessage(result.message ?? `${project.title} est installé.${result.restartRequired ? ' Redémarrez le serveur pour l’activer.' : ''}`); await load(query.trim());
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  }
  async function remove(item: FileEntry) {
    if (!confirm(`Supprimer « ${item.name} » ?`)) return;
    const installedKind = kind === 'plugin' ? 'plugin' : 'mod';
    try { await api(`/api/servers/${server.id}/content/installed`, { method: 'DELETE', body: JSON.stringify({ kind: installedKind, filename: item.name }) }); await load(query.trim()); }
    catch (err) { setError((err as Error).message); }
  }
  return <section className="content-panel extensions-panel">
    <div className="content-toolbar extension-toolbar"><div><h2>Catalogue CurseForge</h2><small>Compatible avec {server.software} · Minecraft {minecraftVersion || 'détection…'}</small></div>{kinds.length > 1 && <select value={kind} onChange={(event) => setKind(event.target.value as ContentKind)}><option value="mod">Mods</option><option value="modpack">Modpacks</option></select>}<form onSubmit={search}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher sur CurseForge"/><button className="primary" disabled={loading}>{loading ? 'Recherche…' : 'Rechercher'}</button></form></div>
    {error && <div className="alert">{error}</div>}{!configured && <div className="modpack-warning">Ajoutez <code>CURSEFORGE_API_KEY='votre-clé'</code> dans <code>.env</code>, puis relancez Padock pour activer le catalogue.</div>}{message && <div className="success-banner">{message}</div>}
    {kind !== 'modpack' && <div className="installed-block"><div className="subhead"><strong>{kind === 'plugin' ? 'Plugins' : 'Mods'} installés</strong><span>{installed.length}</span></div><div className="installed-list">{installed.map((item) => <div key={item.path}><span>◆</span><strong>{item.name}</strong><small>{formatBytes(item.size)}</small><button className="table-action" onClick={() => remove(item)}>Supprimer</button></div>)}{!installed.length && <p>Aucune extension installée.</p>}</div></div>}
    {kind === 'modpack' && <div className="modpack-warning">Une sauvegarde automatique sera créée avant l’installation. Le serveur doit être arrêté.</div>}
    <div className="extension-grid">{projects.map((project) => <article key={project.id}>{project.iconUrl ? <img src={project.iconUrl} alt="" loading="lazy"/> : <div className="extension-placeholder">◆</div>}<div className="extension-copy"><strong>{project.title}</strong><small>par {project.author} · {formatDownloads(project.downloads)} téléchargements</small><p>{project.description}</p></div><button className="primary" disabled={!!busy || (kind === 'modpack' && server.status !== 'stopped')} onClick={() => install(project)}>{busy === String(project.id) ? 'Installation…' : 'Installer'}</button></article>)}{!loading && !projects.length && <p className="panel-empty">Aucun contenu compatible trouvé.</p>}</div>
    <p className="source-note">CurseForge fournit le catalogue et l’image Minecraft installe automatiquement le modpack, ses mods et son loader exact.</p>
  </section>;
}

function ResourcesPanel({ server, onChanged }: { server: Server; onChanged: () => void }) {
  const [memoryMb, setMemoryMb] = useState(server.memoryMb);
  const [cpuPercent, setCpuPercent] = useState(server.cpuPercent);
  const [diskMb, setDiskMb] = useState(server.diskMb);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { setMemoryMb(server.memoryMb); setCpuPercent(server.cpuPercent); setDiskMb(server.diskMb); }, [server.id, server.memoryMb, server.cpuPercent, server.diskMb]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/servers/${server.id}/resources`, { method: 'PUT', body: JSON.stringify({ memoryMb, cpuPercent, diskMb }) });
      setMessage('Ressources enregistrées. Elles seront utilisées au prochain démarrage.'); onChanged();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const javaMemoryMb = Math.max(768, Math.floor(memoryMb * 0.8));
  return <section className="content-panel resource-panel"><div className="content-toolbar"><div><h2>Ressources du conteneur</h2><small>Limites Docker et mémoire Java de cette instance</small></div><span className={`badge ${server.status}`}>{server.status === 'stopped' ? 'Modifiable' : 'Serveur à arrêter'}</span></div>{error && <div className="alert">{error}</div>}{message && <div className="success-banner">{message}</div>}<form className="resource-form" onSubmit={save}><label><span>Mémoire totale</span><small>Le conteneur réserve 20 % pour Java et les processus annexes.</small><input type="number" min="1024" max="65536" step="512" value={memoryMb} onChange={(event) => setMemoryMb(Number(event.target.value))}/><em>Heap Java : {formatMemory(javaMemoryMb)}</em></label><label><span>CPU</span><small>100 % correspond à un cœur logique.</small><input type="number" min="10" max="1600" step="10" value={cpuPercent} onChange={(event) => setCpuPercent(Number(event.target.value))}/><em>{cpuPercent}% · {(cpuPercent / 100).toFixed(1)} cœur(s)</em></label><label><span>Quota disque</span><small>Le quota ne peut pas être inférieur aux fichiers déjà présents.</small><input type="number" min="1024" max="1048576" step="1024" value={diskMb} onChange={(event) => setDiskMb(Number(event.target.value))}/><em>{formatMemory(diskMb)}</em></label><div className="resource-save"><strong>{server.status === 'stopped' ? 'Prêt à appliquer' : 'Arrêtez le serveur pour modifier les limites.'}</strong><button className="primary" disabled={busy || server.status !== 'stopped'}>{busy ? 'Application…' : 'Appliquer les ressources'}</button></div></form></section>;
}

function PropertiesPanel({ server }: { server: Server }) {
  const [values, setValues] = useState<Record<string, string>>({}); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { setLoading(true); api<{ values: Record<string, string> }>(`/api/servers/${server.id}/properties`).then((result) => { setValues({ ...defaultPropertyValues, ...result.values }); setError(''); }).catch((err) => setError(err.message)).finally(() => setLoading(false)); }, [server.id]);
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setError(''); setMessage(''); try { const result = await api<{ restartRequired: boolean }>(`/api/servers/${server.id}/properties`, { method: 'PUT', body: JSON.stringify({ values }) }); setMessage(result.restartRequired ? 'Propriétés enregistrées. Redémarrez le serveur pour tout appliquer.' : 'Propriétés enregistrées.'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  return <section className="content-panel properties-panel"><div className="content-toolbar"><div><h2>server.properties</h2><small>Les réglages principaux sans éditer le fichier à la main</small></div></div>{error && <div className="alert">{error}</div>}{message && <div className="success-banner">{message}</div>}{loading ? <p className="panel-empty">Chargement des propriétés…</p> : <form onSubmit={save}><div className="properties-grid">{propertyDefinitions.map((item) => <label key={item.key}><span>{item.label}</span><small>{item.description}</small>{item.options ? <select value={values[item.key] ?? ''} onChange={(event) => setValues({ ...values, [item.key]: event.target.value })}>{item.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <input type={item.type ?? 'text'} min={item.min} max={item.max} value={values[item.key] ?? ''} onChange={(event) => setValues({ ...values, [item.key]: event.target.value })}/>}</label>)}</div><div className="properties-actions"><span>Un redémarrage peut être nécessaire.</span><button className="primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer les propriétés'}</button></div></form>}</section>;
}

function SftpPanel({ server }: { server: Server }) {
  const [credentials, setCredentials] = useState<SftpCredentials>(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [copied, setCopied] = useState('');
  async function generate() { setBusy(true); setError(''); setCopied(''); try { setCredentials(await api(`/api/servers/${server.id}/sftp/credentials`, { method: 'POST' })); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function copy(label: string, value: string) { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(''), 1500); }
  return <section className="content-panel sftp-panel"><div className="sftp-intro"><div className="sftp-icon">⇅</div><div><h2>Accès SFTP isolé</h2><p>Connectez FileZilla, WinSCP ou votre client SFTP directement au dossier de ce serveur.</p></div><button className="primary" disabled={busy} onClick={generate}>{busy ? 'Génération…' : credentials ? 'Régénérer' : 'Générer un accès'}</button></div>{error && <div className="alert">{error}</div>}{credentials ? <><div className="credential-grid"><Credential label="HÔTE" value={credentials.host} onCopy={() => copy('Hôte', credentials.host)}/><Credential label="PORT" value={String(credentials.port)} onCopy={() => copy('Port', String(credentials.port))}/><Credential label="UTILISATEUR" value={credentials.username} onCopy={() => copy('Utilisateur', credentials.username)}/><Credential label="MOT DE PASSE TEMPORAIRE" value={credentials.password} secret onCopy={() => copy('Mot de passe', credentials.password)}/></div><div className="credential-footer"><span>{copied ? `${copied} copié` : `Valide jusqu’à ${new Date(credentials.expiresAt).toLocaleString('fr-FR')}`}</span><code>sftp://{credentials.username}@{credentials.host}:{credentials.port}</code></div></> : <div className="sftp-empty"><strong>Aucun accès actif affiché</strong><p>Le mot de passe généré expire après 30 minutes. Une connexion déjà ouverte reste utilisable.</p></div>}</section>;
}

function Credential({ label, value, secret, onCopy }: { label: string; value: string; secret?: boolean; onCopy: () => void }) { return <div><small>{label}</small><code className={secret ? 'secret-value' : ''}>{value}</code><button className="secondary compact" onClick={onCopy}>Copier</button></div>; }

function BackupsPanel({ server }: { server: Server }) {
  const [backups, setBackups] = useState<BackupEntry[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const load = useCallback(() => api<BackupEntry[]>(`/api/servers/${server.id}/backups`).then(setBackups).catch((err) => setError(err.message)), [server.id]);
  useEffect(() => { void load(); }, [load]);
  async function create() { setBusy(true); try { await api(`/api/servers/${server.id}/backups`, { method: 'POST', body: JSON.stringify({ name: name || undefined }) }); setName(''); await load(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  async function restore(item: BackupEntry) { if (!confirm(`Restaurer ${item.name} ? Le serveur doit être arrêté.`)) return; try { await api(`/api/servers/${server.id}/backups/${encodeURIComponent(item.id)}/restore`, { method: 'POST' }); } catch (err) { setError((err as Error).message); } }
  async function remove(item: BackupEntry) { if (!confirm(`Supprimer définitivement ${item.name} ?`)) return; try { await api(`/api/servers/${server.id}/backups/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await load(); } catch (err) { setError((err as Error).message); } }
  return <section className="content-panel"><div className="content-toolbar"><div><h2>Sauvegardes</h2><small>Archives compressées stockées hors du monde</small></div><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom facultatif"/><button className="primary" disabled={busy} onClick={create}>{busy ? 'Sauvegarde…' : 'Créer une sauvegarde'}</button></div>{error && <div className="alert">{error}</div>}
    <div className="backup-grid">{backups.map((item) => <article key={item.id}><div className="backup-icon">◫</div><div><strong>{item.name}</strong><small>{formatBytes(item.size)} · {new Date(item.createdAt).toLocaleString('fr-FR')}</small></div><button className="secondary" onClick={() => restore(item)}>Restaurer</button><button className="table-action" onClick={() => remove(item)}>Supprimer</button></article>)}{!backups.length && <p className="panel-empty">Aucune sauvegarde pour ce serveur.</p>}</div>
  </section>;
}

function SchedulesPanel({ server }: { server: Server }) {
  const [items, setItems] = useState<ServerSchedule[]>([]); const [error, setError] = useState('');
  const load = useCallback(() => api<ServerSchedule[]>(`/api/servers/${server.id}/schedules`).then(setItems).catch((err) => setError(err.message)), [server.id]);
  useEffect(() => { void load(); }, [load]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/api/servers/${server.id}/schedules`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), action: form.get('action'), intervalMinutes: Number(form.get('intervalMinutes')), payload: form.get('payload') || undefined, enabled: true }) }); event.currentTarget.reset(); await load(); } catch (err) { setError((err as Error).message); } }
  async function toggle(item: ServerSchedule) { await api(`/api/servers/${server.id}/schedules/${item.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !item.enabled }) }); await load(); }
  async function run(item: ServerSchedule) { try { await api(`/api/servers/${server.id}/schedules/${item.id}/run`, { method: 'POST' }); await load(); } catch (err) { setError((err as Error).message); } }
  async function remove(item: ServerSchedule) { if (!confirm(`Supprimer la tâche « ${item.name} » ?`)) return; await api(`/api/servers/${server.id}/schedules/${item.id}`, { method: 'DELETE' }); await load(); }
  return <section className="content-panel">{error && <div className="alert">{error}</div>}<form className="schedule-form" onSubmit={create}><input name="name" required placeholder="Nom de la tâche"/><select name="action"><option value="restart">Redémarrer</option><option value="backup">Sauvegarder</option><option value="command">Commande</option><option value="start">Démarrer</option><option value="stop">Arrêter</option></select><input name="payload" placeholder="Commande (si nécessaire)"/><label>Toutes les <input name="intervalMinutes" type="number" min="1" defaultValue="1440"/> minutes</label><button className="primary">Ajouter</button></form>
    <div className="schedule-list">{items.map((item) => <article key={item.id}><span className={`schedule-state ${item.enabled ? 'enabled' : ''}`} /><div><strong>{item.name}</strong><small>{item.action} · toutes les {item.intervalMinutes} min · prochaine : {new Date(item.nextRunAt).toLocaleString('fr-FR')}</small></div>{item.lastStatus && <span className={`result ${item.lastStatus}`}>{item.lastStatus}</span>}<button className="secondary" onClick={() => run(item)}>Exécuter</button><button className="secondary" onClick={() => toggle(item)}>{item.enabled ? 'Désactiver' : 'Activer'}</button><button className="table-action" onClick={() => remove(item)}>Supprimer</button></article>)}</div>
  </section>;
}

function Members({ server, users }: { server: Server; users: UserRecord[] }) {
  const [members, setMembers] = useState<Array<{ userId: string; permissions: string[]; user: UserRecord }>>([]); const [selected, setSelected] = useState('');
  useEffect(() => { api<typeof members>(`/api/servers/${server.id}/members`).then(setMembers).catch(() => undefined); }, [server.id]);
  async function grant() { if (!selected) return; const permissions = ['console.read', 'console.command', 'power.start', 'power.stop', 'power.restart', 'files.read', 'files.write', 'backups.manage', 'schedules.manage']; await api(`/api/servers/${server.id}/members/${selected}`, { method: 'PUT', body: JSON.stringify({ permissions }) }); setMembers(await api(`/api/servers/${server.id}/members`)); setSelected(''); }
  const candidates = users.filter((user) => user.id !== server.ownerId && !members.some((member) => member.userId === user.id));
  return <section className="members-panel"><div><p className="eyebrow">ACCÈS PARTAGÉ</p><h2>Sous-utilisateurs</h2></div><div className="member-add"><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Choisir un utilisateur</option>{candidates.map((user) => <option value={user.id} key={user.id}>{user.username}</option>)}</select><button className="secondary" onClick={grant}>Donner l’accès</button></div>{members.map((member) => <div className="member-row" key={member.userId}><span className="user-avatar">{member.user.username[0]?.toUpperCase()}</span><div><strong>{member.user.username}</strong><small>{member.permissions.join(' · ')}</small></div></div>)}</section>;
}

interface PropertyDefinition { key: string; label: string; description: string; defaultValue: string; type?: 'text' | 'number'; min?: number; max?: number; options?: Array<[string, string]> }
const booleanOptions: Array<[string, string]> = [['true', 'Activé'], ['false', 'Désactivé']];
const propertyDefinitions: PropertyDefinition[] = [
  { key: 'motd', label: 'Message du serveur', description: 'Texte affiché dans la liste multijoueur.', defaultValue: 'A Minecraft Server' },
  { key: 'max-players', label: 'Joueurs maximum', description: 'Nombre de connexions simultanées.', defaultValue: '20', type: 'number', min: 1, max: 1000 },
  { key: 'gamemode', label: 'Mode de jeu', description: 'Mode appliqué aux nouveaux joueurs.', defaultValue: 'survival', options: [['survival', 'Survie'], ['creative', 'Créatif'], ['adventure', 'Aventure'], ['spectator', 'Spectateur']] },
  { key: 'difficulty', label: 'Difficulté', description: 'Difficulté globale du monde.', defaultValue: 'easy', options: [['peaceful', 'Paisible'], ['easy', 'Facile'], ['normal', 'Normale'], ['hard', 'Difficile']] },
  { key: 'pvp', label: 'Combat entre joueurs', description: 'Autorise les dégâts entre joueurs.', defaultValue: 'true', options: booleanOptions },
  { key: 'hardcore', label: 'Mode hardcore', description: 'Une mort entraîne le bannissement.', defaultValue: 'false', options: booleanOptions },
  { key: 'allow-flight', label: 'Autoriser le vol', description: 'Évite l’expulsion des joueurs qui volent.', defaultValue: 'false', options: booleanOptions },
  { key: 'enable-command-block', label: 'Blocs de commande', description: 'Active les command blocks.', defaultValue: 'false', options: booleanOptions },
  { key: 'white-list', label: 'Liste blanche', description: 'Limite les connexions aux joueurs autorisés.', defaultValue: 'false', options: booleanOptions },
  { key: 'enforce-whitelist', label: 'Forcer la liste blanche', description: 'Expulse les joueurs retirés de la liste.', defaultValue: 'false', options: booleanOptions },
  { key: 'view-distance', label: 'Distance d’affichage', description: 'Rayon de chunks envoyé aux joueurs.', defaultValue: '10', type: 'number', min: 2, max: 32 },
  { key: 'simulation-distance', label: 'Distance de simulation', description: 'Rayon de chunks actifs.', defaultValue: '10', type: 'number', min: 2, max: 32 },
  { key: 'spawn-protection', label: 'Protection du spawn', description: 'Rayon protégé autour du point d’apparition.', defaultValue: '16', type: 'number', min: 0, max: 1000 },
  { key: 'player-idle-timeout', label: 'Inactivité maximale', description: 'Minutes avant expulsion, 0 pour désactiver.', defaultValue: '0', type: 'number', min: 0, max: 10080 },
  { key: 'allow-nether', label: 'Nether', description: 'Autorise la dimension du Nether.', defaultValue: 'true', options: booleanOptions },
  { key: 'generate-structures', label: 'Structures', description: 'Génère villages, temples et autres structures.', defaultValue: 'true', options: booleanOptions },
  { key: 'level-seed', label: 'Graine du monde', description: 'S’applique lors de la prochaine génération de monde.', defaultValue: '' },
];
const defaultPropertyValues = Object.fromEntries(propertyDefinitions.map((item) => [item.key, item.defaultValue]));

function formatDownloads(value: number) { return new Intl.NumberFormat('fr-FR', { notation: value >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value); }
function formatBytes(value: number) { if (!value) return '0 o'; const units = ['o', 'Ko', 'Mo', 'Go', 'To']; const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`; }
function toSubdomain(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, ''); }
function logLineClass(line: string) { if (/\b(error|fatal|exception|failed|killed|outofmemory)\b/i.test(line)) return 'log-error'; if (/\bwarn(?:ing)?\b/i.test(line)) return 'log-warning'; return ''; }
function activityLabel(action: string) {
  const labels: Record<string, string> = {
    'server.installing': 'Création en cours', 'server.create': 'Serveur créé', 'server.install_failed': 'Échec de la création',
    'server.start': 'Serveur démarré', 'server.stop': 'Serveur arrêté', 'server.restart': 'Serveur redémarré', 'server.kill': 'Arrêt forcé',
    'server.repair': 'Conteneur réparé', 'server.rename': 'Serveur renommé', 'server.domain_update': 'Adresse de connexion modifiée', 'server.resources_update': 'Ressources modifiées',
    'server.properties_update': 'Propriétés modifiées', 'server.command': 'Commande exécutée', 'server.member_update': 'Accès partagé modifié',
    'backup.create': 'Sauvegarde créée', 'backup.restore': 'Sauvegarde restaurée', 'backup.delete': 'Sauvegarde supprimée',
    'content.install': 'Extension installée', 'content.delete': 'Extension supprimée', 'content.modpack_configure': 'Modpack installé',
    'file.write': 'Fichier enregistré', 'file.upload': 'Fichier importé', 'file.rename': 'Fichier renommé', 'file.mkdir': 'Dossier créé', 'file.delete': 'Fichier supprimé',
    'schedule.create': 'Tâche planifiée créée', 'schedule.delete': 'Tâche planifiée supprimée', 'schedule.execute': 'Tâche planifiée exécutée',
    'sftp.credentials_create': 'Accès SFTP généré',
  };
  return labels[action] ?? action.replaceAll('.', ' · ');
}
function activityIcon(action: string) { if (action.includes('failed') || action.endsWith('.kill')) return '!'; if (action.startsWith('backup.')) return '◫'; if (action.startsWith('file.')) return '▤'; if (action.startsWith('content.')) return '◆'; if (action.startsWith('schedule.')) return '◷'; if (action.includes('start')) return '▶'; if (action.includes('stop')) return '■'; return '↻'; }
function summarizeMetadata(metadata: Record<string, unknown>) { return Object.entries(metadata).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ').slice(0, 180); }
