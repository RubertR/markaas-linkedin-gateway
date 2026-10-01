import type { LogLevel } from '../config/env.ts';

/**
 * Gestructureerde logger: één JSON-object per regel op stdout (Railway leest
 * dat als gestructureerde log). Twee verdedigingslagen tegen lekken van
 * geheimen (CLAUDE.md regel 4):
 *
 * 1. Velden waarvan de naam op een geheim lijkt (key, token, secret,
 *    password, hash, database_url, authorization, cookie, dsn) worden
 *    vervangen door "[afgeschermd]", op elke diepte.
 * 2. Elke bekende geheime waarde (API-sleutel, tokens, wachtwoord-hash,
 *    DATABASE_URL) wordt uit alle teksten weggepoetst, ook als hij per
 *    ongeluk in een foutmelding of URL terechtkomt.
 */

export interface Logger {
  debug(bericht: string, velden?: Record<string, unknown>): void;
  info(bericht: string, velden?: Record<string, unknown>): void;
  warn(bericht: string, velden?: Record<string, unknown>): void;
  error(bericht: string, velden?: Record<string, unknown>): void;
}

export interface LoggerOpties {
  niveau: LogLevel;
  /** Waarden die nooit in de uitvoer mogen verschijnen. */
  geheimen?: readonly string[];
  /** Standaard: stdout. Tests vangen regels op. */
  schrijf?: (regel: string) => void;
  /** Standaard: systeemtijd. */
  nu?: () => Date;
}

export const AFGESCHERMD = '[afgeschermd]';

const RANG: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const GEHEIME_VELDNAAM =
  /(key|token|secret|passw|wachtwoord|hash|database_?url|authorization|cookie|dsn)/i;
/** Korte waarden (bv. "k" in tests) zouden willekeurige tekst verminken. */
const MIN_GEHEIM_LENGTE = 6;

export function maakLogger(opties: LoggerOpties): Logger {
  const drempel = RANG[opties.niveau];
  const schrijf = opties.schrijf ?? ((regel: string) => process.stdout.write(`${regel}\n`));
  const nu = opties.nu ?? (() => new Date());
  const geheimen = (opties.geheimen ?? [])
    .filter((g) => g.length >= MIN_GEHEIM_LENGTE)
    .sort((a, b) => b.length - a.length);

  const poets = (tekst: string): string => {
    let uit = tekst;
    for (const g of geheimen) uit = uit.split(g).join(AFGESCHERMD);
    return uit;
  };

  const log = (niveau: LogLevel, bericht: string, velden?: Record<string, unknown>): void => {
    if (RANG[niveau] < drempel) return;
    const regel = {
      tijd: nu().toISOString(),
      niveau,
      bericht: poets(bericht),
      ...(velden ? (schoon(velden, poets, 0) as Record<string, unknown>) : {}),
    };
    schrijf(JSON.stringify(regel));
  };

  return {
    debug: (b, v) => log('debug', b, v),
    info: (b, v) => log('info', b, v),
    warn: (b, v) => log('warn', b, v),
    error: (b, v) => log('error', b, v),
  };
}

function schoon(waarde: unknown, poets: (t: string) => string, diepte: number): unknown {
  if (diepte > 6) return '[te diep]';
  if (typeof waarde === 'string') return poets(waarde);
  if (waarde instanceof Error) {
    return { naam: waarde.name, bericht: poets(waarde.message) };
  }
  if (waarde instanceof Date) return waarde.toISOString();
  if (Array.isArray(waarde)) return waarde.map((w) => schoon(w, poets, diepte + 1));
  if (waarde && typeof waarde === 'object') {
    const uit: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(waarde)) {
      uit[k] = GEHEIME_VELDNAAM.test(k) ? AFGESCHERMD : schoon(v, poets, diepte + 1);
    }
    return uit;
  }
  return waarde;
}

/** Logger die niets doet; handig als standaard in tests. */
export const stilleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
