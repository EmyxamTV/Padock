import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return { salt, passwordHash: derived.toString('hex') };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
