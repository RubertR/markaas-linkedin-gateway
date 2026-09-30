import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Backend } from './backend.ts';

export async function draaiMigraties(db: Backend, dir: string): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      naam         text primary key,
      toegepast_op timestamptz not null default now()
    );
  `);

  const bestanden = (await readdir(dir))
    .filter((naam) => naam.endsWith('.sql'))
    .sort();

  const alToegepast = new Set(
    (await db.query<{ naam: string }>('select naam from schema_migrations')).map((r) => r.naam),
  );

  const nieuw: string[] = [];
  for (const naam of bestanden) {
    if (alToegepast.has(naam)) continue;
    const sql = await readFile(join(dir, naam), 'utf8');
    await db.exec(sql);
    await db.query('insert into schema_migrations(naam) values ($1)', [naam]);
    nieuw.push(naam);
  }
  return nieuw;
}
