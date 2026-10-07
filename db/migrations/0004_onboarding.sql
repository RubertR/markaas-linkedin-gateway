-- 0004_onboarding.sql — onboarding van een nieuwe klant (SPEC §14.2, §14.4).
--
-- - clients.abonnement_vereist: betaalpoort (§14.4). Nieuwe klanten standaard true;
--   MARKaaS zelf false. IPknowledge en TAG worden later via /admin/klanten/nieuw
--   aangemaakt met het vinkje uit.
-- - accounts.eigenaar_email: voor de koppelpagina (vooringevuld) en de mail van Rubert.
-- - koppel_uitnodigingen: eenmalige koppellinks van de gateway; alleen de SHA-256-hash
--   van het token wordt bewaard.
-- - account_consents: vastgelegde toestemming op de koppelpagina (§14.2 punt 4).
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

alter table clients add column abonnement_vereist boolean not null default true;
update clients set abonnement_vereist = false where slug = 'markaas';

alter table accounts add column eigenaar_email text;

create table koppel_uitnodigingen (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  token_hash    text not null unique,
  aangemaakt_op timestamptz not null default now(),
  verloopt_op   timestamptz not null,
  gebruikt_op   timestamptz
);

create index koppel_uitnodigingen_account_idx on koppel_uitnodigingen(account_id);

create table account_consents (
  id                            uuid primary key default gen_random_uuid(),
  -- Toestemming blijft bewaard als bewijs, ook na verwijderen van het account
  -- (SPEC §14.2 punt 4: zolang het account bestaat plus 2 jaar).
  account_id                    uuid references accounts(id) on delete set null,
  uitnodiging_id                uuid references koppel_uitnodigingen(id) on delete set null,
  naam                          text not null,
  email                         text not null,
  versie_voorwaarden            text not null,
  versie_verwerkersovereenkomst text not null,
  ip_hash                       text,
  user_agent                    text,
  gegeven_op                    timestamptz not null default now()
);

create index account_consents_account_idx on account_consents(account_id);
