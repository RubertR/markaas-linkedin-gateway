-- 0010_jsonb_strings_herstellen.sql — dubbel gecodeerde JSON terugzetten (fix 13 okt 2026).
--
-- Oorzaak: parameters als `$n::jsonb` met een JSON-tekst. postgres.js zette die
-- tekst nog eens om, waardoor Postgres een jsonb-*string* opsloeg in plaats van
-- een object. Queries als `payload ->> 'chatId'` vonden daardoor niets. De code
-- schrijft sinds deze fix `$n::text::jsonb` (bewaakt door
-- test/jsonb-parameters.test.ts).
--
-- Deze migratie zet bestaande strings om naar het object dat erin staat. Alleen
-- rijen waarvan de waarde een jsonb-string is én die string geldige JSON
-- (object of array) bevat, worden aangepast; al goede rijen blijven ongemoeid.
-- Herhaald draaien verandert niets meer.
--
-- Prod-note: NIET uitvoeren tot Rubert expliciet akkoord geeft. Eerst
-- `npm run migrate -- --dry-run`.

update actions
   set payload = (payload #>> '{}')::jsonb
 where jsonb_typeof(payload) = 'string'
   and left(ltrim(payload #>> '{}'), 1) in ('{', '[');

update actions
   set unipile_response = (unipile_response #>> '{}')::jsonb
 where unipile_response is not null
   and jsonb_typeof(unipile_response) = 'string'
   and left(ltrim(unipile_response #>> '{}'), 1) in ('{', '[');

update events
   set payload = (payload #>> '{}')::jsonb
 where jsonb_typeof(payload) = 'string'
   and left(ltrim(payload #>> '{}'), 1) in ('{', '[');

update klantprofielen
   set antwoorden = (antwoorden #>> '{}')::jsonb
 where jsonb_typeof(antwoorden) = 'string'
   and left(ltrim(antwoorden #>> '{}'), 1) in ('{', '[');

update sequences
   set laatste_gebeurtenis = (laatste_gebeurtenis #>> '{}')::jsonb
 where laatste_gebeurtenis is not null
   and jsonb_typeof(laatste_gebeurtenis) = 'string'
   and left(ltrim(laatste_gebeurtenis #>> '{}'), 1) in ('{', '[');
