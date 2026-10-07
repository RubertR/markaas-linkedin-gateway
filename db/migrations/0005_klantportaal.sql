-- 0005_klantportaal.sql — klantportaal (SPEC §14.1, §14.3), zonder abonnement (§14.4).
--
-- - client_users: klantgebruikers met eigen login op /portaal/. E-mail wordt in
--   kleine letters opgeslagen (check) en is uniek over alle klanten.
--   wachtwoord_hash blijft null tot de uitnodiging is gebruikt.
-- - client_user_uitnodigingen: eenmalige uitnodigingslinks (zelfde patroon als
--   koppel_uitnodigingen: alleen de SHA-256-hash van het token). Ook gebruikt
--   voor "wachtwoord vergeten": Rubert maakt een nieuwe link.
-- - portal_sessions: sessies van het portaal in de database, zodat een herstart
--   niemand uitlogt. id = SHA-256-hash van het sessietoken (het token zelf
--   staat alleen in de cookie).
-- - actions.afgewezen_door: wie een actie afwees (`rubert` of `klant:<e-mail>`),
--   naast het bestaande goedgekeurd_door.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

create table client_users (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  email              text not null check (email = lower(email)),
  naam               text not null,
  wachtwoord_hash    text,
  actief             boolean not null default true,
  aangemaakt_op      timestamptz not null default now(),
  laatst_ingelogd_op timestamptz
);

create unique index client_users_email_idx on client_users(email);
create index client_users_client_idx on client_users(client_id);

create table client_user_uitnodigingen (
  id             uuid primary key default gen_random_uuid(),
  client_user_id uuid not null references client_users(id) on delete cascade,
  token_hash     text not null unique,
  aangemaakt_op  timestamptz not null default now(),
  verloopt_op    timestamptz not null,
  gebruikt_op    timestamptz
);

create index client_user_uitnodigingen_user_idx on client_user_uitnodigingen(client_user_id);

create table portal_sessions (
  id              text primary key,
  client_user_id  uuid not null references client_users(id) on delete cascade,
  csrf_token      text not null,
  aangemaakt_op   timestamptz not null default now(),
  verloopt_op     timestamptz not null,
  laatst_gezien_op timestamptz not null default now()
);

create index portal_sessions_user_idx on portal_sessions(client_user_id);

alter table actions add column afgewezen_door text;
