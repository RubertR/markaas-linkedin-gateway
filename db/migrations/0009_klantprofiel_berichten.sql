-- 0009_klantprofiel_berichten.sql — vraag en antwoord bij het klantprofiel (SPEC §14.6, versie 0.4).
--
-- - klantprofiel_berichten: kort gesprek bij één profielversie. `van` is
--   'markaas' (vraag bij terugsturen) of 'klant' (antwoord bij indienen).
--   Berichten worden nooit gewijzigd of verwijderd; alleen met het profiel of
--   de klant verdwijnen ze (cascade). client_id staat erbij zodat elke query
--   op de klant kan filteren.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

create table klantprofiel_berichten (
  id          uuid primary key default gen_random_uuid(),
  -- Volgorde binnen het gesprek, ook als twee berichten hetzelfde tijdstip hebben.
  nr          bigint generated always as identity,
  profiel_id  uuid not null references klantprofielen(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  van         text not null check (van in ('markaas', 'klant')),
  tekst       text not null check (char_length(tekst) between 1 and 1000),
  door        text not null,
  op          timestamptz not null default now()
);

create index klantprofiel_berichten_profiel_idx on klantprofiel_berichten(profiel_id, nr);
