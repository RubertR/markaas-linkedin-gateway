import { randomBytes } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { hashToken } from '../register/uitnodiging.ts';

/**
 * Sessies van het klantportaal (SPEC §14.3), in de tabel `portal_sessions`
 * zodat een herstart niemand uitlogt. Het sessietoken staat alleen in de
 * cookie; de database bewaart de SHA-256-hash als id. Elke sessie heeft een
 * eigen CSRF-token. Geldig 12 uur vanaf inloggen.
 *
 * Een sessie werkt alleen zolang de gebruiker én de klant actief zijn; zo
 * sluit deactiveren direct alle open sessies af, ook als het verwijderen
 * ervan zou mislukken.
 */

export const PORTAAL_SESSIE_DUUR_MS = 12 * 60 * 60 * 1000;

export interface NieuwePortaalSessie {
  /** Het ruwe token, alleen voor de cookie. */
  token: string;
  csrfToken: string;
  verlooptOp: Date;
}

export interface PortaalSessie {
  id: string;
  gebruikerId: string;
  clientId: string;
  email: string;
  naam: string;
  klantNaam: string;
  csrfToken: string;
  verlooptOp: Date;
}

export async function maakPortaalSessie(
  db: Backend,
  gebruikerId: string,
  opties: { klok: Klok; duurMs?: number },
): Promise<NieuwePortaalSessie> {
  const nu = opties.klok.nu();
  const verlooptOp = new Date(nu.getTime() + (opties.duurMs ?? PORTAAL_SESSIE_DUUR_MS));
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  await db.query(
    `insert into portal_sessions(id, client_user_id, csrf_token, aangemaakt_op, verloopt_op, laatst_gezien_op)
     values ($1, $2, $3, $4, $5, $4)`,
    [hashToken(token), gebruikerId, csrfToken, nu.toISOString(), verlooptOp.toISOString()],
  );
  return { token, csrfToken, verlooptOp };
}

interface SessieRij {
  id: string;
  client_user_id: string;
  client_id: string;
  email: string;
  naam: string;
  klant_naam: string;
  csrf_token: string;
  verloopt_op: string | Date;
}

export async function vindPortaalSessie(
  db: Backend,
  token: string | null | undefined,
  klok: Klok,
): Promise<PortaalSessie | null> {
  if (!token) return null;
  const nu = klok.nu().toISOString();
  const rijen = await db.query<SessieRij>(
    `update portal_sessions s
     set laatst_gezien_op = $2
     from client_users u
     join clients c on c.id = u.client_id
     where s.id = $1
       and u.id = s.client_user_id
       and s.verloopt_op > $2
       and u.actief
       and c.actief
     returning s.id, s.client_user_id, u.client_id, u.email, u.naam,
               c.naam as klant_naam, s.csrf_token, s.verloopt_op`,
    [hashToken(token), nu],
  );
  const r = rijen[0];
  if (!r) return null;
  return {
    id: r.id,
    gebruikerId: r.client_user_id,
    clientId: r.client_id,
    email: r.email,
    naam: r.naam,
    klantNaam: r.klant_naam,
    csrfToken: r.csrf_token,
    verlooptOp: r.verloopt_op instanceof Date ? r.verloopt_op : new Date(r.verloopt_op),
  };
}

export async function verwijderPortaalSessie(db: Backend, token: string | null | undefined): Promise<void> {
  if (!token) return;
  await db.query('delete from portal_sessions where id = $1', [hashToken(token)]);
}

/** Logt alle sessies van één gebruiker uit (deactiveren, nieuw wachtwoord). */
export async function verwijderSessiesVanGebruiker(db: Backend, gebruikerId: string): Promise<void> {
  await db.query('delete from portal_sessions where client_user_id = $1', [gebruikerId]);
}

/** Opruimen van verlopen sessies; veilig om vaak aan te roepen. */
export async function ruimVerlopenSessiesOp(db: Backend, klok: Klok): Promise<void> {
  await db.query('delete from portal_sessions where verloopt_op <= $1', [klok.nu().toISOString()]);
}
