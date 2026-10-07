-- 0006_abonnementen.sql — abonnement via Stripe (SPEC §14.4).
--
-- - subscriptions: één rij per klant met de stand van het Stripe-abonnement.
--   status is de Stripe-status als tekst (trialing, active, past_due, unpaid,
--   canceled, incomplete, incomplete_expired, paused). De betaalpoort in de
--   budgetmotor laat verzending alleen door bij trialing, active en past_due.
--   stripe_event_op: aanmaaktijd (event.created) van het Stripe-event dat de rij
--   het laatst bijwerkte; een ouder event dat later binnenkomt overschrijft niets.
-- - event_source krijgt 'stripe': Stripe-webhooks worden in `events` opgeslagen
--   en ontdubbeld op extern_id = 'stripe:' || event.id.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

alter type event_source add value if not exists 'stripe';

create table subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null unique references clients(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,
  proef_tot              timestamptz,
  periode_tot            timestamptz,
  opgezegd_per_einde     boolean not null default false,
  stripe_event_op        timestamptz,
  bijgewerkt_op          timestamptz not null default now()
);

create unique index subscriptions_customer_idx on subscriptions(stripe_customer_id)
  where stripe_customer_id is not null;
create unique index subscriptions_subscription_idx on subscriptions(stripe_subscription_id)
  where stripe_subscription_id is not null;
