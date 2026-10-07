import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import type { StripeAbonnement, StripeClient } from '../stripe/client.ts';
import { StripeVerzoekFout } from '../stripe/errors.ts';

import { BEEINDIGDE_STATUSSEN } from './abonnementen.ts';

/**
 * Verwerking van Stripe-webhooks (SPEC §14.4). De handtekening is dan al
 * gecontroleerd (src/webhooks/stripe.ts). Elk event wordt in `events`
 * opgeslagen (bron `stripe`, extern_id `stripe:<event.id>`); een tweede
 * levering van hetzelfde event verandert niets.
 *
 * - `checkout.session.completed`: koppelt customer en subscription aan de klant
 *   (`client_reference_id`, anders `metadata.client_id`) en haalt de actuele
 *   stand van het abonnement op.
 * - `customer.subscription.created|updated|deleted`: het abonnement opnieuw
 *   ophalen en die actuele stand opslaan (status, trial_end, current_period_end,
 *   cancel_at_period_end); alleen als Stripe het niet meer kent, de stand uit het event.
 * - `invoice.paid`, `invoice.payment_failed`: het abonnement opnieuw ophalen;
 *   Stripe heeft de status dan al bijgewerkt (bijv. naar `past_due`).
 * - Overige events: alleen opslaan.
 *
 * Volgorde: Stripe garandeert geen volgorde van levering. Omdat de stand steeds
 * vers wordt opgehaald, maakt de volgorde voor de inhoud weinig uit. Daarnaast:
 * een event dat ouder is (`event.created`) dan het event waarmee de rij het laatst
 * werd bijgewerkt, verandert niets — ook bij een ander abonnement-id; een gelijk
 * tijdstip wel. Een beëindigd ander abonnement overschrijft een lopend abonnement
 * van dezelfde klant niet.
 */

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

export interface StripeWebhookUitkomst {
  verwerkt: boolean;
  dubbel?: boolean;
  reden?: string;
}

export const VERWERKTE_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export class StripeEventFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'StripeEventFout';
  }
}

/** Controleert de vorm van een (geparst) Stripe-event. */
export function alsStripeEvent(waarde: unknown): StripeEvent {
  const e = waarde as Partial<StripeEvent> | null;
  if (
    !e ||
    typeof e !== 'object' ||
    typeof e.id !== 'string' ||
    !e.id ||
    typeof e.type !== 'string' ||
    typeof e.created !== 'number' ||
    !e.data ||
    typeof e.data !== 'object' ||
    typeof e.data.object !== 'object' ||
    e.data.object === null
  ) {
    throw new StripeEventFout('Stripe-event mist id, type, created of data.object.');
  }
  return e as StripeEvent;
}

export interface StripeWebhookDeps {
  db: Backend;
  stripe: StripeClient;
  klok: Klok;
}

