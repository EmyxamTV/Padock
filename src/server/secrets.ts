import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { padockEnv } from './config.js';

const sources = [...new Set([padockEnv('ENCRYPTION_KEY'), padockEnv('JWT_SECRET'), process.env.NODE_ENV === 'production' ? undefined : 'padock-development-encryption-key'].filter(Boolean) as string[])];
if (!sources.length) throw new Error('PADOCK_ENCRYPTION_KEY ou PADOCK_JWT_SECRET est obligatoire pour chiffrer les secrets.');
const keys = sources.map((source) => createHash('sha256').update(source).digest());

export function encryptSecret(value: string | undefined) {
  if (!value || value.startsWith('enc:v1:')) return value;
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keys[0]!, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string | undefined) {
  if (!value || !value.startsWith('enc:v1:')) return value;
  const [, version, ivValue, tagValue, payload] = value.split(':'); if (version !== 'v1' || !ivValue || !tagValue || !payload) throw new Error('Secret chiffré invalide.');
  for (const key of keys) {
    try { const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url')); decipher.setAuthTag(Buffer.from(tagValue, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8'); }
    catch { /* Permet une rotation progressive depuis l'ancienne clé JWT. */ }
  }
  throw new Error('Impossible de déchiffrer un secret. Vérifiez PADOCK_ENCRYPTION_KEY et PADOCK_JWT_SECRET.');
}
