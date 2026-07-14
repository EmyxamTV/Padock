import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';

export function Auth({ mode, onSuccess }: { mode: 'setup' | 'login'; onSuccess: () => void }) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState('');
  const resetToken = new URLSearchParams(window.location.search).get('reset') ?? '';
  const verifyToken = new URLSearchParams(window.location.search).get('verify') ?? '';
  const [flow, setFlow] = useState<'login' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
  const [message, setMessage] = useState('');

  useEffect(() => { if (!verifyToken) return; api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ token: verifyToken }) }).then(() => { setMessage('Adresse e-mail vérifiée. Vous pouvez vous connecter.'); window.history.replaceState({}, '', window.location.pathname); }).catch((err) => setError((err as Error).message)); }, [verifyToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError('');
    const data = new FormData(event.currentTarget);
    try {
      if (flow === 'forgot') {
        const result = await api<{ message: string }>('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email: data.get('email') }) }); setMessage(result.message); setLoading(false);
      } else if (flow === 'reset') {
        if (data.get('password') !== data.get('confirmation')) throw new Error('La confirmation ne correspond pas.');
        await api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({ token: resetToken, password: data.get('password') }) }); setMessage('Mot de passe modifié. Vous pouvez vous connecter.'); setFlow('login'); window.history.replaceState({}, '', window.location.pathname); setLoading(false);
      } else if (challenge) {
        await api('/api/auth/2fa/login', { method: 'POST', body: JSON.stringify({ challenge, code: data.get('code') }) }); onSuccess();
      } else {
        const result = await api<{ twoFactorRequired?: boolean; challenge?: string }>(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password') }) });
        if (result.twoFactorRequired && result.challenge) { setChallenge(result.challenge); setLoading(false); } else onSuccess();
      }
    } catch (err) { setError((err as Error).message); setLoading(false); }
  }

  return <div className="auth-page">
    <div className="auth-glow" />
    <form className="auth-card" onSubmit={submit}>
      <div className="brand large"><span className="brand-mark">P</span><div><strong>Padock</strong><small>SERVER CONTROL</small></div></div>
      <p className="eyebrow">{flow === 'forgot' ? 'RÉCUPÉRATION' : flow === 'reset' ? 'NOUVEAU MOT DE PASSE' : challenge ? 'DOUBLE AUTHENTIFICATION' : mode === 'setup' ? 'PREMIER DÉMARRAGE' : 'ESPACE ADMINISTRATEUR'}</p>
      <h1>{flow === 'forgot' ? 'Retrouvez votre compte' : flow === 'reset' ? 'Choisissez un mot de passe' : challenge ? 'Confirmez votre connexion' : mode === 'setup' ? 'Configurez votre panel' : 'Content de vous revoir'}</h1>
      <p className="muted">{flow === 'forgot' ? 'Un lien valable 30 minutes sera envoyé si le compte existe.' : flow === 'reset' ? 'Le changement révoquera toutes les sessions existantes.' : challenge ? 'Saisissez le code de votre application ou un code de récupération.' : mode === 'setup' ? 'Créez le compte qui administrera vos serveurs.' : 'Connectez-vous pour gérer votre infrastructure.'}</p>
      {error && <div className="alert">{error}</div>}
      {message && <div className="success-banner">{message}</div>}
      {flow === 'forgot' && <label>Adresse e-mail<input name="email" type="email" required autoComplete="email"/></label>}
      {flow === 'reset' && <><label>Nouveau mot de passe<input name="password" type="password" required minLength={10} autoComplete="new-password"/></label><label>Confirmation<input name="confirmation" type="password" required minLength={10} autoComplete="new-password"/></label></>}
      {flow === 'login' && !challenge && <><label>Nom d’utilisateur<input name="username" required minLength={3} autoComplete="username" placeholder="admin" /></label><label>Mot de passe<input name="password" type="password" required minLength={10} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} placeholder="10 caractères minimum" /></label></>}
      {challenge && <label>Code de sécurité<input name="code" required minLength={6} maxLength={20} autoComplete="one-time-code" inputMode="numeric" autoFocus placeholder="123456" /></label>}
      <button className="primary wide" disabled={loading}>{loading ? 'Traitement…' : flow === 'forgot' ? 'Envoyer le lien' : flow === 'reset' ? 'Changer le mot de passe' : challenge ? 'Vérifier' : mode === 'setup' ? 'Créer le panel' : 'Se connecter'}</button>
      {challenge && <button type="button" className="secondary wide" onClick={() => { setChallenge(''); setError(''); }}>Retour</button>}
      {mode === 'login' && flow === 'login' && !challenge && <button type="button" className="secondary wide" onClick={() => { setFlow('forgot'); setError(''); setMessage(''); }}>Mot de passe oublié</button>}
      {flow === 'forgot' && <button type="button" className="secondary wide" onClick={() => { setFlow('login'); setError(''); }}>Retour à la connexion</button>}
    </form>
  </div>;
}
