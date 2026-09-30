import type { PGlite } from '@electric-sql/pglite';

import type { Backend } from './backend.ts';

export function pgliteBackend(db: PGlite): Backend {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await db.query<T>(sql, params);
      return res.rows;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
