-- 0008_klantprofielen.sql — klantprofiel en ICP-intake (SPEC §14.6).
--
-- - klantprofielen: één rij per versie van het profiel van een klant.
--   status: concept (klant vult in, of teruggestuurd met vraag_van_markaas),
--   ingediend (wacht op MARKaaS), vastgesteld (geldt), vervangen (oude versie).
--   Per klant hooguit één open versie (concept of ingediend) en één vastgestelde.
-- - antwoorden: de antwoorden per vraag-id uit config/intake.json (intake_versie).
-- - interne_aanvulling: vrije tekst van MARKaaS (zoekfilters, uitsluitingen);
--   nooit zichtbaar in het portaal.
-- - revisie: teller per opslag; het formulier stuurt de gelezen revisie mee
--   zodat twee collega's elkaar niet stil overschrijven.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

create table klantprofielen (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  versie              integer not null check (versie >= 1),
  status              text not null check (status in ('concept', 'ingediend', 'vastgesteld', 'vervangen')),
  intake_versie       text not null,
  antwoorden          jsonb not null default '{}'::jsonb,
  interne_aanvulling  text not null default '',
  vraag_van_markaas   text,
  revisie             integer not null default 0,
  ingediend_door      text,
  ingediend_op        timestamptz,
  vastgesteld_door    text,
  vastgesteld_op      timestamptz,
  aangemaakt_op       timestamptz not null default now(),
  bijgewerkt_op       timestamptz not null default now(),
  unique (client_id, versie)
);

create unique index klantprofielen_open_idx on klantprofielen(client_id)
  where status in ('concept', 'ingediend');
create unique index klantprofielen_vastgesteld_idx on klantprofielen(client_id)
  where status = 'vastgesteld';
