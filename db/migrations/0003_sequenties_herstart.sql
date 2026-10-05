-- 0003_sequenties_herstart.sql — opnieuw starten na afwijzing (SPEC §8a).
--
-- Tot nu toe mocht er per (account, lead) maar één sequentie bestaan, ook als
-- die al gestopt was. Na een afwijzing op de goedkeuringspagina moet een
-- nieuwe sequentie met een verbeterde tekst kunnen starten. De database
-- bewaakt voortaan alleen dat er hooguit één *actieve* sequentie per lead is;
-- of een gestopte sequentie herstart mag, beslist de code (startSequentie).
--
-- Prod-note: deze migratie NIET uitvoeren tot Rubert expliciet akkoord geeft.
-- Eerst `npm run migrate -- --dry-run`. Bestaande data (lopende sequenties met
-- een afgewezen stap) herstel je daarna met `npm run sequenties:herstel`
-- (standaard dry-run).

drop index sequences_account_lead_idx;

create unique index sequences_account_lead_actief_idx
  on sequences(account_id, lead_linkedin_url)
  where status in ('lopend', 'geaccepteerd');

create index sequences_account_lead_idx on sequences(account_id, lead_linkedin_url);
