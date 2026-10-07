import { createHash, randomBytes } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';

/**
 * Koppeluitnodigingen van de gateway (SPEC §14.2 punt 2). Het token gaat één
 * keer naar Rubert (voor de mail aan de accounteigenaar); in de database staat
 * alleen de SHA-256-hash. Eenmalig en standaard 7 dagen geldig.
 *
 * Gebruik in de koppelflow:
 * 1. `vindGeldigeUitnodiging` bij het tonen van de pagina;
 * 2. `claimUitnodiging` (atomair, in de transactie die de toestemming opslaat);
 * 3. lukt de Unipile-link niet → `geefUitnodigingVrij`, zodat de eigenaar het
 *    opnieuw kan proberen.
 */

const DAG_MS = 24 * 60 * 60 * 1000;

export interface NieuweUitnodiging {
  id: string;
  accountId: string;
  /** Het ruwe token. Alleen nu beschikbaar; daarna nooit meer op te vragen. */
  token: string;
  verlooptOp: Date;
}

export interface GeldigeUitnodiging {
  id: string;
  accountId: string;
  verlooptOp: Date;
}

export interface UitnodigingOpties {
  klok: Klok;
  geldigDagen: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Maakt een nieuwe uitnodiging. Eerdere, nog open uitnodigingen van hetzelfde
 * account vervallen meteen: er is steeds hooguit één werkende link.
 */
export async function maakUitnodiging(
  db: Backend,
  accountId: string,
  opties: UitnodigingOpties,
): Promise<NieuweUitnodiging> {
  const nu = opties.klok.nu();
  const verlooptOp = new Date(nu.getTime() + opties.geldigDagen * DAG_MS);
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `update koppel_uitnodigingen
     set verloopt_op = $2
     where account_id = $1 and gebruikt_op is null and verloopt_op > $2`,
    [accountId, nu.toISOString()],
  );
  const rijen = await db.query<{ id: string }>(
    `insert into koppel_uitnodigingen(account_id, token_hash, aangemaakt_op, verloopt_op)
     values ($1, $2, $3, $4)
     returning id`,
    [accountId, hashToken(token), nu.toISOString(), verlooptOp.toISOString()],
  );
  const rij = rijen[0];
  if (!rij) throw new Error('Koppeluitnodiging aanmaken gaf geen rij terug.');
  return { id: rij.id, accountId, token, verlooptOp };
}

/**
 * Zoekt een bruikbare uitnodiging: bestaat, niet verlopen, niet gebruikt en
 * het account is nog niet gekoppeld. Geeft `null` zonder te zeggen waarom,
 * zodat de publieke pagina niets verraadt.
 */
export async function vindGeldigeUitnodiging(
  db: Backend,
  token: string,
  klok: Klok,
): Promise<GeldigeUitnodiging | null> {
  if (!token) return null;
  const rijen = await db.query<{ id: string; account_id: string; verloopt_op: string | Date }>(
    `select u.id, u.account_id, u.verloopt_op
     from koppel_uitnodigingen u
     join accounts a on a.id = u.account_id
     where u.token_hash = $1
       and u.gebruikt_op is null
       and u.verloopt_op > $2
       and a.unipile_account_id is null`,
    [hashToken(token), klok.nu().toISOString()],
  );
  const rij = rijen[0];
  if (!rij) return null;
  return {
    id: rij.id,
    accountId: rij.account_id,
    verlooptOp: rij.verloopt_op instanceof Date ? rij.verloopt_op : new Date(rij.verloopt_op),
  };
}

/**
 * Markeert de uitnodiging als gebruikt, alleen als ze nog open en geldig is.
 * Atomair: van twee gelijktijdige pogingen krijgt er één `true`.
 */
export async function claimUitnodiging(db: Backend, id: string, klok: Klok): Promise<boolean> {
  const nu = klok.nu().toISOString();
  const rijen = await db.query<{ id: string }>(
    `update koppel_uitnodigingen
     set gebruikt_op = $2
     where id = $1 and gebruikt_op is null and verloopt_op > $2
     returning id`,
    [id, nu],
  );
  return rijen.length === 1;
}

/** Maakt een claim ongedaan (Unipile-link mislukt), zodat de link weer werkt. */
export async function geefUitnodigingVrij(db: Backend, id: string): Promise<void> {
  await db.query('update koppel_uitnodigingen set gebruikt_op = null where id = $1', [id]);
}
