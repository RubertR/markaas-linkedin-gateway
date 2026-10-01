import { Hono } from 'hono';

import type { Backend } from '../db/backend.ts';

/**
 * `GET /health` voor Railway en handmatige controle. Geeft altijd 200 zolang
 * het proces draait, met de versie en of de database bereikbaar is. Bewust
 * géén geheimen, accountgegevens, hostnamen of foutteksten van de database:
 * het endpoint is publiek.
 */

export interface HealthDeps {
  db: Backend;
  versie: string;
  /** Maximale wachttijd op de database-ping. Standaard 2 seconden. */
  timeoutMs?: number;
}

export interface HealthAntwoord {
  status: 'ok' | 'database_onbereikbaar';
  versie: string;
  database: { bereikbaar: boolean };
}

const STANDAARD_TIMEOUT_MS = 2_000;

export function maakHealthApp(deps: HealthDeps) {
  const app = new Hono();
  app.get('/health', async (c) => {
    const bereikbaar = await pingDatabase(deps.db, deps.timeoutMs ?? STANDAARD_TIMEOUT_MS);
    const antwoord: HealthAntwoord = {
      status: bereikbaar ? 'ok' : 'database_onbereikbaar',
      versie: deps.versie,
      database: { bereikbaar },
    };
    c.header('Cache-Control', 'no-store');
    return c.json(antwoord, 200);
  });
  return app;
}

export async function pingDatabase(db: Backend, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const ping = db.query('select 1 as ok').then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([ping, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
