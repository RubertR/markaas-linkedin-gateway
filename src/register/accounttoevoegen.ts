import type { Backend } from '../db/backend.ts';

import { registreerAccount, type Abonnement } from './accounts.ts';
import { vindClientBijSlug } from './clients.ts';
import { NieuweKlantFout, controleerEigenaarVelden } from './nieuweklant.ts';
import { maakUitnodiging, type NieuweUitnodiging, type UitnodigingOpties } from './uitnodiging.ts';

/**
 * Account toevoegen aan een bestaande klant (SPEC §14.2a): account (status
 * CONNECTING, opbouw 0.5, nog geen unipile_account_id) + koppeluitnodiging, in
 * één transactie. Zelfde regels als het eerste account (§14.2): de eigenaar
 * geeft toestemming via de koppelpagina. Het Stripe-aantal verandert pas na
 * een geslaagde koppeling.
 */

export interface AccountToevoegenInvoer {
  slug: string;
  eigenaarNaam: string;
  eigenaarEmail: string;
  abonnement: Abonnement;
  /** IANA-naam; leeg = Europe/Amsterdam. */
  tijdzone: string;
}

export interface AccountToevoegenUitkomst {
  clientId: string;
  accountId: string;
  uitnodiging: NieuweUitnodiging;
}

export async function voegAccountToe(
  db: Backend,
  invoer: AccountToevoegenInvoer,
  opties: UitnodigingOpties,
): Promise<AccountToevoegenUitkomst> {
  const meldingen: string[] = [];
  const schoon = controleerEigenaarVelden(invoer, meldingen);
  if (meldingen.length > 0) throw new NieuweKlantFout(meldingen.join(' '));
  const slug = invoer.slug.trim();

  return await db.transaction(async (tx) => {
    const klant = await vindClientBijSlug(tx, slug);
    if (!klant) {
      throw new NieuweKlantFout(`Onbekende klant "${slug}"; er is geen account toegevoegd.`);
    }
    // Rij-slot op de klant: twee gelijktijdige toevoegingen met hetzelfde
    // adres lopen na elkaar, zodat de dubbelcontrole hieronder sluit.
    await tx.query('select id from clients where id = $1 for update', [klant.id]);
    const dubbel = await tx.query<{ eigenaar_naam: string; eigenaar_email: string }>(
      `select eigenaar_naam, eigenaar_email from accounts
       where client_id = $1 and lower(eigenaar_email) = lower($2)
       limit 1`,
      [klant.id, schoon.eigenaarEmail],
    );
    const bestaand = dubbel[0];
    if (bestaand) {
      throw new NieuweKlantFout(
        `${klant.naam} heeft al een account van ${bestaand.eigenaar_email} (${bestaand.eigenaar_naam}). ` +
          'Een eigenaar heeft één LinkedIn-account; er is niets toegevoegd. ' +
          'Is de koppellink verlopen of kwijt, maak dan bij dat account een nieuwe koppellink.',
      );
    }
    // Status CONNECTING en opbouw_factor 0.50 zijn de schemastandaarden.
    const account = await registreerAccount(tx, {
      clientId: klant.id,
      eigenaarNaam: schoon.eigenaarNaam,
      eigenaarEmail: schoon.eigenaarEmail,
      abonnement: schoon.abonnement,
      tijdzone: schoon.tijdzone,
    });
    const uitnodiging = await maakUitnodiging(tx, account.id, opties);
    return { clientId: klant.id, accountId: account.id, uitnodiging };
  });
}