export async function verwerkStripeEvent(
  deps: StripeWebhookDeps,
  event: StripeEvent,
): Promise<StripeWebhookUitkomst> {
  const externId = `stripe:${event.id}`;
  if (await isAlOntvangen(deps.db, externId)) {
    return { verwerkt: false, dubbel: true, reden: 'Dubbele levering; dit event is al verwerkt.' };
  }

  // Eerst (buiten de transactie) de actuele stand bij Stripe ophalen waar nodig.
  // Faalt dat, dan wordt niets opgeslagen en probeert Stripe het later opnieuw.
  const object = event.data.object;
  let abonnement: StripeAbonnement | null = null;
  let checkoutKlant: string | null = null;
  switch (event.type) {
    case 'checkout.session.completed': {
      checkoutKlant = tekstOfNull(object['client_reference_id']) ?? metadataClientId(object);
      const subId = idVan(object['subscription']);
      if (subId) abonnement = await deps.stripe.haalAbonnement(subId);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Altijd de actuele stand bij Stripe ophalen: het event kan verouderd zijn.
      const subId = idVan(object['id']);
      abonnement = subId
        ? await actueelAbonnement(deps.stripe, subId, object as unknown as StripeAbonnement)
        : null;
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const subId = abonnementIdUitFactuur(object);
      if (subId) abonnement = await deps.stripe.haalAbonnement(subId);
      break;
    }
  }

  return await deps.db.transaction(async (tx) => {
    const nieuw = await tx.query<{ id: string }>(
      `insert into events(bron, type, extern_id, payload)
       values ('stripe'::event_source, $1, $2, $3::jsonb)
       on conflict (bron, extern_id) where extern_id is not null do nothing
       returning id`,
      [event.type.slice(0, 100), externId, JSON.stringify(event)],
    );
    if (nieuw.length === 0) {
      return { verwerkt: false, dubbel: true, reden: 'Dubbele levering; dit event is al verwerkt.' };
    }

    if (!(VERWERKTE_EVENTS as readonly string[]).includes(event.type)) {
      return { verwerkt: false, reden: `Event "${event.type}" wordt niet gebruikt; alleen opgeslagen.` };
    }

    if (event.type === 'checkout.session.completed') {
      const customerId = idVan(object['customer']);
      const clientId = checkoutKlant && (await bestaandeKlant(tx, checkoutKlant));
      if (!clientId) {
        return { verwerkt: false, reden: 'Checkout zonder bekende klant (client_reference_id); alleen opgeslagen.' };
      }
      if (abonnement) {
        return await pasAbonnementToe(tx, clientId, abonnement, event, deps.klok);
      }
      if (customerId) {
        await tx.query(
          `insert into subscriptions(client_id, stripe_customer_id, bijgewerkt_op) values ($1, $2, $3)
           on conflict (client_id) do update set stripe_customer_id = excluded.stripe_customer_id,
             bijgewerkt_op = excluded.bijgewerkt_op`,
          [clientId, customerId, deps.klok.nu().toISOString()],
        );
      }
      return { verwerkt: true };
    }

    if (!abonnement) {
      return { verwerkt: false, reden: 'Factuur hoort niet bij een abonnement; alleen opgeslagen.' };
    }
    const clientId = await klantVoorAbonnement(tx, abonnement);
    if (!clientId) {
      return { verwerkt: false, reden: 'Abonnement hoort bij geen bekende klant; alleen opgeslagen.' };
    }
    return await pasAbonnementToe(tx, clientId, abonnement, event, deps.klok);
  });
}

async function pasAbonnementToe(
  tx: Backend,
  clientId: string,
  sub: StripeAbonnement,
  event: StripeEvent,
  klok: Klok,
): Promise<StripeWebhookUitkomst> {
  const status = tekstOfNull(sub.status);
  const customerId = idVan(sub.customer);
  if (!status || !sub.id) {
    return { verwerkt: false, reden: 'Abonnement zonder id of status; alleen opgeslagen.' };
  }
  const eventOp = new Date(event.created * 1000).toISOString();
  const bestaand = await tx.query<{ stripe_subscription_id: string | null; status: string | null; stripe_event_op: string | Date | null }>(
    'select stripe_subscription_id, status, stripe_event_op from subscriptions where client_id = $1 for update',
    [clientId],
  );
  const b = bestaand[0];
  if (b) {
    const ander = b.stripe_subscription_id !== null && b.stripe_subscription_id !== sub.id;
    if (ander && BEEINDIGDE_STATUSSEN.has(status) && !(b.status !== null && BEEINDIGDE_STATUSSEN.has(b.status))) {
      return { verwerkt: false, reden: 'Event over een eerder, beëindigd abonnement; huidige stand blijft staan.' };
    }
    // Ouderdomscontrole, ook bij een ander abonnement-id. Gelijk tijdstip mag
    // (de stand is net bij Stripe opgehaald, dus minstens zo actueel).
    const vorige = b.stripe_event_op === null ? null : new Date(b.stripe_event_op).getTime();
    if (vorige !== null && event.created * 1000 < vorige) {
      return { verwerkt: false, reden: 'Ouder event dan de huidige stand; niets gewijzigd.' };
    }
  }
  await tx.query(
    `insert into subscriptions(client_id, stripe_customer_id, stripe_subscription_id, status, proef_tot,
       periode_tot, opgezegd_per_einde, stripe_event_op, bijgewerkt_op)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (client_id) do update set
       stripe_customer_id = coalesce(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
       stripe_subscription_id = excluded.stripe_subscription_id,
       status = excluded.status,
       proef_tot = excluded.proef_tot,
       periode_tot = excluded.periode_tot,
       opgezegd_per_einde = excluded.opgezegd_per_einde,
       stripe_event_op = excluded.stripe_event_op,
       bijgewerkt_op = excluded.bijgewerkt_op`,
    [
      clientId,
      customerId,
      sub.id,
      status,
      seconden(sub.trial_end),
      seconden(periodeEinde(sub)),
      sub.cancel_at_period_end === true,
      eventOp,
      klok.nu().toISOString(),
    ],
  );
  return { verwerkt: true };
}

