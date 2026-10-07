import type { Klok } from '../budget/klok.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Backend } from '../db/backend.ts';
import type { Logger } from '../log/logger.ts';
import type { StripeClient } from '../stripe/client.ts';

import { BEEINDIGDE_STATUSSEN, aantalVoorPrijs, vindAbonnement } from './abonnementen.ts';

/**
 * Aantal in Stripe gelijk houden met het aantal gekoppelde LinkedIn-accounts
 * (SPEC §14.4, `prijs_per: "account"`). Aanleiding: een nieuw gekoppeld account
 * (CREATION_SUCCESS) of een handmatige actie in de admin (bijv. na ontkoppelen).
 *
 * Gooit nooit: een fout bij Stripe mag het koppelen niet laten mislukken. De
 * uitkomst komt in `events` (bron `gateway`, type `stripe_aantal_bijgewerkt` of
 * `stripe_aantal_mislukt`, payload met client_id) en is zo zichtbaar in de admin.
 */

export const EVENT_AANTAL_BIJGEWERKT = 'stripe_aantal_bijgewerkt';
export const EVENT_AANTAL_MISLUKT = 'stripe_aantal_mislukt';

export interface AantalSyncDeps {
  db: Backend;
  stripe: StripeClient | null;
  config: AbonnementConfig;
  klok: Klok;
  logger?: Logger;
}

export type AantalUitkomst =
  | { resultaat: 'bijgewerkt'; van: number | null; naar: number }
  | { resultaat: 'ongewijzigd'; naar: number }
  | { resultaat: 'overgeslagen'; reden: string }
  | { resultaat: 'mislukt'; reden: string };

export async function synchroniseerAantal(
  deps: AantalSyncDeps,
  clientId: string,
  aanleiding: string,
): Promise<AantalUitkomst> {
  if (deps.config.prijs_per !== 'account') {
    return { resultaat: 'overgeslagen', reden: 'Prijs per klant; het aantal blijft 1.' };
  }
  if (!deps.stripe) return { resultaat: 'overgeslagen', reden: 'Betalen is nog niet ingericht.' };
  const abonnement = await vindAbonnement(deps.db, clientId);
  const subId = abonnement?.stripeSubscriptionId ?? null;
  if (!subId || !abonnement?.status || BEEINDIGDE_STATUSSEN.has(abonnement.status)) {
    return { resultaat: 'overgeslagen', reden: 'Geen lopend abonnement.' };
  }
  const naar = await aantalVoorPrijs(deps.db, clientId);
  try {
    const sub = await deps.stripe.haalAbonnement(subId);
    const item = sub.items?.data?.[0];
    if (!item?.id) throw new Error('Abonnement heeft geen item om het aantal van bij te werken.');
    const van = typeof item.quantity === 'number' ? item.quantity : null;
    if (van === naar) return { resultaat: 'ongewijzigd', naar };
    await deps.stripe.werkAantalBij({ subscriptionId: subId, itemId: item.id, aantal: naar });
    await bewaar(deps, EVENT_AANTAL_BIJGEWERKT, { client_id: clientId, subscription_id: subId, van, naar, aanleiding });
    deps.logger?.info('Aantal in Stripe bijgewerkt', { client_id: clientId, van, naar, aanleiding });
    return { resultaat: 'bijgewerkt', van, naar };
  } catch (err) {
    const reden = (err as Error)?.message ?? String(err);
    deps.logger?.error('Aantal in Stripe bijwerken mislukt', { client_id: clientId, naar, aanleiding, fout: reden });
    try {
      await bewaar(deps, EVENT_AANTAL_MISLUKT, { client_id: clientId, subscription_id: subId, naar, aanleiding, fout: reden });
    } catch (opslag) {
      deps.logger?.error('Event over mislukt bijwerken niet opgeslagen', { fout: (opslag as Error).message });
    }
    return { resultaat: 'mislukt', reden };
  }
}

export async function synchroniseerAantalVoorAccount(
  deps: AantalSyncDeps,
  accountId: string,
  aanleiding: string,
): Promise<AantalUitkomst> {
  try {
    const [r] = await deps.db.query<{ client_id: string }>('select client_id from accounts where id = $1', [accountId]);
    if (!r) return { resultaat: 'overgeslagen', reden: 'Onbekend account.' };
    return await synchroniseerAantal(deps, r.client_id, aanleiding);
  } catch (err) {
    deps.logger?.error('Aantal in Stripe bijwerken mislukt', { account_id: accountId, fout: (err as Error).message });
    return { resultaat: 'mislukt', reden: (err as Error).message };
  }
}

export interface LaatsteAantalSync {
  gelukt: boolean;
  op: Date;
  fout: string | null;
}

/** Laatste poging om het aantal bij te werken, voor de admin. */
export async function laatsteAantalSync(db: Backend, clientId: string): Promise<LaatsteAantalSync | null> {
  const rijen = await db.query<{ type: string; ontvangen_op: string | Date; fout: string | null }>(
    `select type, ontvangen_op, payload->>'fout' as fout from events
     where bron = 'gateway'::event_source and type in ($2, $3) and payload->>'client_id' = $1
     order by ontvangen_op desc, id desc limit 1`,
    [clientId, EVENT_AANTAL_BIJGEWERKT, EVENT_AANTAL_MISLUKT],
  );
  const r = rijen[0];
  if (!r) return null;
  return { gelukt: r.type === EVENT_AANTAL_BIJGEWERKT, op: new Date(r.ontvangen_op), fout: r.fout };
}

async function bewaar(deps: AantalSyncDeps, type: string, payload: Record<string, unknown>): Promise<void> {
  await deps.db.query(
    `insert into events(bron, type, payload, ontvangen_op) values ('gateway'::event_source, $1, $2::jsonb, $3)`,
    [type, JSON.stringify(payload), deps.klok.nu().toISOString()],
  );
}
