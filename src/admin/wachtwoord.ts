import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Wachtwoord-hash voor de goedkeuringspagina (SPEC §12). Alleen Rubert kent
 * het wachtwoord; de hash komt uit `ADMIN_PASSWORD_HASH`. Scrypt uit de
 * standaard-library — geen extra afhankelijkheid, voldoende voor één
 * gebruiker en lage pogingfrequentie (zie `pogingen.ts`).
 *
 * Formaat: `scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>`.
 */

const scryptAsync = promisify(scrypt) as (
  wachtwoord: string | Buffer,
  salt: Buffer,
  keyLen: number,
  opties: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const STANDAARD = {
  N: 16384, // 2^14
  r: 8,
  p: 1,
  keyLen: 64,
  saltLen: 16,
  maxmem: 128 * 1024 * 1024, // 128 MB, ruim voldoende voor N=16384
};

export async function maakWachtwoordHash(wachtwoord: string): Promise<string> {
  if (typeof wachtwoord !== 'string' || wachtwoord.length < 8) {
    throw new Error('Wachtwoord moet minstens 8 tekens zijn.');
  }
  const salt = randomBytes(STANDAARD.saltLen);
  const key = await scryptAsync(wachtwoord, salt, STANDAARD.keyLen, {
    N: STANDAARD.N,
    r: STANDAARD.r,
    p: STANDAARD.p,
    maxmem: STANDAARD.maxmem,
  });
  return [
    'scrypt',
    STANDAARD.N,
    STANDAARD.r,
    STANDAARD.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifieerWachtwoord(hash: string, wachtwoord: string): Promise<boolean> {
  if (typeof hash !== 'string' || typeof wachtwoord !== 'string') return false;
  const delen = hash.split('$');
  if (delen.length !== 6 || delen[0] !== 'scrypt') return false;
  const N = Number(delen[1]);
  const r = Number(delen[2]);
  const p = Number(delen[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let verwacht: Buffer;
  try {
    salt = Buffer.from(delen[4]!, 'base64');
    verwacht = Buffer.from(delen[5]!, 'base64');
  } catch {
    return false;
  }
  if (verwacht.length === 0) return false;
  const berekend = await scryptAsync(wachtwoord, salt, verwacht.length, {
    N,
    r,
    p,
    maxmem: STANDAARD.maxmem,
  });
  if (berekend.length !== verwacht.length) return false;
  return timingSafeEqual(berekend, verwacht);
}
