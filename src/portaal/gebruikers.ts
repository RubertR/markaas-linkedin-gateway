import { randomBytes } from 'node:crypto';

import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { valideerEmail } from '../register/nieuweklant.ts';
import { hashToken, type UitnodigingOpties } from '../register/uitnodiging.ts';

import { verwijderSessiesVanGebruiker } from './sessies.ts';

/**
 * Klantgebruikers van het portaal (SPEC §14.3) en hun uitnodigingslinks.
 *
 * Zelfde tokenregels als de koppeluitnodiging (§14.2): 32 willekeurige bytes,
 * in de database alleen de SHA-256-hash, eenmalig, standaard 7 dagen geldig.
 * Er is per gebruiker steeds hooguit één open link. Dezelfde links dienen voor
 * "wachtwoord vergeten": Rubert maakt dan een nieuwe link.
 *
 * Beheeracties (nieuwe link, deactiveren) nemen altijd de client_id mee, zodat
 * een gebruiker-id van een andere klant niets kan wijzigen.
 */

const DAG_MS = 24 * 60 * 60 * 1000;
export const MINIMALE_WACHTWOORDLENGTE = 12;
const NAAM_MAX = 200;

export class PortaalGebruikerFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'PortaalGebruikerFout';
  }
}

export type GebruikerUitnodigingStand = 'geen' | 'open' | 'verlopen' | 'gebruikt';

export interface PortaalGebruiker {
  id: string;
  clientId: string;
  email: string;
  naam: string;
  actief: boolean;
  heeftWachtwoord: boolean;
  aangemaaktOp: Date;
  laatstIngelogdOp: Date | null;
}

export interface GebruikerRegel extends PortaalGebruiker {
  uitnodiging: GebruikerUitnodigingStand;
  uitnodigingVerlooptOp: Date | null;
}

export interface NieuweGebruikerLink {
  /** Het ruwe token; alleen nu beschikbaar. */
  token: string;
  verlooptOp: Date;
}

interface GebruikerRij {
  id: string;
  client_id: string;
  email: string;
  naam: string;
  actief: boolean;
  wachtwoord_hash: string | null;
  aangemaakt_op: string | Date;
  laatst_ingelogd_op: string | Date | null;
}

const KOLOMMEN = 'id, client_id, email, naam, actief, wachtwoord_hash, aangemaakt_op, laatst_ingelogd_op';

function alsDatum(w: string | Date): Date {
  return w instanceof Date ? w : new Date(w);
}

function map(r: GebruikerRij): PortaalGebruiker {
  return {
    id: r.id,
    clientId: r.client_id,
    email: r.email,
    naam: r.naam,
    actief: r.actief,
    heeftWachtwoord: r.wachtwoord_hash !== null,
    aangemaaktOp: alsDatum(r.aangemaakt_op),
    laatstIngelogdOp: r.laatst_ingelogd_op === null ? null : alsDatum(r.laatst_ingelogd_op),
  };
}

