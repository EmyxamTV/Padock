import { FormEvent, useState } from 'react';
import { api, type PanelPermission, type PanelRole, type ServerPermission, type UserGroup, type UserRecord } from '../api';

const permissionDefinitions: Array<{ value: PanelPermission; label: string; description: string }> = [
  { value: 'servers.create', label: 'Créer des serveurs', description: 'Créer ses propres instances et utiliser le catalogue de modpacks.' },
  { value: 'servers.manage_all', label: 'Gérer tous les serveurs', description: 'Voir et administrer toutes les instances comme leur propriétaire.' },
  { value: 'nodes.view', label: 'Voir les nœuds', description: 'Consulter toute l’infrastructure, sans pouvoir la modifier.' },
  { value: 'nodes.manage', label: 'Gérer les nœuds', description: 'Ajouter des agents et des plages d’allocations.' },
  { value: 'users.manage', label: 'Gérer les utilisateurs', description: 'Créer des comptes et déléguer ses propres permissions.' },
  { value: 'audit.view', label: 'Voir le journal d’audit', description: 'Consulter les actions effectuées sur le panel.' },
];

const serverPermissionValues: ServerPermission[] = ['console.read', 'console.command', 'power.start', 'power.stop', 'power.restart', 'files.read', 'files.write', 'content.manage', 'settings.manage', 'backups.manage', 'schedules.manage', 'sftp.manage', 'members.manage', 'server.delete'];