/** Actuele stand bij Stripe; bestaat het abonnement daar niet (meer), dan de stand uit het event. */
async function actueelAbonnement(
  stripe: StripeClient,
  subId: string,
  uitEvent: StripeAbonnement,
): Promise<StripeAbonnement> {
  try {
    return await stripe.haalAbonnement(subId);
  } catch (err) {
    if (err instanceof StripeVerzoekFout && err.status === 404) return uitEvent;
    throw err;
  }
}

/** `current_period_end` staat op het abonnement (oudere API) of per item (nieuwere API). */
function periodeEinde(sub: StripeAbonnement): number | null {
  if (typeof sub.current_period_end === 'number') return sub.current_period_end;
  const items = sub.items?.data ?? [];
  const eindes = items.map((i) => i.current_period_end).filter((w): w is number => typeof w === 'number');
  return eindes.length > 0 ? Math.min(...eindes) : null;
}

async function klantVoorAbonnement(tx: Backend, sub: StripeAbonnement): Promise<string | null> {
  const viaMetadata = metadataClientId(sub as unknown as Record<string, unknown>);
  if (viaMetadata) {
    const id = await bestaandeKlant(tx, viaMetadata);
    if (id) return id;
  }
  const rijen = await tx.query<{ client_id: string }>(
    `select client_id from subscriptions
     where stripe_subscription_id = $1 or ($2::text is not null and stripe_customer_id = $2)
     order by (stripe_subscription_id = $1) desc nulls last
     limit 1`,
    [sub.id, idVan(sub.customer)],
  );
  return rijen[0]?.client_id ?? null;
}

async function bestaandeKlant(tx: Backend, clientId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) return null;
  const rijen = await tx.query<{ id: string }>('select id from clients where id = $1', [clientId]);
  return rijen[0]?.id ?? null;
}

async function isAlOntvangen(db: Backend, externId: string): Promise<boolean> {
  const rijen = await db.query<{ id: string }>(
    `select id from events where bron = 'stripe'::event_source and extern_id = $1`,
    [externId],
  );
  return rijen.length > 0;
}

function abonnementIdUitFactuur(factuur: Record<string, unknown>): string | null {
  const direct = idVan(factuur['subscription']);
  if (direct) return direct;
  // Nieuwere API-versies: invoice.parent.subscription_details.subscription
  const parent = factuur['parent'] as { subscription_details?: { subscription?: unknown } } | null | undefined;
  return idVan(parent?.subscription_details?.subscription);
}

function metadataClientId(object: Record<string, unknown>): string | null {
  const m = object['metadata'] as Record<string, unknown> | null | undefined;
  return tekstOfNull(m?.['client_id']);
}

/** Een Stripe-verwijzing is een id-tekst of (uitgeklapt) een object met `id`. */
function idVan(waarde: unknown): string | null {
  if (typeof waarde === 'string' && waarde) return waarde;
  if (waarde && typeof waarde === 'object' && typeof (waarde as { id?: unknown }).id === 'string') {
    return (waarde as { id: string }).id;
  }
  return null;
}

function tekstOfNull(w: unknown): string | null {
  return typeof w === 'string' && w.trim() !== '' ? w : null;
}

function seconden(w: number | null | undefined): string | null {
  return typeof w === 'number' ? new Date(w * 1000).toISOString() : null;
}
