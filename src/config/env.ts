export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnvironment = 'development' | 'production';

export interface Env {
  unipileDsn: string;
  unipileApiKey: string;
  webhookSecret: string;
  databaseUrl: string;
  port: number;
  logLevel: LogLevel;
  timezoneDefault: string;
  nodeEnv: NodeEnvironment;
}

type Bron = Record<string, string | undefined>;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;
const NODE_ENVS: readonly NodeEnvironment[] = ['development', 'production'] as const;

export class EnvFout extends Error {
  constructor(bericht: string) {
    super(bericht);
    this.name = 'EnvFout';
  }
}

export function leesEnv(bron: Bron = process.env): Env {
  return {
    unipileDsn: verplicht(bron, 'UNIPILE_DSN'),
    unipileApiKey: verplicht(bron, 'UNIPILE_API_KEY'),
    webhookSecret: verplicht(bron, 'WEBHOOK_SECRET'),
    databaseUrl: verplicht(bron, 'DATABASE_URL'),
    port: leesPoort(bron, 'PORT', 3000),
    logLevel: leesLijst(bron, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    timezoneDefault: bron['TIMEZONE_DEFAULT']?.trim() || 'Europe/Amsterdam',
    nodeEnv: leesLijst(bron, 'NODE_ENV', NODE_ENVS, 'development'),
  };
}

function verplicht(bron: Bron, naam: string): string {
  const waarde = bron[naam];
  if (waarde === undefined || waarde.trim() === '') {
    throw new EnvFout(
      `Omgevingsvariabele ${naam} ontbreekt of is leeg. Zet hem in .env (zie .env.example).`,
    );
  }
  return waarde;
}

function leesPoort(bron: Bron, naam: string, standaard: number): number {
  const waarde = bron[naam];
  if (waarde === undefined || waarde.trim() === '') return standaard;
  const getal = Number(waarde);
  if (!Number.isInteger(getal) || getal <= 0 || getal > 65535) {
    throw new EnvFout(
      `Omgevingsvariabele ${naam} moet een geheel getal tussen 1 en 65535 zijn.`,
    );
  }
  return getal;
}

function leesLijst<T extends string>(
  bron: Bron,
  naam: string,
  toegestaan: readonly T[],
  standaard: T,
): T {
  const waarde = bron[naam]?.trim();
  if (!waarde) return standaard;
  if (!toegestaan.includes(waarde as T)) {
    throw new EnvFout(
      `Omgevingsvariabele ${naam} moet één van [${toegestaan.join(', ')}] zijn.`,
    );
  }
  return waarde as T;
}