export function UsersView({ users, roles, groups, me, onChanged }: { users: UserRecord[]; roles: PanelRole[]; groups: UserGroup[]; me: UserRecord; onChanged: () => void }) {
  const [creatingUser, setCreatingUser] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord>();
  const [creatingRole, setCreatingRole] = useState(false);
  const [editingRole, setEditingRole] = useState<PanelRole>();
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<UserGroup>();
  const [error, setError] = useState('');

  function closeEditors() { setCreatingUser(false); setEditingUser(undefined); setCreatingRole(false); setEditingRole(undefined); setCreatingGroup(false); setEditingGroup(undefined); }
  function completed() { closeEditors(); setError(''); onChanged(); }
  async function removeUser(user: UserRecord) {
    if (!confirm(`Supprimer définitivement le compte « ${user.username} » et tous ses accès partagés ?`)) return;
    try { await api(`/api/users/${user.id}`, { method: 'DELETE' }); completed(); }
    catch (err) { setError((err as Error).message); }
  }
  async function removeRole(role: PanelRole) {
    if (!confirm(`Supprimer définitivement le rôle « ${role.name} » ?`)) return;
    try { await api(`/api/roles/${role.id}`, { method: 'DELETE' }); completed(); }
    catch (err) { setError((err as Error).message); }
  }
  async function removeGroup(group: UserGroup) { if (!confirm(`Supprimer le groupe « ${group.name} » ?`)) return; try { await api(`/api/groups/${group.id}`, { method: 'DELETE' }); completed(); } catch (err) { setError((err as Error).message); } }

  return <>
    <div className="section-actions user-section-actions">
      {me.role === 'admin' && <button className="secondary" onClick={() => { closeEditors(); setCreatingRole(true); }}>＋ Nouveau rôle</button>}
      {me.role === 'admin' && <button className="secondary" onClick={() => { closeEditors(); setCreatingGroup(true); }}>＋ Nouveau groupe</button>}
      <button className="primary" onClick={() => { closeEditors(); setCreatingUser(true); }}>＋ Nouvel utilisateur</button>
    </div>
    {error && <div className="alert">{error}<button onClick={() => setError('')}>×</button></div>}
    {creatingRole && <RoleForm onCancel={closeEditors} onCompleted={completed} />}
    {editingRole && <RoleForm role={editingRole} onCancel={closeEditors} onCompleted={completed} />}
    {creatingGroup && <GroupForm onCancel={closeEditors} onCompleted={completed} />}
    {editingGroup && <GroupForm group={editingGroup} onCancel={closeEditors} onCompleted={completed} />}
    {creatingUser && <UserAccessForm me={me} roles={roles} groups={groups} onCancel={closeEditors} onCompleted={completed} />}
    {editingUser && <UserAccessForm me={me} roles={roles} groups={groups} user={editingUser} onCancel={closeEditors} onCompleted={completed} />}

    <section className="role-management">
      <div className="section-head compact"><div><p className="eyebrow">MODÈLES D’ACCÈS</p><h2>Rôles personnalisés</h2></div><span>{roles.length} rôle{roles.length > 1 ? 's' : ''}</span></div>
      <p className="section-description">Une modification du rôle est appliquée automatiquement à tous les comptes qui l’utilisent.</p>
      {roles.length ? <div className="role-grid">{roles.map((role) => <article className="role-card" key={role.id}>
        <div className="role-card-head"><div><span className="role-symbol">R</span><div><h3>{role.name}</h3><small>{role.memberCount} utilisateur{role.memberCount > 1 ? 's' : ''}</small></div></div>{me.role === 'admin' && <div className="user-row-actions"><button className="secondary compact" onClick={() => { closeEditors(); setEditingRole(role); }}>Modifier</button><button className="table-action" disabled={role.memberCount > 0} title={role.memberCount ? 'Retirez ce rôle des utilisateurs avant de le supprimer.' : undefined} onClick={() => removeRole(role)}>Supprimer</button></div>}</div>
        <p>{role.description || 'Aucune description.'}</p>
        <div className="permission-summary">{role.permissions.length ? role.permissions.map((permission) => <code key={permission}>{permissionLabel(permission)}</code>) : <span>Aucune permission globale</span>}</div>
      </article>)}</div> : <div className="empty compact-empty role-empty"><div className="empty-cube">♙</div><h2>Aucun rôle personnalisé</h2><p>Créez des modèles de droits pour vos équipes de modération, support ou administration.</p></div>}
    </section>

    <section className="role-management">
      <div className="section-head compact"><div><p className="eyebrow">ÉQUIPES</p><h2>Groupes utilisateurs</h2></div><span>{groups.length} groupe{groups.length > 1 ? 's' : ''}</span></div>
      <p className="section-description">Les groupes ajoutent des permissions globales et des droits par défaut sur les serveurs déjà attribués.</p>
      <div className="role-grid">{groups.map((group) => <article className="role-card" key={group.id}><div className="role-card-head"><div><span className="role-symbol">G</span><div><h3>{group.name}</h3><small>{group.memberCount} membre{group.memberCount > 1 ? 's' : ''}</small></div></div><div className="user-row-actions"><button className="secondary compact" onClick={() => { closeEditors(); setEditingGroup(group); }}>Modifier</button><button className="table-action" onClick={() => removeGroup(group)}>Supprimer</button></div></div><p>{group.description || 'Aucune description.'}</p><div className="permission-summary">{group.permissions.map((permission) => <code key={permission}>{permissionLabel(permission)}</code>)}{group.serverPermissions.map((permission) => <code key={permission}>Serveur · {permission}</code>)}</div></article>)}</div>
    </section>

    <div className="section-head compact users-heading"><div><p className="eyebrow">COMPTES DU PANEL</p><h2>Utilisateurs</h2></div><span>{users.length} compte{users.length > 1 ? 's' : ''}</span></div>
    <div className="table-card user-access-table"><table><thead><tr><th>UTILISATEUR</th><th>E-MAIL</th><th>RÔLE / GROUPES</th><th>PERMISSIONS EFFECTIVES</th><th>CRÉÉ LE</th><th /></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td><span className="user-avatar">{user.username[0]?.toUpperCase()}</span><strong>{user.username}</strong>{user.id === me.id && <small className="current-user">Vous</small>}</td><td>{user.email}</td><td><span className={`role-badge ${user.role === 'admin' ? 'admin' : user.customRole ? 'custom' : 'user'}`}>{user.role === 'admin' ? 'Administrateur' : user.customRole?.name ?? 'Utilisateur'}</span><div className="permission-summary">{user.groups.map((group) => <code key={group.id}>{group.name}</code>)}</div></td><td><div className="permission-summary">{user.role === 'admin' ? <span>Tous les droits</span> : user.permissions.length ? user.permissions.map((permission) => <code key={permission}>{permissionLabel(permission)}</code>) : <span>Accès uniquement aux serveurs attribués</span>}</div></td><td>{new Date(user.createdAt).toLocaleDateString('fr-FR')}</td><td><div className="user-row-actions">{user.id !== me.id && <button className="secondary compact" onClick={() => { closeEditors(); setEditingUser(user); }}>Modifier</button>}{user.id !== me.id && <button className="table-action" onClick={() => removeUser(user)}>Supprimer</button>}</div></td></tr>)}</tbody></table></div>
  </>;
}

