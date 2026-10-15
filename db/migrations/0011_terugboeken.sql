-- 0011_terugboeken.sql — budget terugboeken als Unipile vóór LinkedIn weigert (SPEC §5.1, 15 okt 2026).
--
-- `teruggeboekt_op` is gezet als het verbruik van deze actie is teruggeboekt. De
-- grens van `terugboeken.max_per_dag_per_type` (config/limits.json) telt deze kolom
-- per account, type en lokale dag. Alleen een nieuwe, lege kolom: veilig om te draaien.

alter table actions add column if not exists teruggeboekt_op timestamptz;

create index if not exists actions_teruggeboekt_idx
  on actions (account_id, type, teruggeboekt_op)
  where teruggeboekt_op is not null;
