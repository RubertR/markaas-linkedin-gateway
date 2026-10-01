import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Backend } from './backend.ts';

async function zorgTabel(db: Backend): Promise<void> {
  await db.exec(`
    create table if not exists schema_migrations (
      naam         text primary key,
      toegepast_op timestamptz not null default now()
    );
  `);
}

async function openstaand(db: Backend, dir: string): Promise<string[]> {
  const bestanden = (await readdir(dir))
    .filter((naam) => naam.endsWith('.sql'))
    .sort();
  const alToegepast = new Set(
    (await db.query<{ naam: string }>('select naam from schema_migrations')).map((r) => r.naam),
  );
  return bestanden.filter((naam) => !alToegepast.has(naam));
}

export async function draaiMigraties(db: Backend, dir: string): Promise<string[]> {
  await zorgTabel(db);
  const nieuw: string[] = [];
  for (const naam of await openstaand(db, dir)) {
    const sql = await readFile(join(dir, naam), 'utf8');
    await db.exec(sql);
    await db.query('insert into schema_migrations(naam) values ($1)', [naam]);
    nieuw.push(naam);
  }
  return nieuw;
}

export async function planMigraties(db: Backend, dir: string): Promise<string[]> {
  const bestanden = (await readdir(dir))
    .filter((naam) => naam.endsWith('.sql'))
    .sort();
  const [bestaat] = await db.query<{ bestaat: boolean }>(
    `select exists(
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'schema_migrations'
     ) as bestaat`,
  );
  if (!bestaat?.bestaat) return bestanden;
  const alToegepast = new Set(
    (await db.query<{ naam: string }>('select naam from schema_migrations')).map((r) => r.naam),
  );
  return bestanden.filter((naam) => !alToegepast.has(naam));
}