function RoleForm({ role, onCancel, onCompleted }: { role?: PanelRole; onCancel: () => void; onCompleted: () => void }) {
  const [permissions, setPermissions] = useState<PanelPermission[]>(role?.permissions ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function toggle(permission: PanelPermission) { setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api(role ? `/api/roles/${role.id}` : '/api/roles', { method: role ? 'PUT' : 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description'), permissions }) });
      onCompleted();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="inline-form user-access-form role-form" onSubmit={submit}>
    <div className="content-toolbar"><div><h2>{role ? `Modifier le rôle ${role.name}` : 'Créer un rôle personnalisé'}</h2><small>Les utilisateurs associés héritent immédiatement de ces permissions globales.</small></div></div>
    {error && <div className="alert">{error}</div>}
    <div className="form-row"><label>Nom du rôle<input name="name" required minLength={2} maxLength={40} defaultValue={role?.name} placeholder="Modérateur" /></label><label>Description<input name="description" maxLength={200} defaultValue={role?.description} placeholder="Gestion quotidienne des serveurs" /></label></div>
    <PermissionPicker title="Permissions du rôle" permissions={permissions} definitions={permissionDefinitions} onToggle={toggle} />
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Annuler</button><button className="primary" disabled={busy}>{busy ? 'Enregistrement…' : role ? 'Enregistrer le rôle' : 'Créer le rôle'}</button></div>
  </form>;
}

function GroupForm({ group, onCancel, onCompleted }: { group?: UserGroup; onCancel: () => void; onCompleted: () => void }) {
  const [permissions, setPermissions] = useState<PanelPermission[]>(group?.permissions ?? []); const [serverPermissions, setServerPermissions] = useState<ServerPermission[]>(group?.serverPermissions ?? []); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function togglePanel(permission: PanelPermission) { setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]); }
  function toggleServer(permission: ServerPermission) { setServerPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]); }
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); const form = new FormData(event.currentTarget); try { await api(group ? `/api/groups/${group.id}` : '/api/groups', { method: group ? 'PUT' : 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description'), permissions, serverPermissions }) }); onCompleted(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }
  return <form className="inline-form user-access-form" onSubmit={submit}><div className="content-toolbar"><div><h2>{group ? `Modifier ${group.name}` : 'Créer un groupe'}</h2><small>Une équipe peut cumuler droits globaux et droits par défaut sur les serveurs attribués.</small></div></div>{error && <div className="alert">{error}</div>}<div className="form-row"><label>Nom<input name="name" defaultValue={group?.name} minLength={2} maxLength={40} required/></label><label>Description<input name="description" defaultValue={group?.description} maxLength={200}/></label></div><PermissionPicker title="Permissions globales" permissions={permissions} definitions={permissionDefinitions} onToggle={togglePanel}/><div className="permission-picker"><div className="permission-picker-head"><strong>Droits serveur hérités</strong><span>{serverPermissions.length} sélectionné(s)</span></div><div className="permission-options">{serverPermissionValues.map((permission) => <label className={serverPermissions.includes(permission) ? 'selected' : ''} key={permission}><input type="checkbox" checked={serverPermissions.includes(permission)} onChange={() => toggleServer(permission)}/><span><strong>{permission}</strong><small>Droit ajouté sur les serveurs déjà partagés avec le membre.</small></span></label>)}</div></div><div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Annuler</button><button className="primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer le groupe'}</button></div></form>;
}

function UserAccessForm({ me, roles, groups, user, onCancel, onCompleted }: { me: UserRecord; roles: PanelRole[]; groups: UserGroup[]; user?: UserRecord; onCancel: () => void; onCompleted: () => void }) {
  const initialAccess = user?.role === 'admin' ? 'admin' : user?.roleId ? `role:${user.roleId}` : 'user';
  const [access, setAccess] = useState(initialAccess);
  const [permissions, setPermissions] = useState<PanelPermission[]>(user?.directPermissions ?? user?.permissions ?? []);
  const [groupIds, setGroupIds] = useState<string[]>(user?.groupIds ?? []);
  const [quota, setQuota] = useState(user?.quota ?? { maxServers: -1, maxMemoryMb: -1, maxDiskMb: -1, maxBackups: -1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allowedPermissions = me.role === 'admin' ? permissionDefinitions : permissionDefinitions.filter((item) => me.permissions.includes(item.value));
  const assignableRoles = me.role === 'admin' ? roles : roles.filter((role) => role.permissions.every((permission) => me.permissions.includes(permission)));
  const selectedRole = access.startsWith('role:') ? roles.find((role) => role.id === access.slice(5)) : undefined;
  const additionalDefinitions = allowedPermissions.filter((item) => !selectedRole?.permissions.includes(item.value));
  function toggle(permission: PanelPermission) { setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const role = access === 'admin' ? 'admin' : 'user';
    const roleId = access.startsWith('role:') ? access.slice(5) : null;
    const directPermissions = role === 'admin' ? [] : permissions.filter((permission) => !selectedRole?.permissions.includes(permission));
    const advanced = me.role === 'admin' ? { groupIds: role === 'admin' ? [] : groupIds, quota } : {};
    try {
      if (user) {
        const password = String(form.get('password') ?? '');
        await api(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ role, roleId, ...advanced, permissions: directPermissions, ...(password ? { password } : {}) }) });
      } else {
        await api('/api/users', { method: 'POST', body: JSON.stringify({ username: form.get('username'), email: form.get('email'), password: form.get('password'), role, roleId, ...advanced, permissions: directPermissions }) });
      }
      onCompleted();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="inline-form user-access-form" onSubmit={submit}>
    <div className="content-toolbar"><div><h2>{user ? `Droits de ${user.username}` : 'Créer un compte'}</h2><small>Le rôle fournit une base commune, complétée si nécessaire par des permissions propres au compte.</small></div></div>
    {error && <div className="alert">{error}</div>}
    {!user && <div className="form-row"><label>Nom<input name="username" required minLength={3}/></label><label>E-mail<input name="email" type="email" required/></label></div>}
    <div className="form-row"><label>{user ? 'Réinitialiser le mot de passe' : 'Mot de passe'}<input name="password" type="password" minLength={10} required={!user} placeholder={user ? 'Laisser vide pour le conserver' : '10 caractères minimum'}/></label><label>Type d’accès<select value={access} onChange={(event) => setAccess(event.target.value)}><option value="user">Utilisateur sans rôle</option>{assignableRoles.map((role) => <option value={`role:${role.id}`} key={role.id}>{role.name}</option>)}{me.role === 'admin' && <option value="admin">Administrateur système</option>}</select><small>Un administrateur système possède automatiquement tous les droits.</small></label></div>
    {selectedRole && <div className="inherited-role"><div><strong>Permissions héritées de {selectedRole.name}</strong><small>{selectedRole.description || 'Rôle personnalisé'}</small></div><div className="permission-summary">{selectedRole.permissions.length ? selectedRole.permissions.map((permission) => <code key={permission}>{permissionLabel(permission)}</code>) : <span>Aucune permission globale</span>}</div></div>}
    {me.role === 'admin' && access !== 'admin' && <div className="permission-picker"><div className="permission-picker-head"><strong>Groupes</strong><span>{groupIds.length} sélectionné(s)</span></div><div className="permission-options">{groups.map((group) => <label className={groupIds.includes(group.id) ? 'selected' : ''} key={group.id}><input type="checkbox" checked={groupIds.includes(group.id)} onChange={() => setGroupIds((current) => current.includes(group.id) ? current.filter((item) => item !== group.id) : [...current, group.id])}/><span><strong>{group.name}</strong><small>{group.description || 'Groupe utilisateur'}</small></span></label>)}</div></div>}
    {me.role === 'admin' && access !== 'admin' && <div className="quota-grid"><label>Serveurs max<input type="number" min="-1" value={quota.maxServers} onChange={(event) => setQuota({ ...quota, maxServers: Number(event.target.value) })}/><small>-1 = illimité</small></label><label>RAM totale (Mo)<input type="number" min="-1" value={quota.maxMemoryMb} onChange={(event) => setQuota({ ...quota, maxMemoryMb: Number(event.target.value) })}/></label><label>Disque total (Mo)<input type="number" min="-1" value={quota.maxDiskMb} onChange={(event) => setQuota({ ...quota, maxDiskMb: Number(event.target.value) })}/></label><label>Sauvegardes max<input type="number" min="-1" value={quota.maxBackups} onChange={(event) => setQuota({ ...quota, maxBackups: Number(event.target.value) })}/></label></div>}
    {access !== 'admin' && <PermissionPicker title={selectedRole ? 'Permissions supplémentaires du compte' : 'Permissions propres au compte'} permissions={permissions.filter((permission) => !selectedRole?.permissions.includes(permission))} definitions={additionalDefinitions} onToggle={toggle} />}
    <div className="modal-actions"><button type="button" className="secondary" onClick={onCancel}>Annuler</button><button className="primary" disabled={busy}>{busy ? 'Enregistrement…' : user ? 'Enregistrer les droits' : 'Créer le compte'}</button></div>
  </form>;
}

function PermissionPicker({ title, permissions, definitions, onToggle }: { title: string; permissions: PanelPermission[]; definitions: typeof permissionDefinitions; onToggle: (permission: PanelPermission) => void }) {
  return <div className="permission-picker"><div className="permission-picker-head"><strong>{title}</strong><span>{permissions.length} sélectionnée{permissions.length > 1 ? 's' : ''}</span></div>{definitions.length ? <div className="permission-options">{definitions.map((item) => <label className={permissions.includes(item.value) ? 'selected' : ''} key={item.value}><input type="checkbox" checked={permissions.includes(item.value)} onChange={() => onToggle(item.value)}/><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</div> : <div className="permission-picker-empty">Toutes les permissions disponibles sont déjà fournies par ce rôle.</div>}</div>;
}

function permissionLabel(permission: PanelPermission) { return permissionDefinitions.find((item) => item.value === permission)?.label ?? permission; }
