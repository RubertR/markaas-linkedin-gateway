import type { Backend } from '../db/backend.ts';

import { registreerAccount, vindAccount, type Abonnement } from './accounts.ts';
import { maakClient, vindClientBijSlug } from './clients.ts';
import { ABONNEMENTEN } from './registreer.ts';
import { maakUitnodiging, type NieuweUitnodiging, type UitnodigingOpties } from './uitnodiging.ts';

/**
 * Onboarding van een nieuwe klant (SPEC §14.2 punt 1): client + account
 * (status CONNECTING, opbouw 0.5, nog geen unipile_account_id) + koppeluitnodiging,
 * in één transactie.
 */

const TIJDZONE = 'Europe/Amsterdam';
const SLUG_PATROON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATROON = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class NieuweKlantFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'NieuweKlantFout';
  }
}

export interface NieuweKlantInvoer {
  klantNaam: string;
  slug: string;
  eigenaarNaam: string;
  eigenaarEmail: string;
  abonnement: Abonnement;
  abonnementVereist: boolean;
}

export interface NieuweKlantUitkomst {
  clientId: string;
  accountId: string;
  uitnodiging: NieuweUitnodiging;
}

/** `null` als de slug goed is, anders een NL-melding. */
export function valideerSlug(slug: string): string | null {
  if (!slug) return 'Vul een slug in (alleen kleine letters, cijfers en koppeltekens).';
  if (slug.length > 60) return 'De slug is te lang (maximaal 60 tekens).';
  if (!SLUG_PATROON.test(slug)) {
    return `Slug "${slug}" is ongeldig: gebruik alleen kleine letters a-z, cijfers en koppeltekens, niet aan het begin of eind.`;
  }
  return null;
}

/** `null` als het adres er geldig uitziet, anders een NL-melding. */
export function valideerEmail(email: string): string | null {
  if (!email || email.length > 254 || !EMAIL_PATROON.test(email)) {
    return 'Vul een geldig e-mailadres in (bijvoorbeeld naam@bedrijf.nl).';
  }
  return null;
}

function controleer(invoer: NieuweKlantInvoer): NieuweKlantInvoer {
  const schoon: NieuweKlantInvoer = {
    klantNaam: invoer.klantNaam.trim(),
    slug: invoer.slug.trim(),
    eigenaarNaam: invoer.eigenaarNaam.trim(),
    eigenaarEmail: invoer.eigenaarEmail.trim(),
    abonnement: invoer.abonnement,
    abonnementVereist: invoer.abonnementVereist,
  };
  const meldingen: string[] = [];
  if (!schoon.klantNaam) meldingen.push('Vul een klantnaam in.');
  if (schoon.klantNaam.length > 200) meldingen.push('De klantnaam is te lang (maximaal 200 tekens).');
  const slugFout = valideerSlug(schoon.slug);
  if (slugFout) meldingen.push(slugFout);
  if (!schoon.eigenaarNaam) meldingen.push('Vul de naam van de accounteigenaar in.');
  if (schoon.eigenaarNaam.length > 200) meldingen.push('De naam van de accounteigenaar is te lang.');
  const emailFout = valideerEmail(schoon.eigenaarEmail);
  if (emailFout) meldingen.push(emailFout);
  if (!ABONNEMENTEN.includes(schoon.abonnement)) {
    meldingen.push(`Onbekend LinkedIn-abonnement "${String(schoon.abonnement)}". Kies uit: ${ABONNEMENTEN.join(', ')}.`);
  }
  if (meldingen.length > 0) throw new NieuweKlantFout(meldingen.join(' '));
  return schoon;
}

export async function maakNieuweKlant(
  db: Backend,
  invoer: NieuweKlantInvoer,
  opties: UitnodigingOpties,
): Promise<NieuweKlantUitkomst> {
  const schoon = controleer(invoer);
  return await db.transaction(async (tx) => {
    if (await vindClientBijSlug(tx, schoon.slug)) throw dubbeleSlug(schoon.slug);
    let clientId: string;
    try {
      const client = await maakClient(tx, {
        naam: schoon.klantNaam,
        slug: schoon.slug,
        abonnementVereist: schoon.abonnementVereist,
      });
      clientId = client.id;
    } catch (err) {
      // Gelijktijdige aanmaak met dezelfde slug: unieke index vangt het af.
      if (/bestaat al/.test((err as Error).message)) throw dubbeleSlug(schoon.slug);
      throw err;
    }
    // Status CONNECTING en opbouw_factor 0.50 zijn de schemastandaarden.
    const account = await registreerAccount(tx, {
      clientId,
      eigenaarNaam: schoon.eigenaarNaam,
      eigenaarEmail: schoon.eigenaarEmail,
      abonnement: schoon.abonnement,
      tijdzone: TIJDZONE,
    });
    const uitnodiging = await maakUitnodiging(tx, account.id, opties);
    return { clientId, accountId: account.id, uitnodiging };
  });
}

/**
 * Nieuwe koppeluitnodiging voor een bestaand, nog niet gekoppeld account
 * (bijv. omdat de vorige verlopen is). De vorige open uitnodiging vervalt.
 */
export async function maakNieuweKoppeluitnodiging(
  db: Backend,
  accountId: string,
  opties: UitnodigingOpties,
): Promise<NieuweUitnodiging> {
  return await db.transaction(async (tx) => {
    const account = await vindAccount(tx, accountId);
    if (!account) {
      throw new NieuweKlantFout(`Onbekend account (${accountId}); er is geen koppellink gemaakt.`);
    }
    if (account.unipileAccountId) {
      throw new NieuweKlantFout(
        `Het account van ${account.eigenaarNaam} is al gekoppeld; een nieuwe koppellink is niet nodig. ` +
          'Moet de sessie opnieuw, gebruik dan een reconnect-link.',
      );
    }
    return await maakUitnodiging(tx, account.id, opties);
  });
}

function dubbeleSlug(slug: string): NieuweKlantFout {
  return new NieuweKlantFout(
    `De slug "${slug}" is al in gebruik door een andere klant. Kies een andere slug; er is niets aangemaakt.`,
  );
}
