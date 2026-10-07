import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Instellingen van het abonnement (SPEC §14.4). Bron: `config/abonnement.json`.
 * Prijs en valuta staan in Stripe (STRIPE_PRICE_ID), nooit hier of in code.
 */

export type PrijsPer = 'account' | 'klant';

export interface AbonnementConfig {
  /** Gratis proefperiode in Stripe Checkout (0 = geen proef). */
  proefperiode_dagen: number;
  /** "account": aantal = gekoppelde LinkedIn-accounts (min. 1); "klant": aantal = 1. */
  prijs_per: PrijsPer;
  /** Waarschuwingsbalk in het portaal bij Stripe-status past_due. */
  waarschuwing_past_due: boolean;
}

const HIER = dirname(fileURLToPath(import.meta.url));
const STANDAARD_PAD = join(HIER, '..', '..', 'config', 'abonnement.json');
/** Stripe accepteert maximaal 730 dagen proef. */
const MAX_PROEF_DAGEN = 730;

export async function laadAbonnementConfig(pad: string = STANDAARD_PAD): Promise<AbonnementConfig> {
  const inhoud = await readFile(pad, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(inhoud);
  } catch (err) {
    throw new Error(
      `config/abonnement.json kan niet gelezen worden als JSON (${(err as Error).message}).`,
    );
  }
  return abonnementConfigUitObject(obj);
}

export function abonnementConfigUitObject(obj: unknown): AbonnementConfig {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Abonnementsconfiguratie moet een object zijn.');
  }
  const o = obj as Record<string, unknown>;
  const dagen = o['proefperiode_dagen'];
  if (typeof dagen !== 'number' || !Number.isInteger(dagen) || dagen < 0 || dagen > MAX_PROEF_DAGEN) {
    throw new Error(
      `Veld "proefperiode_dagen" moet een geheel getal van 0 tot en met ${MAX_PROEF_DAGEN} zijn (gaf ${JSON.stringify(dagen)}).`,
    );
  }
  const prijsPer = o['prijs_per'];
  if (prijsPer !== 'account' && prijsPer !== 'klant') {
    throw new Error(
      `Veld "prijs_per" moet "account" of "klant" zijn (gaf ${JSON.stringify(prijsPer)}).`,
    );
  }
  const waarschuwing = o['waarschuwing_past_due'];
  if (typeof waarschuwing !== 'boolean') {
    throw new Error('Veld "waarschuwing_past_due" moet true of false zijn.');
  }
  return { proefperiode_dagen: dagen, prijs_per: prijsPer, waarschuwing_past_due: waarschuwing };
}
