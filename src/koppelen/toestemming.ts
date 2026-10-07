import { createHmac } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import type { Abonnement } from '../register/accounts.ts';
import { claimUitnodiging } from '../register/uitnodiging.ts';

/**
 * Gegevens en opslag achter de koppelpagina (SPEC §14.2 punt 3–4).
 */

export interface KoppelContext {
  accountId: string;
  eigenaarNaam: string;
  eigenaarEmail: string | null;
  klantNaam: string;
  abonnement: Abonnement;
}

export async function haalKoppelContext(
  db: Backend,
  accountId: string,
): Promise<KoppelContext | null> {
  const rijen = await db.query<{
    id: string;
    eigenaar_naam: string;
    eigenaar_email: string | null;
    klant_naam: string;
    abonnement: Abonnement;
  }>(
    `select a.id, a.eigenaar_naam, a.eigenaar_email, c.naam as klant_naam, a.abonnement
     from accounts a join clients c on c.id = a.client_id
     where a.id = $1`,
    [accountId],
  );
  const r = rijen[0];
  if (!r) return null;
  return {
    accountId: r.id,
    eigenaarNaam: r.eigenaar_naam,
    eigenaarEmail: r.eigenaar_email,
    klantNaam: r.klant_naam,
    abonnement: r.abonnement,
  };
}

export const USER_AGENT_MAX = 400;

/** HMAC-SHA256 van het IP met een geheime sleutel ("SHA-256 met geheim zout"). */
export function hashIp(ipSleutel: string, ip: string): string {
  return createHmac('sha256', ipSleutel).update(ip).digest('hex');
}

export interface ToestemmingInvoer {
  uitnodigingId: string;
  accountId: string;
  naam: string;
  email: string;
  versieVoorwaarden: string;
  versieVerwerkersovereenkomst: string;
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * Claimt de uitnodiging en legt de toestemming vast, in één transactie.
 * Geeft `false` (en slaat niets op) als de uitnodiging intussen gebruikt of
 * verlopen is. Lukt de Unipile-link daarna niet, dan geeft de aanroeper de
 * uitnodiging vrij; de toestemming blijft staan.
 */
export async function legToestemmingVast(
  db: Backend,
  invoer: ToestemmingInvoer,
  klok: Klok,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await claimUitnodiging(tx, invoer.uitnodigingId, klok))) return false;
    // Momentopname van klant en account (migratie 0007): het bewijs blijft leesbaar
    // als het account later verdwijnt of hernoemd wordt.
    const vastgelegd = await tx.query<{ id: string }>(
      `insert into account_consents(account_id, uitnodiging_id, naam, email,
         versie_voorwaarden, versie_verwerkersovereenkomst, ip_hash, user_agent, gegeven_op,
         client_id, klantnaam, account_eigenaar_naam, unipile_account_id)
       select $1, $2, $3, $4, $5, $6, $7, $8, $9,
              a.client_id, c.naam, a.eigenaar_naam, a.unipile_account_id
       from accounts a join clients c on c.id = a.client_id
       where a.id = $1
       returning id`,
      [
        invoer.accountId,
        invoer.uitnodigingId,
        invoer.naam,
        invoer.email,
        invoer.versieVoorwaarden,
        invoer.versieVerwerkersovereenkomst,
        invoer.ipHash,
        invoer.userAgent === null ? null : invoer.userAgent.slice(0, USER_AGENT_MAX),
        klok.nu().toISOString(),
      ],
    );
    if (vastgelegd.length === 0) throw new Error(`Account ${invoer.accountId} bestaat niet; toestemming niet vastgelegd.`);
    return true;
  });
}
