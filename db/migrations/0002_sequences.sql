-- 0002_sequences.sql — kolommen voor de sequentie-motor (fase 3, ronde 3).
-- Zie SPEC.md §8a en docs/fase-3-plan.md.
--
-- Prod-note: deze migratie NIET uitvoeren tot Rubert expliciet akkoord geeft.
-- Lokaal/CI draait hij automatisch via PGlite (tests + dev:demo).

-- Lead-metadata en teksten per stap horen bij de sequentie. We bewaren de
-- drie teksten zodat de tick ze later kan hergebruiken voor stap 2 en 3,
-- zonder dat de MCP-skill opnieuw aangeroepen hoeft te worden.
alter table sequences add column lead_naam         text;
alter table sequences add column lead_functie      text;
alter table sequences add column lead_bedrijf      text;
alter table sequences add column waarom            text;
alter table sequences add column tekst_invite      text;
alter table sequences add column tekst_bericht     text;
alter table sequences add column tekst_opvolging   text;
alter table sequences add column stop_reden        text;

-- Elke actie die uit een sequentie komt verwijst terug naar haar sequentie
-- en vermeldt haar stap-nummer (1 = invite, 2 = eerste bericht, 3 = opvolging).
-- `on delete set null` zodat een verwijderde sequentie historische acties
-- niet meesleept (we verwijderen zelden iets; dit is defensief).
alter table actions add column sequence_id   uuid references sequences(id) on delete set null;
alter table actions add column sequence_stap integer
  check (sequence_stap is null or sequence_stap between 1 and 3);

create index actions_sequence_idx on actions(sequence_id);