export function normaliseerEmail(email: string): string {
  return email.trim().toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(waarde: string): boolean {
  return UUID.test(waarde);
}

/** `null` als het wachtwoord bruikbaar is, anders een NL-melding. */
export function valideerNieuwWachtwoord(wachtwoord: string, herhaling: string): string | null {
  if (wachtwoord.length < MINIMALE_WACHTWOORDLENGTE) {
    return `Kies een wachtwoord van minimaal ${MINIMALE_WACHTWOORDLENGTE} tekens.`;
  }
  if (wachtwoord.length > 1024) return 'Het wachtwoord is te lang (maximaal 1024 tekens).';
  if (wachtwoord !== herhaling) {
    return 'De twee wachtwoorden zijn niet gelijk. Vul twee keer hetzelfde wachtwoord in.';
  }
  return null;
}

/**
 * Nieuwe klantgebruiker + eerste uitnodigingslink, in één transactie.
 */
export async function nodigGebruikerUit(
  db: Backend,
  invoer: { clientId: string; naam: string; email: string },
  opties: UitnodigingOpties,
): Promise<{ gebruiker: PortaalGebruiker; uitnodiging: NieuweGebruikerLink }> {
  const naam = invoer.naam.trim();
  const email = normaliseerEmail(invoer.email);
  const meldingen: string[] = [];
  if (!naam) meldingen.push('Vul de naam van de gebruiker in.');
  if (naam.length > NAAM_MAX) meldingen.push('De naam is te lang (maximaal 200 tekens).');
  const emailFout = valideerEmail(email);
  if (emailFout) meldingen.push(emailFout);
  if (meldingen.length > 0) throw new PortaalGebruikerFout(meldingen.join(' '));

  return await db.transaction(async (tx) => {
    const bestaand = await tx.query<{ client_id: string }>(
      'select client_id from client_users where email = $1',
      [email],
    );
    if (bestaand[0]) throw dubbelAdres(email, bestaand[0].client_id === invoer.clientId);
    let rij: GebruikerRij | undefined;
    try {
      [rij] = await tx.query<GebruikerRij>(
        `insert into client_users(client_id, email, naam, aangemaakt_op)
         values ($1, $2, $3, $4)
         returning ${KOLOMMEN}`,
        [invoer.clientId, email, naam, opties.klok.nu().toISOString()],
      );
    } catch (err) {
      if (/duplicate|unique/i.test((err as Error).message)) throw dubbelAdres(email, false);
      throw err;
    }
    if (!rij) throw new Error('Klantgebruiker aanmaken gaf geen rij terug.');
    const uitnodiging = await maakLink(tx, rij.id, opties);
    return { gebruiker: map(rij), uitnodiging };
  });
}

function dubbelAdres(email: string, zelfdeKlant: boolean): PortaalGebruikerFout {
  return new PortaalGebruikerFout(
    zelfdeKlant
      ? `Er bestaat al een gebruiker met ${email} bij deze klant. Gebruik "Nieuwe link" bij die gebruiker; er is niets aangemaakt.`
      : `Het e-mailadres ${email} is al in gebruik bij een andere klant. Een e-mailadres kan maar bij één klant horen; er is niets aangemaakt.`,
  );
}

async function maakLink(
  db: Backend,
  gebruikerId: string,
  opties: UitnodigingOpties,
): Promise<NieuweGebruikerLink> {
  const nu = opties.klok.nu();
  const verlooptOp = new Date(nu.getTime() + opties.geldigDagen * DAG_MS);
  const token = randomBytes(32).toString('base64url');
  // Vorige open link vervalt: steeds hooguit één werkende link.
  await db.query(
    `update client_user_uitnodigingen set verloopt_op = $2
     where client_user_id = $1 and gebruikt_op is null and verloopt_op > $2`,
    [gebruikerId, nu.toISOString()],
  );
  await db.query(
    `insert into client_user_uitnodigingen(client_user_id, token_hash, aangemaakt_op, verloopt_op)
     values ($1, $2, $3, $4)`,
    [gebruikerId, hashToken(token), nu.toISOString(), verlooptOp.toISOString()],
  );
  return { token, verlooptOp };
}

async function vindGebruikerVanKlant(
  db: Backend,
  clientId: string,
  gebruikerId: string,
): Promise<PortaalGebruiker> {
  if (!isUuid(gebruikerId)) throw onbekendeGebruiker();
  const rijen = await db.query<GebruikerRij>(
    `select ${KOLOMMEN} from client_users where id = $1 and client_id = $2`,
    [gebruikerId, clientId],
  );
  if (!rijen[0]) throw onbekendeGebruiker();
  return map(rijen[0]);
}

function onbekendeGebruiker(): PortaalGebruikerFout {
  return new PortaalGebruikerFout('Onbekende gebruiker bij deze klant; er is niets gewijzigd.');
}

/**
 * Nieuwe uitnodigingslink (ook voor "wachtwoord vergeten"). Was de gebruiker
 * gedeactiveerd, dan wordt hij weer actief, maar zonder het oude wachtwoord:
 * inloggen kan pas na het kiezen van een nieuw wachtwoord via de link.
 */
export async function maakNieuweGebruikerLink(
  db: Backend,
  clientId: string,
  gebruikerId: string,
  opties: UitnodigingOpties,
): Promise<NieuweGebruikerLink & { gebruiker: PortaalGebruiker }> {
  return await db.transaction(async (tx) => {
    const gebruiker = await vindGebruikerVanKlant(tx, clientId, gebruikerId);
    if (!gebruiker.actief) {
      await tx.query(
        'update client_users set actief = true, wachtwoord_hash = null where id = $1',
        [gebruikerId],
      );
    }
    const link = await maakLink(tx, gebruikerId, opties);
    return { ...link, gebruiker: { ...gebruiker, actief: true } };
  });
}

/** Deactiveert een gebruiker: alle sessies uit, open links ongeldig. */
export async function deactiveerGebruiker(
  db: Backend,
  clientId: string,
  gebruikerId: string,
  klok: Klok,
): Promise<PortaalGebruiker> {
  return await db.transaction(async (tx) => {
    const gebruiker = await vindGebruikerVanKlant(tx, clientId, gebruikerId);
    const nu = klok.nu().toISOString();
    await tx.query('update client_users set actief = false where id = $1', [gebruikerId]);
    await tx.query(
      `update client_user_uitnodigingen set verloopt_op = $2
       where client_user_id = $1 and gebruikt_op is null and verloopt_op > $2`,
      [gebruikerId, nu],
    );
    await verwijderSessiesVanGebruiker(tx, gebruikerId);
    return { ...gebruiker, actief: false };
  });
}

export async function lijstGebruikers(
  db: Backend,
  clientId: string,
  klok: Klok,
): Promise<GebruikerRegel[]> {
  const rijen = await db.query<GebruikerRij & {
    verloopt_op: string | Date | null;
    gebruikt_op: string | Date | null;
  }>(
    `select ${KOLOMMEN.split(', ').map((k) => `g.${k}`).join(', ')}, u.verloopt_op, u.gebruikt_op
     from client_users g
     left join lateral (
       select verloopt_op, gebruikt_op from client_user_uitnodigingen
       where client_user_id = g.id
       order by aangemaakt_op desc, id desc
       limit 1
     ) u on true
     where g.client_id = $1
     order by lower(g.naam), g.email`,
    [clientId],
  );
  const nu = klok.nu().getTime();
  return rijen.map((r) => {
    const verloopt = r.verloopt_op === null ? null : alsDatum(r.verloopt_op);
    let stand: GebruikerUitnodigingStand = 'geen';
    if (verloopt) {
      stand = r.gebruikt_op !== null ? 'gebruikt' : verloopt.getTime() > nu ? 'open' : 'verlopen';
    }
    return { ...map(r), uitnodiging: stand, uitnodigingVerlooptOp: verloopt };
  });
}

export interface GeldigeGebruikerUitnodiging {
  id: string;
  gebruikerId: string;
  naam: string;
  email: string;
  klantNaam: string;
}

/**
 * Bruikbare uitnodiging: bestaat, open, niet verlopen, gebruiker en klant
 * actief. Geeft `null` zonder reden, zodat de publieke pagina niets verraadt.
 */
export async function vindGeldigeGebruikerUitnodiging(
  db: Backend,
  token: string,
  klok: Klok,
): Promise<GeldigeGebruikerUitnodiging | null> {
  if (!token) return null;
  const rijen = await db.query<{
    id: string;
    client_user_id: string;
    naam: string;
    email: string;
    klant_naam: string;
  }>(
    `select i.id, i.client_user_id, g.naam, g.email, c.naam as klant_naam
     from client_user_uitnodigingen i
     join client_users g on g.id = i.client_user_id
     join clients c on c.id = g.client_id
     where i.token_hash = $1
       and i.gebruikt_op is null
       and i.verloopt_op > $2
       and g.actief and c.actief`,
    [hashToken(token), klok.nu().toISOString()],
  );
  const r = rijen[0];
  if (!r) return null;
  return {
    id: r.id,
    gebruikerId: r.client_user_id,
    naam: r.naam,
    email: r.email,
    klantNaam: r.klant_naam,
  };
}

/**
 * Gebruikt de uitnodiging (atomair: van twee gelijktijdige pogingen lukt er
 * één), zet het wachtwoord en logt eventuele oude sessies uit. `null` als de
 * link niet (meer) geldig is.
 */
export async function gebruikUitnodiging(
  db: Backend,
  token: string,
  wachtwoordHash: string,
  klok: Klok,
): Promise<PortaalGebruiker | null> {
  if (!token) return null;
  const nu = klok.nu().toISOString();
  return await db.transaction(async (tx) => {
    const geclaimd = await tx.query<{ client_user_id: string }>(
      `update client_user_uitnodigingen i
       set gebruikt_op = $2
       from client_users g
       join clients c on c.id = g.client_id
       where i.token_hash = $1
         and g.id = i.client_user_id
         and i.gebruikt_op is null
         and i.verloopt_op > $2
         and g.actief and c.actief
       returning i.client_user_id`,
      [hashToken(token), nu],
    );
    const gebruikerId = geclaimd[0]?.client_user_id;
    if (!gebruikerId) return null;
    const [rij] = await tx.query<GebruikerRij>(
      `update client_users set wachtwoord_hash = $2 where id = $1 returning ${KOLOMMEN}`,
      [gebruikerId, wachtwoordHash],
    );
    await verwijderSessiesVanGebruiker(tx, gebruikerId);
    return rij ? map(rij) : null;
  });
}

/** Voor de login: gebruiker + hash, of `null` als het adres onbekend is. */
export async function vindGebruikerVoorLogin(
  db: Backend,
  email: string,
): Promise<{ gebruiker: PortaalGebruiker; wachtwoordHash: string | null; klantActief: boolean } | null> {
  const rijen = await db.query<GebruikerRij & { klant_actief: boolean }>(
    `select ${KOLOMMEN.split(', ').map((k) => `g.${k}`).join(', ')}, c.actief as klant_actief
     from client_users g join clients c on c.id = g.client_id
     where g.email = $1`,
    [normaliseerEmail(email)],
  );
  const r = rijen[0];
  if (!r) return null;
  return { gebruiker: map(r), wachtwoordHash: r.wachtwoord_hash, klantActief: r.klant_actief };
}

export async function registreerLogin(db: Backend, gebruikerId: string, klok: Klok): Promise<void> {
  await db.query('update client_users set laatst_ingelogd_op = $2 where id = $1', [
    gebruikerId,
    klok.nu().toISOString(),
  ]);
}
