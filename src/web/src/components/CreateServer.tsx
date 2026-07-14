import { FormEvent, KeyboardEvent, useState } from 'react';
import { api, type CurseForgeProject, type GatewayStatus, type NodeRecord, type Server, type UserRecord } from '../api';

type Software = Server['software'];
const moddedSoftware: Software[] = ['FABRIC', 'FORGE', 'NEOFORGE'];

export function CreateServer({ gateway, servers, nodes, users, busy, submitError, onClose, onSubmit }: { gateway: GatewayStatus; servers: Server[]; nodes: NodeRecord[]; users: UserRecord[]; busy: boolean; submitError?: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const gatewayReady = gateway.enabled && gateway.configured && Boolean(gateway.baseDomain);
  const nextPort = servers.length ? Math.max(...servers.map((server) => server.port)) + 1 : gatewayReady ? gateway.publicPort + 1 : 25565;
  const [name, setName] = useState('');
  const [publishDomain, setPublishDomain] = useState(gatewayReady);
  const [subdomain, setSubdomain] = useState('');
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [software, setSoftware] = useState<Software>('PAPER');
  const [version, setVersion] = useState('LATEST');
  const [nodeId, setNodeId] = useState(nodes.find((node) => node.online)?.id ?? nodes[0]?.id ?? '');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [diskMb, setDiskMb] = useState(10240);
  const [withModpack, setWithModpack] = useState(false);
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<CurseForgeProject[]>([]);
  const [selected, setSelected] = useState<CurseForgeProject>();
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [catalogError, setCatalogError] = useState('');

  function resetCatalog() { setProjects([]); setSelected(undefined); setSearched(false); setCatalogError(''); }
  function changeName(value: string) {
    setName(value);
    if (!subdomainEdited) setSubdomain(toSubdomain(value));
  }
  function changeSoftware(value: Software) { setSoftware(value); resetCatalog(); }
  function changeVersion(value: string) { setVersion(value); resetCatalog(); }
  function toggleModpack(enabled: boolean) {
    setWithModpack(enabled); resetCatalog();
    if (enabled) {
      if (!moddedSoftware.includes(software)) setSoftware('NEOFORGE');
      setMemoryMb((value) => Math.max(value, 6144));
      setDiskMb((value) => Math.max(value, 16384));
    }
  }

  function applyRecommendation(project = selected) {
    if (!project) return;
    if (project.minecraftVersion) setVersion(project.minecraftVersion);
    if (project.recommendedMemoryMb) setMemoryMb(project.recommendedMemoryMb);
    if (project.recommendedDiskMb) setDiskMb(project.recommendedDiskMb);
  }

  function chooseProject(project: CurseForgeProject) {
    setSelected(project);
    applyRecommendation(project);
  }

  async function searchCatalog() {
    if (!withModpack || loading) return;
    setLoading(true); setCatalogError(''); setSelected(undefined);
    try {
      const result = await api<{ configured: boolean; projects: CurseForgeProject[] }>(`/api/curseforge/modpacks?software=${software}&version=${encodeURIComponent(version)}&query=${encodeURIComponent(query.trim())}`);
      setConfigured(result.configured); setProjects(result.projects); setSearched(true);
    } catch (error) { setCatalogError((error as Error).message); setProjects([]); setSearched(true); }
    finally { setLoading(false); }
  }

  function searchOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault(); void searchCatalog();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    if (withModpack && !selected) { event.preventDefault(); setCatalogError('Choisissez un modpack avant de créer le serveur.'); return; }
    if (publishDomain && !subdomain) { event.preventDefault(); setCatalogError('Choisissez un sous-domaine pour l’adresse de connexion.'); return; }
    onSubmit(event);
  }

  const selectedNode = nodes.find((node) => node.id === nodeId);
  const nodeMemoryMb = selectedNode?.health ? Math.floor(selectedNode.health.memory.total / 1024 / 1024) : 0;
  const allocatedMemoryMb = servers.filter((server) => server.nodeId === nodeId).reduce((total, server) => total + server.memoryMb, 0);
  const exceedsNodeCapacity = Boolean(nodeMemoryMb && allocatedMemoryMb + memoryMb > nodeMemoryMb);
  const belowRecommendation = Boolean(selected && ((selected.recommendedMemoryMb ?? 0) > memoryMb || (selected.recommendedDiskMb ?? 0) > diskMb));

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="modal create-server-modal" onSubmit={submit}>
      <div className="modal-head"><div><p className="eyebrow">NOUVELLE INSTANCE</p><h2>Créer un serveur</h2></div><button type="button" className="close" onClick={onClose} disabled={busy}>×</button></div>
      {submitError && <div className="alert create-error" role="alert">{submitError}</div>}
      <div className="form-row">
        <label>Nom du serveur<input name="name" required minLength={2} maxLength={40} placeholder="Survie entre amis" value={name} onChange={(event) => changeName(event.target.value)} autoFocus /></label>
        <label>Nœud Linux<select name="nodeId" value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>{nodes.map((node) => <option key={node.id} value={node.id} disabled={!node.online}>{node.name} — {node.location}{!node.online ? ' (hors ligne)' : ''}</option>)}</select></label>
      </div>
      <label>Propriétaire<select name="ownerId" required>{users.map((user) => <option key={user.id} value={user.id}>{user.username} — {user.email}</option>)}</select></label>

      {gatewayReady ? <section className="gateway-create-card">
        <label className="gateway-toggle"><input type="checkbox" checked={publishDomain} onChange={(event) => setPublishDomain(event.target.checked)} /><span><strong>Créer une adresse de connexion sans port</strong><small>La passerelle acheminera les joueurs vers ce serveur via le port Minecraft standard.</small></span></label>
        {publishDomain && <label className="domain-label">Sous-domaine<div className="domain-input"><input name="subdomain" required minLength={1} maxLength={63} pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" value={subdomain} onChange={(event) => { setSubdomainEdited(true); setSubdomain(toSubdomain(event.target.value)); }} /><span>.{gateway.baseDomain}</span></div><small>Les joueurs utiliseront <strong>{subdomain || 'serveur'}.{gateway.baseDomain}</strong>, sans ajouter de port.</small></label>}
      </section> : <div className="modpack-warning">La passerelle de domaines Minecraft n’est pas activée. Ce serveur utilisera encore une adresse avec port.</div>}

      <div className="form-row">
        <label>Logiciel<select name="software" value={software} onChange={(event) => changeSoftware(event.target.value as Software)}><option>PAPER</option><option>VANILLA</option><option>PURPUR</option><option>FABRIC</option><option>FORGE</option><option>NEOFORGE</option></select></label>
        <label>Version Minecraft<input name="version" value={version} onChange={(event) => changeVersion(event.target.value)} required /></label>
      </div>

      <label className="modpack-toggle"><input type="checkbox" checked={withModpack} onChange={(event) => toggleModpack(event.target.checked)} /><span><strong>Installer directement un modpack CurseForge</strong><small>Padock téléchargera et appliquera le server pack officiel fourni par l’auteur.</small></span></label>

      {withModpack && <section className="create-modpack-picker">
        <div className="picker-head"><div><strong>Choisir le modpack</strong><small>{software} · {version}</small></div>{selected && <span className="selected-pack">✓ {selected.title}</span>}</div>
        {!configured && <div className="modpack-warning">La clé API CurseForge n’est pas configurée.</div>}
        {catalogError && <div className="alert">{catalogError}</div>}
        <div className="modpack-search"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchOnEnter} placeholder="Rechercher All the Mods, Better MC…" /><button type="button" className="secondary" onClick={() => void searchCatalog()} disabled={loading}>{loading ? 'Recherche…' : 'Rechercher'}</button></div>
        <div className="modpack-results">
          {projects.slice(0, 8).map((project) => <button type="button" key={project.id} className={selected?.id === project.id ? 'modpack-result active' : 'modpack-result'} aria-label={`Sélectionner ${project.title}`} aria-pressed={selected?.id === project.id} onClick={() => chooseProject(project)}>
            {project.iconUrl ? <img src={project.iconUrl} alt="" loading="lazy" /> : <span className="extension-placeholder">◆</span>}
            <span><strong>{project.title}</strong><small>par {project.author} · {formatDownloads(project.downloads)} téléchargements</small><em>{project.description}</em><i className="pack-compat">SERVER PACK · MC {project.minecraftVersion ?? version} · {formatMegabytes(project.recommendedMemoryMb ?? 6144)} RAM</i></span>
            <b>{selected?.id === project.id ? 'Sélectionné' : 'Choisir'}</b>
          </button>)}
          {searched && !loading && !projects.length && configured && <p>Aucun server pack officiel compatible n’est disponible pour ce loader et cette version Minecraft.</p>}
        </div>
        <p className="picker-hint">Le catalogue masque automatiquement les modpacks sans server pack ZIP officiel. L’archive est téléchargée et vérifiée avant la création du conteneur.</p>
        {version.toUpperCase() === 'LATEST' && <p className="picker-hint">Conseil : indiquez une version Minecraft précise pour filtrer les packs compatibles.</p>}
        {selected && <div className={`resource-recommendation ${belowRecommendation ? 'warning' : ''}`}><div><strong>{belowRecommendation ? 'Ressources inférieures à la recommandation' : 'Configuration recommandée appliquée'}</strong><span>{selected.minecraftVersion ? `Minecraft ${selected.minecraftVersion} · ` : ''}{formatMegabytes(selected.recommendedMemoryMb ?? memoryMb)} RAM · {formatMegabytes(selected.recommendedDiskMb ?? diskMb)} disque</span></div><button type="button" className="secondary compact" disabled={!belowRecommendation} onClick={() => applyRecommendation()}>{belowRecommendation ? 'Appliquer' : 'Appliquée'}</button></div>}
        <input type="hidden" name="modpackProjectId" value={selected?.id ?? ''} />
        <input type="hidden" name="modpackSlug" value={selected?.slug ?? ''} />
      </section>}

      <div className="form-row">
        <label>Mémoire (Mo)<input name="memoryMb" type="number" min="1024" max="65536" step="512" value={memoryMb} onChange={(event) => setMemoryMb(Number(event.target.value))} required /></label>
        {gatewayReady ? <label>Allocation réseau<span className="readonly-field">Automatique · port interne masqué aux joueurs</span></label> : <label>Port public<input name="port" type="number" min="1024" max="65535" defaultValue={nextPort} required /></label>}
      </div>
      <div className="form-row">
        <label>CPU (%)<input name="cpuPercent" type="number" min="10" max="1600" defaultValue="100" required /></label>
        <label>Disque (Mo)<input name="diskMb" type="number" min="1024" max="1048576" step="1024" value={diskMb} onChange={(event) => setDiskMb(Number(event.target.value))} required /></label>
      </div>
      {exceedsNodeCapacity && <div className="modpack-warning">Attention : {formatMegabytes(allocatedMemoryMb)} sont déjà alloués sur {formatMegabytes(nodeMemoryMb)}. Cette nouvelle instance dépasserait la capacité mémoire du nœud.</div>}
      <p className="hint">{busy ? 'Téléchargement et vérification du server pack…' : withModpack ? 'Le server pack sera téléchargé maintenant. Le serveur restera arrêté jusqu’à ce que vous le démarriez.' : 'L’image Minecraft sera téléchargée lors de la première création. Le monde restera stocké sur le disque de l’hôte.'}</p>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Annuler</button><button className="primary" disabled={busy || (withModpack && !selected)}>{busy ? 'Préparation…' : withModpack ? 'Créer avec ce modpack' : 'Créer le serveur'}</button></div>
    </form>
  </div>;
}

function formatDownloads(value: number) {
  return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatMegabytes(value: number) {
  return value >= 1024 ? `${Math.round(value / 102.4) / 10} Go` : `${value} Mo`;
}

function toSubdomain(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
}
