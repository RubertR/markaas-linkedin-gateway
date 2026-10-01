import postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';

import type { Backend } from './backend.ts';

export interface PostgresBackendOpties {
  databaseUrl: string;
  max?: number;
  idleTimeoutSeconden?: number;
  connectTimeoutSeconden?: number;
}

type Uitvoerder = Pick<Sql | TransactionSql, 'unsafe'>;

function uitvoerderBackend(
  uitvoerder: Uitvoerder,
  hoofd: Sql | null,
  binnenTransactie: boolean,
): Backend {
  return {
    async exec(sql: string): Promise<void> {
      await uitvoerder.unsafe(sql).simple();
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const rijen = await uitvoerder.unsafe(sql, params as never[]);
      return rijen as unknown as T[];
    },
    async close(): Promise<void> {
      if (binnenTransactie) {
        throw new Error('close() is niet geldig binnen een transactie.');
      }
      if (hoofd) {
        await hoofd.end({ timeout: 5 });
      }
    },
    async transaction<T>(fn: (binnen: Backend) => Promise<T>): Promise<T> {
      if (binnenTransactie) {
        throw new Error('Nested transacties zijn niet ondersteund.');
      }
      if (!hoofd) {
        throw new Error('Transacties vereisen een hoofd-connectie.');
      }
      const resultaat = await hoofd.begin(async (tx) => {
        return fn(uitvoerderBackend(tx, null, true));
      });
      return resultaat as T;
    },
  };
}

export function postgresBackend(opties: PostgresBackendOpties): Backend {
  const sql = postgres(opties.databaseUrl, {
    ssl: 'require',
    max: opties.max ?? 5,
    idle_timeout: opties.idleTimeoutSeconden ?? 30,
    connect_timeout: opties.connectTimeoutSeconden ?? 10,
    prepare: false,
    onnotice: () => {},
  });
  return uitvoerderBackend(sql, sql, false);
}
