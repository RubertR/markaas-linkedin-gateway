import type { Backend } from '../db/backend.ts';

/**
 * Abonnementen per klant (SPEC §14.4), tabel `subscriptions`. Eén rij per
 * klant; `status` is de Stripe-status als tekst. Let op: "abonnement" in
 * src/register/accounts.ts is het LinkedIn-abonnement van een account; dit is
 * het MARKaaS-abonnement van de klant (KlantAbonnement).
 */

/** Stripe-statussen waarbij verzenden doorgaat (SPEC §14.4). */
export const VERZEND_STATUSSEN: ReadonlySet<string> = new Set(['trialing', 'active', 'past_due']);

/** Statussen waarna een nieuw abonnement gestart kan worden. */
export const BEEINDIGDE_STATUSSEN: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export const REDEN_NIET_ACTIEF =
  'Abonnement niet actief: de klant moet in het klantportaal een abonnement starten.';

export interface KlantAbonnement {
  clientId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: string | null;
  proefTot: Date | null;
  periodeTot: Date | null;
  opgezegdPerEinde: boolean;
  bijgewerktOp: Date;
}

export interface Betaalpoort {
  /** clients.abonnement_vereist */
  vereist: boolean;
  /** Stripe-status, of null zonder abonnement. */
  status: string | null;
}

interface Rij {
  client_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  proef_tot: string | Date | null;
  periode_tot: string | Date | null;
  opgezegd_per_einde: boolean;
  bijgewerkt_op: string | Date;
}

const KOLOMMEN = `client_id, stripe_customer_id, stripe_subscription_id, status, proef_tot,
  periode_tot, opgezegd_per_einde, bijgewerkt_op`;

function datum(w: string | Date | null): Date | null {
  if (w === null) return null;
  return w instanceof Date ? w : new Date(w);
}

function map(r: Rij): KlantAbonnement {
  return {
    clientId: r.client_id,
    stripeCustomerId: r.stripe_customer_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    status: r.status,
    proefTot: datum(r.proef_tot),
    periodeTot: datum(r.periode_tot),
    opgezegdPerEinde: r.opgezegd_per_einde,
    bijgewerktOp: datum(r.bijgewerkt_op)!,
  };
}

export async function vindAbonnement(db: Backend, clientId: string): Promise<KlantAbonnement | null> {
  const rijen = await db.query<Rij>(`select ${KOLOMMEN} from subscriptions where client_id = $1`, [clientId]);
  return rijen[0] ? map(rijen[0]) : null;
}

/** Mag er bij deze stand verzonden worden (invite, message, inmail)? */
export function verzendenToegestaan(p: Betaalpoort): boolean {
  if (!p.vereist) return true;
  return p.status !== null && VERZEND_STATUSSEN.has(p.status);
}

export async function betaalpoortVoorAccount(db: Backend, accountId: string): Promise<Betaalpoort | null> {
  const rijen = await db.query<{ abonnement_vereist: boolean; status: string | null }>(
    `select c.abonnement_vereist, s.status
     from accounts a
     join clients c on c.id = a.client_id
     left join subscriptions s on s.client_id = c.id
     where a.id = $1`,
    [accountId],
  );
  const r = rijen[0];
  return r ? { vereist: r.abonnement_vereist, status: r.status } : null;
}

export async function betaalpoortVoorKlant(db: Backend, clientId: string): Promise<Betaalpoort | null> {
  const rijen = await db.query<{ abonnement_vereist: boolean; status: string | null }>(
    `select c.abonnement_vereist, s.status
     from clients c
     left join subscriptions s on s.client_id = c.id
     where c.id = $1`,
    [clientId],
  );
  const r = rijen[0];
  return r ? { vereist: r.abonnement_vereist, status: r.status } : null;
}

export async function zetAbonnementVereist(db: Backend, clientId: string, vereist: boolean): Promise<boolean> {
  const rijen = await db.query<{ id: string }>(
    'update clients set abonnement_vereist = $2 where id = $1 returning id',
    [clientId, vereist],
  );
  return rijen.length > 0;
}

/** Legt de Stripe-customer van een klant vast (maakt de rij aan als die er nog niet is). */
export async function bewaarStripeKlant(db: Backend, clientId: string, customerId: string, nu: Date): Promise<void> {
  await db.query(
    `insert into subscriptions(client_id, stripe_customer_id, bijgewerkt_op)
     values ($1, $2, $3)
     on conflict (client_id) do update
       set stripe_customer_id = excluded.stripe_customer_id, bijgewerkt_op = excluded.bijgewerkt_op`,
    [clientId, customerId, nu.toISOString()],
  );
}

/** Aantal gekoppelde LinkedIn-accounts van de klant. */
export async function aantalGekoppeld(db: Backend, clientId: string): Promise<number> {
  const [r] = await db.query<{ n: number }>(
    'select count(*)::int as n from accounts where client_id = $1 and unipile_account_id is not null',
    [clientId],
  );
  return r?.n ?? 0;
}

/** Aantal voor Stripe bij `prijs_per: account`: gekoppelde accounts, minimaal 1. */
export async function aantalVoorPrijs(db: Backend, clientId: string): Promise<number> {
  return Math.max(1, await aantalGekoppeld(db, clientId));
}

/** Stripe-status past_due: waarschuwingsbalk op alle portaalpagina's. */
export async function betalingMisluktVoorKlant(db: Backend, clientId: string): Promise<boolean> {
  const rijen = await db.query<{ status: string | null }>(
    'select status from subscriptions where client_id = $1',
    [clientId],
  );
  return rijen[0]?.status === 'past_due';
}
