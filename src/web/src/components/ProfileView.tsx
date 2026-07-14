import { FormEvent, useEffect, useState } from 'react';
import { api, type UserRecord } from '../api';

export function ProfileView({ user, onChanged }: { user: UserRecord; onChanged: (user: UserRecord) => void }) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => { setUsername(user.username); setEmail(user.email); }, [user.id, user.username, user.email]);

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
      <div><p className="eyebrow">COMPTE PADOCK</p><h2>{user.username}</h2><span className={`role-badge ${user.role}`}>{user.role === 'admin' ? 'Administrateur' : 'Utilisateur'}</span><small>Membre depuis le {new Date(user.createdAt).toLocaleDateString('fr-FR')}</small></div>
    </section>

    {error && <div className="alert profile-feedback" role="alert">{error}</div>}
    {message && <div className="success-banner profile-feedback">{message}</div>}

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Identité</h2><small>Informations visibles dans le panel et les journaux</small></div></div>
      <div className="form-row"><label>Pseudo<input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={32} autoComplete="username" required/><small>Lettres, chiffres, points, tirets et underscores.</small></label><label>Adresse e-mail<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" maxLength={254} autoComplete="email" required/><small>Utilisée pour identifier et administrer votre compte.</small></label></div>
    </section>

    <section className="content-panel profile-card">
      <div className="content-toolbar"><div><h2>Sécurité</h2><small>Laissez le nouveau mot de passe vide pour conserver l’actuel</small></div></div>
      <div className="profile-password-grid"><label>Mot de passe actuel<input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="current-password" required/><small>Obligatoire pour confirmer chaque modification.</small></label><label>Nouveau mot de passe<input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="new-password"/><small>10 caractères minimum.</small></label><label>Confirmer le nouveau mot de passe<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type="password" minLength={10} maxLength={200} autoComplete="new-password" disabled={!newPassword}/><small>Doit être identique au nouveau mot de passe.</small></label></div>
      <div className="profile-actions"><span>La session actuelle reste connectée après la modification.</span><button className="primary" disabled={busy || !canSubmit}>{busy ? 'Enregistrement…' : 'Enregistrer les modifications'}</button></div>
    </section>
  </form>;
}
