export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnvironment = 'development' | 'production';

export interface Env {
  unipileDsn: string;
  unipileApiKey: string;
  webhookSecret: string;
  mcpToken: string;
  adminPasswordHash: string;
  databaseUrl: string;
  port: number;
  logLevel: LogLevel;
  timezoneDefault: string;
  nodeEnv: NodeEnvironment;
  /** Planner-lus aan/uit. Standaard uit; alleen `PLANNER_ENABLED=true` zet hem aan. */
  plannerEnabled: boolean;
  /**
   * Publieke basis-URL van de gateway (zonder slash aan het eind), voor de
   * `notify_url` in koppellinks. Valt terug op Railway's `RAILWAY_PUBLIC_DOMAIN`
   * en daarna op `http://localhost:<PORT>`.
   */
  publicBaseUrl: string;
  /**
   * Stripe (SPEC §14.4). `null` = betalen is nog niet ingericht: portaal en
   * admin tonen dan een melding en de Stripe-webhook antwoordt 503.
   */
  stripe: StripeEnv | null;
  /** Namen van Stripe-variabelen die ontbreken terwijl andere wél gezet zijn. */
  stripeOntbrekend: string[];
}

export interface StripeEnv {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
}

/** Optioneel; alleen samen actief (alle drie gezet). */
export const STRIPE_VARIABELEN = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID'] as const;

/** Variabelen zonder standaardwaarde; de gateway start niet zonder. */
export const VERPLICHTE_VARIABELEN = [
  'UNIPILE_DSN',
  'UNIPILE_API_KEY',
  'WEBHOOK_SECRET',
  'MCP_TOKEN',
  'ADMIN_PASSWORD_HASH',
  'DATABASE_URL',
] as const;

type VerplichteNaam = (typeof VERPLICHTE_VARIABELEN)[number];

type Bron = Record<string, string | undefined>;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;
const NODE_ENVS: readonly NodeEnvironment[] = ['development', 'production'] as const;

export class EnvFout extends Error {
  /** Eén Nederlandse melding per probleem; bevat namen, nooit waarden. */
  readonly meldingen: readonly string[];

  constructor(meldingen: string | readonly string[]) {
    const lijst = typeof meldingen === 'string' ? [meldingen] : meldingen;
    super(lijst.join('\n'));
    this.name = 'EnvFout';
    this.meldingen = lijst;
  }
}

/**
 * Leest en controleert alle omgevingsvariabelen in één keer. Ontbreken er
 * meerdere, dan noemt de fout ze allemaal (één regel per variabele), zodat
 * je ze in één ronde kunt aanvullen. Waarden komen nooit in de melding.
 */
export function leesEnv(bron: Bron = process.env): Env {
  const meldingen: string[] = [];
  const verplicht = {} as Record<VerplichteNaam, string>;
  for (const naam of VERPLICHTE_VARIABELEN) {
    const waarde = bron[naam];
    if (waarde === undefined || waarde.trim() === '') {
      meldingen.push(
        `Omgevingsvariabele ${naam} ontbreekt of is leeg. Zet hem in .env (lokaal) of in de Railway-variabelen (zie .env.example).`,
      );
    } else {
      verplicht[naam] = waarde;
    }
  }

  const port = verzamel(meldingen, () => leesPoort(bron, 'PORT', 3000), 3000);
  const logLevel = verzamel(meldingen, () => leesLijst(bron, 'LOG_LEVEL', LOG_LEVELS, 'info'), 'info');
  const nodeEnv = verzamel(
    meldingen,
    () => leesLijst(bron, 'NODE_ENV', NODE_ENVS, 'development'),
    'development',
  );
  const plannerEnabled = verzamel(meldingen, () => leesBoolean(bron, 'PLANNER_ENABLED'), false);
  const publicBaseUrl = verzamel(meldingen, () => leesPublicBaseUrl(bron, port), '');

  if (meldingen.length > 0) throw new EnvFout(meldingen);

  const stripeWaarden = STRIPE_VARIABELEN.map((naam) => bron[naam]?.trim() ?? '');
  const stripeOntbrekend = STRIPE_VARIABELEN.filter((_, i) => stripeWaarden[i] === '');
  const stripe: StripeEnv | null =
    stripeOntbrekend.length === 0
      ? { secretKey: stripeWaarden[0]!, webhookSecret: stripeWaarden[1]!, priceId: stripeWaarden[2]! }
      : null;

  return {
    unipileDsn: verplicht.UNIPILE_DSN,
    unipileApiKey: verplicht.UNIPILE_API_KEY,
    webhookSecret: verplicht.WEBHOOK_SECRET,
    mcpToken: verplicht.MCP_TOKEN,
    adminPasswordHash: verplicht.ADMIN_PASSWORD_HASH,
    databaseUrl: verplicht.DATABASE_URL,
    port,
    logLevel,
    timezoneDefault: bron['TIMEZONE_DEFAULT']?.trim() || 'Europe/Amsterdam',
    nodeEnv,
    plannerEnabled,
    publicBaseUrl,
    stripe,
    stripeOntbrekend:
      stripeOntbrekend.length === STRIPE_VARIABELEN.length ? [] : [...stripeOntbrekend],
  };
}

function verzamel<T>(meldingen: string[], lees: () => T, terugval: T): T {
  try {
    return lees();
  } catch (err) {
    if (!(err instanceof EnvFout)) throw err;
    meldingen.push(...err.meldingen);
    return terugval;
  }
}

/** Alleen de exacte tekst `true` zet een vlag aan; leeg of afwezig is `false`. */
function leesBoolean(bron: Bron, naam: string): boolean {
  const waarde = bron[naam]?.trim().toLowerCase();
  if (!waarde || waarde === 'false') return false;
  if (waarde === 'true') return true;
  throw new EnvFout(`Omgevingsvariabele ${naam} moet "true" of "false" zijn.`);
}

function leesPublicBaseUrl(bron: Bron, port: number): string {
  const expliciet = bron['PUBLIC_BASE_URL']?.trim();
  if (expliciet) {
    let url: URL;
    try {
      url = new URL(expliciet);
    } catch {
      throw new EnvFout(
        'Omgevingsvariabele PUBLIC_BASE_URL is geen geldige URL; gebruik bijvoorbeeld https://gateway.markaas.nl.',
      );
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new EnvFout('Omgevingsvariabele PUBLIC_BASE_URL moet met https:// beginnen.');
    }
    return expliciet.replace(/\/+$/, '');
  }
  const railway = bron['RAILWAY_PUBLIC_DOMAIN']?.trim();
  if (railway) return `https://${railway}`;
  return `http://localhost:${port}`;
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
