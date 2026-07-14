import { FormEvent, useState } from 'react';
import { api } from '../api';

export function Auth({ mode, onSuccess }: { mode: 'setup' | 'login'; onSuccess: () => void }) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password') }) });
      onSuccess();
    } catch (err) { setError((err as Error).message); setLoading(false); }
  }

  return <div className="auth-page">
    <div className="auth-glow" />
    <form className="auth-card" onSubmit={submit}>
      <div className="brand large"><span className="brand-mark">P</span><div><strong>Padock</strong><small>SERVER CONTROL</small></div></div>
      <p className="eyebrow">{mode === 'setup' ? 'PREMIER DÉMARRAGE' : 'ESPACE ADMINISTRATEUR'}</p>
      <h1>{mode === 'setup' ? 'Configurez votre panel' : 'Content de vous revoir'}</h1>
      <p className="muted">{mode === 'setup' ? 'Créez le compte qui administrera vos serveurs.' : 'Connectez-vous pour gérer votre infrastructure.'}</p>
      {error && <div className="alert">{error}</div>}
      <label>Nom d’utilisateur<input name="username" required minLength={3} autoComplete="username" placeholder="admin" /></label>
      <label>Mot de passe<input name="password" type="password" required minLength={10} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} placeholder="10 caractères minimum" /></label>
      <button className="primary wide" disabled={loading}>{loading ? 'Connexion…' : mode === 'setup' ? 'Créer le panel' : 'Se connecter'}</button>
    </form>
  </div>;
}
