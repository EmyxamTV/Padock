import nodemailer from 'nodemailer';
import { padockEnv } from './config.js';

const host = padockEnv('SMTP_HOST')?.trim();
const port = Number(padockEnv('SMTP_PORT') || 587);
const user = padockEnv('SMTP_USER')?.trim();
const pass = padockEnv('SMTP_PASSWORD');
const from = padockEnv('SMTP_FROM')?.trim() || 'Padock <no-reply@padock.local>';
const transporter = host ? nodemailer.createTransport({ host, port, secure: padockEnv('SMTP_SECURE') === 'true', auth: user && pass ? { user, pass } : undefined }) : undefined;

export function mailConfigured() { return Boolean(transporter); }

export async function sendAccountMail(to: string, subject: string, text: string) {
  if (!transporter) throw Object.assign(new Error('Le serveur SMTP n’est pas configuré.'), { statusCode: 409 });
  await transporter.sendMail({ from, to, subject, text });
}
