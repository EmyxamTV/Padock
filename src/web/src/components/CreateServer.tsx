import { FormEvent, KeyboardEvent, useEffect, useState } from 'react';
import { api, type CurseForgeProject, type GatewayStatus, type NetworkAllocation, type NodeRecord, type Server, type ServerTemplate } from '../api';

type Software = Server['software'];
const moddedSoftware: Software[] = ['FABRIC', 'FORGE', 'NEOFORGE'];

export function CreateServer({ gateway, servers, nodes, users, busy, submitError, onClose, onSubmit }: { gateway: GatewayStatus; servers: Server[]; nodes: NodeRecord[]; users: Array<{ id: string; username: string; email?: string }>; busy: boolean; submitError?: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const gatewayReady = gateway.enabled && gateway.configured && Boolean(gateway.baseDomain);
  const [name, setName] = useState('');
  const [publishDomain, setPublishDomain] = useState(gatewayReady);
  const [subdomain, setSubdomain] = useState('');
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [software, setSoftware] = useState<Software>('PAPER');
  const [version, setVersion] = useState('LATEST');
  const [nodeId, setNodeId] = useState(nodes.find((node) => node.online && !node.maintenance)?.id ?? nodes.find((node) => !node.maintenance)?.id ?? '');
  const [allocations, setAllocations] = useState<NetworkAllocation[]>([]);
  const [allocationId, setAllocationId] = useState('');
  const [allocationsLoading, setAllocationsLoading] = useState(false);
  const [allocationError, setAllocationError] = useState('');
  const [memoryMb, setMemoryMb] = useState(4096);
  const [cpuPercent, setCpuPercent] = useState(100);
  const [diskMb, setDiskMb] = useState(10240);
  const [templates, setTemplates] = useState<ServerTemplate[]>([]);
  const [withModpack, setWithModpack] = useState(false);
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<CurseForgeProject[]>([]);
  const [selected, setSelected] = useState<CurseForgeProject>();
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [catalogError, setCatalogError] = useState('');

  useEffect(() => { api<ServerTemplate[]>('/api/templates').then(setTemplates).catch(() => undefined); }, []);

  useEffect(() => {
    let active = true;
    setAllocations([]); setAllocationId(''); setAllocationError('');
    if (!nodeId) return () => { active = false; };
    setAllocationsLoading(true);
    api<NetworkAllocation[]>(`/api/nodes/${nodeId}/allocations/available`)
      .then((items) => {
        if (!active) return;
        setAllocations(items); setAllocationId(items[0]?.id ?? '');
        if (!items.length) setAllocationError('Ce nœud ne possède aucune allocation réseau libre. Ajoutez des ports depuis la page Nœuds.');
      })
      .catch((error) => { if (active) setAllocationError((error as Error).message); })
      .finally(() => { if (active) setAllocationsLoading(false); });
    return () => { active = false; };
  }, [nodeId]);

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
  function applyTemplate(id: string) { const template = templates.find((item) => item.id === id); if (!template) return; setSoftware(template.software); setVersion(template.version); setMemoryMb(template.memoryMb); setCpuPercent(template.cpuPercent); setDiskMb(template.diskMb); setWithModpack(false); resetCatalog(); }

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
    if (!allocationId) { event.preventDefault(); setAllocationError('Choisissez une allocation réseau libre avant de créer le serveur.'); return; }
    onSubmit(event);
  }

  const selectedNode = nodes.find((node) => node.id === nodeId);
  const nodeMemoryMb = selectedNode?.maxMemoryMb ?? (selectedNode?.health ? Math.floor(selectedNode.health.memory.total / 1024 / 1024) : 0);
  const allocatedMemoryMb = servers.filter((server) => server.nodeId === nodeId).reduce((total, server) => total + server.memoryMb, 0);
  const exceedsNodeCapacity = Boolean(nodeMemoryMb && allocatedMemoryMb + memoryMb > nodeMemoryMb);
  const belowRecommendation = Boolean(selected && ((selected.recommendedMemoryMb ?? 0) > memoryMb || (selected.recommendedDiskMb ?? 0) > diskMb));

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <form className="modal create-server-modal" onSubmit={submit}>
      <div className="modal-head"><div><p className="eyebrow">NOUVELLE INSTANCE</p><h2>Créer un serveur</h2></div><button type="button" className="close" onClick={onClose} disabled={busy}>×</button></div>
      {submitError && <div className="alert create-error" role="alert">{submitError}</div>}
      {templates.length > 0 && <label>Modèle de configuration<select defaultValue="" onChange={(event) => applyTemplate(event.target.value)}><option value="">Configuration personnalisée</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.software} {template.version}</option>)}</select><small>Préremplit le logiciel, la version et les ressources.</small></label>}
      <div className="form-row">
        <label>Nom du serveur<input name="name" required minLength={2} maxLength={40} placeholder="Survie entre amis" value={name} onChange={(event) => changeName(event.target.value)} autoFocus /></label>
        <label>Nœud Linux<select name="nodeId" value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>{nodes.map((node) => <option key={node.id} value={node.id} disabled={!node.online || node.maintenance}>{node.name} — {node.location}{!node.online ? ' (hors ligne)' : node.maintenance ? ' (maintenance)' : ''}</option>)}</select></label>
      </div>
      <label>Propriétaire<select name="ownerId" required>{users.map((user) => <option key={user.id} value={user.id}>{user.username}{user.email ? ` — ${user.email}` : ''}</option>)}</select></label>

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
        <label>{gatewayReady ? 'Port interne' : 'Allocation réseau'}<select name="allocationId" value={allocationId} onChange={(event) => setAllocationId(event.target.value)} required disabled={allocationsLoading || !allocations.length}><option value="">{allocationsLoading ? 'Chargement des ports…' : 'Aucun port libre'}</option>{allocations.map((allocation) => <option value={allocation.id} key={allocation.id}>{allocationLabel(allocation)}</option>)}</select><small>{gatewayReady ? 'Choisi dans la plage du nœud et masqué aux joueurs par la passerelle.' : 'Seuls les ports libres configurés sur le nœud sont proposés.'}</small></label>
      </div>
      {allocationError && <div className="modpack-warning">{allocationError}</div>}
      <div className="form-row">
        <label>CPU (%)<input name="cpuPercent" type="number" min="10" max="1600" value={cpuPercent} onChange={(event) => setCpuPercent(Number(event.target.value))} required /></label>
        <label>Disque (Mo)<input name="diskMb" type="number" min="1024" max="1048576" step="1024" value={diskMb} onChange={(event) => setDiskMb(Number(event.target.value))} required /></label>
      </div>
      {exceedsNodeCapacity && <div className="modpack-warning">Attention : {formatMegabytes(allocatedMemoryMb)} sont déjà alloués sur {formatMegabytes(nodeMemoryMb)}. Cette nouvelle instance dépasserait la capacité mémoire du nœud.</div>}
      <p className="hint">{busy ? 'Ajout dans la file d’opérations…' : withModpack ? 'Le server pack sera installé en arrière-plan. Vous pourrez suivre sa progression dans Opérations.' : 'La création continuera en arrière-plan même si vous fermez la page.'}</p>
      <div className="modal-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>Annuler</button><button className="primary" disabled={busy || !allocationId || (withModpack && !selected)}>{busy ? 'Préparation…' : withModpack ? 'Créer avec ce modpack' : 'Créer le serveur'}</button></div>
    </form>
  </div>;
}

function formatDownloads(value: number) {
  return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatMegabytes(value: number) {
  return value >= 1024 ? `${Math.round(value / 102.4) / 10} Go` : `${value} Mo`;
}

function allocationLabel(allocation: NetworkAllocation) {
  const address = allocation.alias || (allocation.ip === '0.0.0.0' ? 'Toutes les interfaces' : allocation.ip);
  return `${address}:${allocation.port}`;
}

function toSubdomain(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
}
