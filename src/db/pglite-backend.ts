import type { PGlite, Transaction } from '@electric-sql/pglite';

import type { Backend } from './backend.ts';

type Uitvoerder = Pick<PGlite | Transaction, 'exec' | 'query'>;

function uitvoerderBackend(uitvoerder: Uitvoerder, binnenTransactie: boolean, db: PGlite): Backend {
  return {
    async exec(sql: string): Promise<void> {
      await uitvoerder.exec(sql);
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await uitvoerder.query<T>(sql, params);
      return res.rows;
    },
    async close(): Promise<void> {
      if (binnenTransactie) {
        throw new Error('close() is niet geldig binnen een transactie.');
      }
      await db.close();
    },
    async transaction<T>(fn: (binnen: Backend) => Promise<T>): Promise<T> {
      if (binnenTransactie) {
        throw new Error('Nested transacties zijn niet ondersteund.');
      }
      const resultaat = await db.transaction<T>(async (tx) => {
        return fn(uitvoerderBackend(tx, true, db));
      });
      if (resultaat === undefined) {
        throw new Error(
          'Transactie werd afgebroken via rollback(); gebruik een throw om expliciet te annuleren.',
        );
      }
      return resultaat;
    },
  };
}

export function pgliteBackend(db: PGlite): Backend {
  return uitvoerderBackend(db, false, db);
}
