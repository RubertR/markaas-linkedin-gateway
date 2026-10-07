-- 0007_toestemming_momentopname.sql — bewijswaarde van de toestemming (SPEC §14.2 punt 4).
--
-- account_consents bewaart een momentopname van klant en account op het moment van
-- toestemming, zodat het bewijs leesbaar blijft als het account later verwijderd of
-- hernoemd wordt (account_id staat dan op null; zie 0004).
-- - client_id: verwijst naar de klant, maar `on delete set null` zodat het bewijs blijft.
-- - klantnaam, account_eigenaar_naam, unipile_account_id: tekst zoals op dat moment.
-- Bestaande rijen worden zo goed mogelijk aangevuld uit de huidige gegevens.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

alter table account_consents
  add column client_id uuid references clients(id) on delete set null,
  add column klantnaam text,
  add column account_eigenaar_naam text,
  add column unipile_account_id text;

update account_consents ac
   set client_id = a.client_id,
       klantnaam = c.naam,
       account_eigenaar_naam = a.eigenaar_naam,
       unipile_account_id = a.unipile_account_id
  from accounts a
  join clients c on c.id = a.client_id
 where a.id = ac.account_id;
