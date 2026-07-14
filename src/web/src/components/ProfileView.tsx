import { FormEvent, useEffect, useState } from 'react';
import { api, type ApiKeyRecord, type UserRecord, type UserSession } from '../api';

export function ProfileView({ user, onChanged }: { user: UserRecord; onChanged: (user: UserRecord) => void }) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [createdApiKey, setCreatedApiKey] = useState('');

  useEffect(() => { setUsername(user.username); setEmail(user.email); }, [user.id, user.username, user.email]);
  useEffect(() => { void loadSecurity(); }, [user.id]);

  async function loadSecurity() { const [sessionList, keys] = await Promise.all([api<UserSession[]>('/api/auth/sessions'), api<ApiKeyRecord[]>('/api/auth/api-keys')]); setSessions(sessionList); setApiKeys(keys); }
  async function refreshUser() { onChanged(await api<UserRecord>('/api/auth/me')); }
  async function setup2fa() { setError(''); if (!currentPassword) return setError('Saisissez votre mot de passe actuel avant d’activer la 2FA.'); try { const result = await api<{ secret: string }>('/api/auth/2fa/setup', { method: 'POST', body: JSON.stringify({ currentPassword }) }); setTotpSecret(result.secret); setMessage('Ajoutez cette clé dans votre application d’authentification, puis confirmez le code.'); } catch (err) { setError((err as Error).message); } }
  async function confirm2fa() { try { const result = await api<{ recoveryCodes: string[] }>('/api/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ code: totpCode }) }); setRecoveryCodes(result.recoveryCodes); setTotpSecret(''); setTotpCode(''); setMessage('Double authentification activée. Conservez les codes de récupération.'); await refreshUser(); } catch (err) { setError((err as Error).message); } }
  async function disable2fa() { if (!currentPassword || !totpCode) return setError('Le mot de passe actuel et un code de sécurité sont obligatoires.'); try { await api('/api/auth/2fa', { method: 'DELETE', body: JSON.stringify({ currentPassword, code: totpCode }) }); setTotpCode(''); setRecoveryCodes([]); setMessage('Double authentification désactivée.'); await refreshUser(); } catch (err) { setError((err as Error).message); } }
  async function createKey() { const name = prompt('Nom de la clé API :', 'Intégration'); if (!name) return; try { const result = await api<ApiKeyRecord & { secret: string }>('/api/auth/api-keys', { method: 'POST', body: JSON.stringify({ name }) }); setCreatedApiKey(result.secret); await loadSecurity(); } catch (err) { setError((err as Error).message); } }
  async function revokeKey(id: string) { if (!confirm('Révoquer définitivement cette clé API ?')) return; await api(`/api/auth/api-keys/${id}`, { method: 'DELETE' }); await loadSecurity(); }
  async function revokeSession(id: string) { await api(`/api/auth/sessions/${id}`, { method: 'DELETE' }); await loadSecurity(); }
  async function verifyEmail() { try { await api('/api/auth/email/verification', { method: 'POST' }); setMessage('E-mail de vérification envoyé.'); } catch (err) { setError((err as Error).message); } }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('');
    if (newPassword && newPassword !== confirmation) return setError('La confirmation du nouveau mot de passe ne correspond pas.');
    setBusy(true);
    try {
      const updated = await api<UserRecord>('/api/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ username, email, currentPassword, newPassword: newPassword || undefined }),
      });
      setCurrentPassword(''); setNewPassword(''); setConfirmation('');
      setMessage(newPassword ? 'Profil et mot de passe mis à jour.' : 'Profil mis à jour.');
      onChanged(updated);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  const identityChanged = username.trim() !== user.username || email.trim().toLocaleLowerCase() !== user.email.toLocaleLowerCase();
  const canSubmit = Boolean(currentPassword && (identityChanged || newPassword));

  return <form className="profile-layout" onSubmit={submit}>
    <section className="profile-card profile-overview">
      <div className="profile-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
      <div><p className="eyebrow">COMPTE PADOCK</p><h2>{user.username}</h2><span className={`role-badge ${user.role === 'admin' ? 'admin' : user.customRole ? 'custom' : 'user'}`}>{user.role === 'admin' ? 'Administrateur' : user.customRole?.name ?? 'Utilisateur'}</span><small>Membre depuis le {new Date(user.createdAt).toLocaleDateString('fr-FR')}</small></div>
    </section>

    {error && <div className="alert profile-feedback" role="alert">{error}</div>}
    {message && <div className="success-banner profile-feedback">{message}</div>}

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Identité</h2><small>Informations visibles dans le panel et les journaux</small></div></div>
      <div className="form-row"><label>Pseudo<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} autoComplete="username" required/><small>Lettres, chiffres, points, tirets et underscores.</small></label><label>Adresse e-mail<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" maxLength={254} autoComplete="email" required/><small>Utilisée pour identifier et administrer votre compte.</small></label></div>
      <div className="profile-actions"><span>{user.emailVerified ? '✓ Adresse e-mail vérifiée' : 'Adresse e-mail non vérifiée'}</span>{!user.emailVerified && <button type="button" className="secondary" onClick={verifyEmail}>Envoyer la vérification</button>}</div>
    </section>

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Sécurité</h2><small>Laissez le nouveau mot de passe vide pour conserver l’actuel</small></div></div>
      <div className="profile-password-grid"><label>Mot de passe actuel<input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="current-password" required/><small>Obligatoire pour confirmer chaque modification.</small></label><label>Nouveau mot de passe<input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="new-password"/><small>10 caractères minimum.</small></label><label>Confirmer le nouveau mot de passe<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="new-password" disabled={!newPassword}/><small>Doit être identique au nouveau mot de passe.</small></label></div>
      <div className="profile-actions"><span>La session actuelle reste connectée après la modification.</span><button className="primary" disabled={busy || !canSubmit}>{busy ? 'Enregistrement…' : 'Enregistrer les modifications'}</button></div>
    </section>

    <section className="content-panel profile-card security-center">
      <div className="content-toolbar"><div><h2>Double authentification</h2><small>{user.twoFactorEnabled ? `Activée · ${user.recoveryCodesRemaining} codes de récupération restants` : 'Protection TOTP compatible avec les applications courantes'}</small></div><span className={`role-badge ${user.twoFactorEnabled ? 'active' : ''}`}>{user.twoFactorEnabled ? 'Activée' : 'Désactivée'}</span></div>
      {!user.twoFactorEnabled && !totpSecret && <button type="button" className="secondary" onClick={setup2fa}>Configurer la 2FA</button>}
      {totpSecret && <div className="security-secret"><p>Clé à saisir dans l’application :</p><code>{totpSecret}</code><label>Code à 6 chiffres<input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} inputMode="numeric" maxLength={6}/></label><button type="button" className="primary" onClick={confirm2fa}>Confirmer l’activation</button></div>}
      {user.twoFactorEnabled && <div className="security-secret"><label>Code TOTP ou de récupération<input value={totpCode} onChange={(event) => setTotpCode(event.target.value)} maxLength={20}/></label><button type="button" className="table-action" onClick={disable2fa}>Désactiver la 2FA</button></div>}
      {recoveryCodes.length > 0 && <div className="recovery-codes"><strong>Codes de récupération — affichés une seule fois</strong>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div>}
    </section>

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Sessions actives</h2><small>Révoquez les appareils que vous ne reconnaissez pas</small></div></div>
      <div className="security-list">{sessions.map((session) => <article key={session.id}><div><strong>{session.current ? 'Session actuelle' : session.ip ?? 'Adresse inconnue'}</strong><small>{session.userAgent ?? 'Appareil inconnu'} · vue {new Date(session.lastSeenAt).toLocaleString('fr-FR')}</small></div>{!session.current && <button type="button" className="table-action" onClick={() => revokeSession(session.id)}>Révoquer</button>}</article>)}</div>
    </section>

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Clés API</h2><small>Accès automatisé avec les mêmes droits que votre compte</small></div><button type="button" className="secondary" onClick={createKey}>Nouvelle clé</button></div>
      {createdApiKey && <div className="security-secret"><strong>Copiez cette clé maintenant, elle ne sera plus affichée.</strong><code>{createdApiKey}</code><button type="button" className="secondary compact" onClick={() => navigator.clipboard.writeText(createdApiKey)}>Copier</button></div>}
      <div className="security-list">{apiKeys.map((key) => <article key={key.id}><div><strong>{key.name}</strong><small><code>{key.prefix}…</code> · créée le {new Date(key.createdAt).toLocaleDateString('fr-FR')}{key.lastUsedAt ? ` · utilisée ${new Date(key.lastUsedAt).toLocaleString('fr-FR')}` : ''}</small></div>{!key.revokedAt && <button type="button" className="table-action" onClick={() => revokeKey(key.id)}>Révoquer</button>}</article>)}</div>
    </section>
  </form>;
}
