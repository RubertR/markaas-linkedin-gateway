import type { Klok } from '../budget/klok.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Backend } from '../db/backend.ts';
import type { StripeClient } from '../stripe/client.ts';

import {
  BEEINDIGDE_STATUSSEN,
  aantalVoorPrijs,
  bewaarStripeKlant,
  vindAbonnement,
} from './abonnementen.ts';

/**
 * Abonnement starten en beheren vanuit het klantportaal (SPEC §14.3, §14.4).
 * Altijd op de klant van de sessie (`clientId`); er komt nooit een customer-
 * of abonnement-id uit het formulier. Stripe-fouten (src/stripe/errors.ts)
 * gaan ongewijzigd door; de portaalroute vertaalt ze naar een nette melding.
 */

export const NIET_INGERICHT = 'Betalen is nog niet ingericht. Neem contact op met MARKaaS.';

export interface StripeInrichting {
  client: StripeClient;
  priceId: string;
}

export interface AbonnementDeps {
  db: Backend;
  klok: Klok;
  /** `null` = Stripe staat uit (env-variabelen ontbreken). */
  stripe: StripeInrichting | null;
  config: AbonnementConfig;
  /** Publieke basis-URL zonder slash aan het eind, voor success/cancel/return-URL's. */
  publicBaseUrl: string;
}

/** Fout met een melding die zo aan de klant getoond kan worden. */
export class AbonnementFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'AbonnementFout';
  }
}

interface KlantRij {
  naam: string;
  abonnement_vereist: boolean;
}

async function klant(db: Backend, clientId: string): Promise<KlantRij> {
  const [r] = await db.query<KlantRij>('select naam, abonnement_vereist from clients where id = $1', [clientId]);
  if (!r) throw new AbonnementFout('Onbekende klant; log opnieuw in.');
  return r;
}

/** Maakt een Stripe Checkout Session en geeft de URL terug om naartoe te sturen. */
export async function startAbonnement(
  deps: AbonnementDeps,
  clientId: string,
  opties: { email?: string } = {},
): Promise<string> {
  const k = await klant(deps.db, clientId);
  if (!k.abonnement_vereist) {
    throw new AbonnementFout('Voor uw organisatie is geen abonnement nodig.');
  }
  if (!deps.stripe) throw new AbonnementFout(NIET_INGERICHT);
  const bestaand = await vindAbonnement(deps.db, clientId);
  if (bestaand?.status && !BEEINDIGDE_STATUSSEN.has(bestaand.status)) {
    throw new AbonnementFout('U heeft al een abonnement. Wijzigen of opzeggen kan via "Abonnement beheren".');
  }

  let customerId = bestaand?.stripeCustomerId ?? null;
  if (customerId && !(await deps.stripe.client.haalKlant(customerId))) customerId = null;
  if (!customerId) {
    const nieuw = await deps.stripe.client.maakKlant({
      clientId,
      naam: k.naam,
      ...(opties.email ? { email: opties.email } : {}),
    });
    customerId = nieuw.id;
    await bewaarStripeKlant(deps.db, clientId, customerId, deps.klok.nu());
  }

  const aantal = deps.config.prijs_per === 'account' ? await aantalVoorPrijs(deps.db, clientId) : 1;
  const sessie = await deps.stripe.client.maakCheckoutSessie({
    clientId,
    customerId,
    priceId: deps.stripe.priceId,
    aantal,
    proefperiodeDagen: deps.config.proefperiode_dagen,
    successUrl: `${deps.publicBaseUrl}/portaal/abonnement/gelukt`,
    cancelUrl: `${deps.publicBaseUrl}/portaal/abonnement/geannuleerd`,
  });
  return sessie.url;
}

/** Maakt een Stripe Customer Portal-sessie voor de eigen klant. */
export async function beheerAbonnement(deps: AbonnementDeps, clientId: string): Promise<string> {
  await klant(deps.db, clientId);
  if (!deps.stripe) throw new AbonnementFout(NIET_INGERICHT);
  const bestaand = await vindAbonnement(deps.db, clientId);
  if (!bestaand?.stripeCustomerId) {
    throw new AbonnementFout('Er is nog geen abonnement om te beheren. Start eerst een abonnement.');
  }
  const sessie = await deps.stripe.client.maakPortaalSessie({
    customerId: bestaand.stripeCustomerId,
    returnUrl: `${deps.publicBaseUrl}/portaal/abonnement`,
  });
  return sessie.url;
}
