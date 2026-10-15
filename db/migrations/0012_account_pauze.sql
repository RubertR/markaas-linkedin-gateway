-- 0012_account_pauze.sql — wachtende acties bewaren als een account op pauze staat (SPEC §6b, 15 okt 2026).
--
-- `pauze_geparkeerd_sinds` is het moment waarop de planner deze actie voor het eerst
-- parkeerde omdat het account op CREDENTIALS, ERROR of STOPPED stond. Na
-- `account_pauze.max_parkeer_dagen` (config/limits.json) vervalt de actie. De planner
-- wist de kolom zodra de actie om een andere reden wordt beoordeeld, zodat een latere
-- pauze opnieuw telt. Alleen een nieuwe, lege kolom: veilig om te draaien.

alter table actions add column if not exists pauze_geparkeerd_sinds timestamptz;
