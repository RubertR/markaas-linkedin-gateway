-- 0001_init.sql — MARKaaS LinkedIn-gateway, initieel schema.
-- Zie SPEC.md §4 en docs/fase-2-plan.md §2.

create type account_subscription as enum (
  'free',
  'premium_career',
  'premium_business',
  'salesnav_core',
  'salesnav_advanced'
);

create type account_status as enum (
  'OK',
  'CONNECTING',
  'CREDENTIALS',
  'ERROR',
  'STOPPED',
  'RECONNECTED'
);

create type action_type as enum (
  'search',
  'profile',
  'invite',
  'message',
  'inmail'
);

create type action_status as enum (
  'draft',
  'approved',
  'queued',
  'running',
  'done',
  'failed',
  'rejected'
);

create type sequence_status as enum (
  'lopend',
  'geaccepteerd',
  'reactie',
  'gestopt',
  'mislukt'
);

create type event_source as enum ('unipile', 'gateway');

create table clients (
  id            uuid primary key default gen_random_uuid(),
  naam          text not null,
  slug          text not null unique,
  actief        boolean not null default true,
  aangemaakt_op timestamptz not null default now()
);

create table accounts (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete restrict,
  eigenaar_naam      text not null,
  unipile_account_id text unique,
  abonnement         account_subscription not null,
  status             account_status not null default 'CONNECTING',
  status_sinds       timestamptz not null default now(),
  opbouw_factor      numeric(3,2) not null default 0.50
                      check (opbouw_factor >= 0.50 and opbouw_factor <= 1.00),
  afkoeling_tot      timestamptz,
  tijdzone           text not null default 'Europe/Amsterdam',
  aangemaakt_op      timestamptz not null default now()
);

create index accounts_client_idx on accounts(client_id);
create index accounts_status_idx on accounts(status);

create table actions (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references accounts(id) on delete restrict,
  type             action_type not null,
  payload          jsonb not null,
  status           action_status not null default 'draft',
  reden            text,
  goedgekeurd_door text,
  goedgekeurd_op   timestamptz,
  gepland_op       timestamptz,
  uitgevoerd_op    timestamptz,
  unipile_response jsonb,
  aangemaakt_op    timestamptz not null default now()
);

create index actions_planning_idx on actions(status, gepland_op);
create index actions_account_type_idx on actions(account_id, type);

create table usage (
  account_id uuid not null references accounts(id) on delete cascade,
  type       action_type not null,
  dag        date not null,
  aantal     integer not null default 0 check (aantal >= 0),
  primary key (account_id, type, dag)
);

create table sequences (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references accounts(id) on delete restrict,
  lead_linkedin_url   text not null,
  lead_provider_id    text,
  stap                integer not null default 0,
  status              sequence_status not null default 'lopend',
  volgende_actie_op   timestamptz,
  laatste_gebeurtenis jsonb,
  aangemaakt_op       timestamptz not null default now()
);

create index sequences_planning_idx on sequences(status, volgende_actie_op);
create unique index sequences_account_lead_idx on sequences(account_id, lead_linkedin_url);

create table events (
  id           uuid primary key default gen_random_uuid(),
  bron         event_source not null,
  type         text not null,
  account_id   uuid references accounts(id) on delete set null,
  payload      jsonb not null,
  ontvangen_op timestamptz not null default now()
);

create index events_account_idx on events(account_id, ontvangen_op desc);
create index events_type_idx on events(type, ontvangen_op desc);
