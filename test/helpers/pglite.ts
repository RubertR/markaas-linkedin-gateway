import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

import type { Backend } from '../../src/db/backend.ts';
import { draaiMigraties } from '../../src/db/migrator.ts';
import { pgliteBackend } from '../../src/db/pglite-backend.ts';

const HIER = dirname(fileURLToPath(import.meta.url));
export const MIGRATIE_MAP = join(HIER, '..', '..', 'db', 'migrations');

export interface VerseDb {
  db: Backend;
  toegepast: string[];
  close: () => Promise<void>;
}

export async function verseDatabaseMetMigraties(): Promise<VerseDb> {
  const pg = new PGlite();
  const db = pgliteBackend(pg);
  const toegepast = await draaiMigraties(db, MIGRATIE_MAP);
  return { db, toegepast, close: () => db.close() };
}

export async function versePglite(): Promise<{ db: Backend; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db = pgliteBackend(pg);
  return { db, close: () => db.close() };
}
