import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

import type { UnipileClient, WebhookBron } from '../unipile/client.ts';
import {
  UnipileFout,
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
} from '../unipile/errors.ts';

import { WEBHOOK_SECRET_HEADER } from './geheim.ts';

/**
 * Registreert de Unipile-webhooks van de gateway (`npm run webhooks:registreer`).
 * Idempotent op naam; standaard een dry-run. Zie docs/unipile-notities.md §Webhooks.
 */

export interface WebhookDefinitie {
  naam: string;
  bron: WebhookBron;
  events: readonly string[];
}

export const GATEWAY_WEBHOOKS: readonly WebhookDefinitie[] = [
  {
    naam: 'gateway-accountstatus',
    bron: 'account_status',
    // Bewust niet: creation_success/creation_fail (komen via de koppel-callback),
    // sync_success en connecting (geen actie nodig).
    events: ['ok', 'error', 'credentials', 'permissions', 'stopped', 'reconnected', 'deleted'],
  },
  { naam: 'gateway-messaging', bron: 'messaging', events: ['message_received'] },
  { naam: 'gateway-relaties', bron: 'users', events: ['new_relation'] },
];

export type WebhookActie = 'aangemaakt' | 'zou_aanmaken' | 'bestaat_al';

export interface WebhookRegel extends WebhookDefinitie {
  actie: WebhookActie;
  webhookId?: string;
  waarschuwing?: string;
}

export class WebhookRegistratieFout extends Error {
  /** Namen van webhooks die vóór de fout al wél zijn aangemaakt. */
  readonly aangemaakt: readonly string[];

  constructor(bericht: string, aangemaakt: readonly string[]) {
    super(bericht);
    this.name = 'WebhookRegistratieFout';
    this.aangemaakt = aangemaakt;
  }
}

export async function registreerWebhooks(
  client: UnipileClient,
  opties: { requestUrl: string; geheim: string; uitvoeren: boolean },
): Promise<WebhookRegel[]> {
  const aangemaakt: string[] = [];
  try {
    const bestaande = await client.haalWebhooks();
    const regels: WebhookRegel[] = [];
    for (const def of GATEWAY_WEBHOOKS) {
      const gevonden = bestaande.find((w) => w.name === def.naam);
      if (gevonden) {
        const regel: WebhookRegel = { ...def, actie: 'bestaat_al', webhookId: gevonden.id };
        if (gevonden.request_url && gevonden.request_url !== opties.requestUrl) {
          regel.waarschuwing = `wijst naar een andere URL (${gevonden.request_url}); niet aangepast.`;
        }
        regels.push(regel);
        continue;
      }
      if (!opties.uitvoeren) {
        regels.push({ ...def, actie: 'zou_aanmaken' });
        continue;
      }
      const { webhookId } = await client.maakWebhook({
        naam: def.naam,
        requestUrl: opties.requestUrl,
        bron: def.bron,
        events: [...def.events],
        headers: { [WEBHOOK_SECRET_HEADER]: opties.geheim },
      });
      aangemaakt.push(def.naam);
      regels.push({ ...def, actie: 'aangemaakt', webhookId });
    }
    return regels;
  } catch (err) {
    throw new WebhookRegistratieFout(maskeer(foutmelding(err, aangemaakt), [opties.geheim]), aangemaakt);
  }
}

function foutmelding(err: unknown, aangemaakt: readonly string[]): string {
  const al = aangemaakt.length > 0 ? ` Al aangemaakt: ${aangemaakt.join(', ')}.` : ' Er is niets aangemaakt.';
  const opnieuw = ' Opnieuw draaien is veilig: bestaande webhooks worden op naam overgeslagen.';
  if (err instanceof UnipileGatewayAuthFout) {
    return `Unipile weigert de API-sleutel (HTTP ${err.status}): het Access Token in het env-bestand is ongeldig, verlopen of hoort niet bij deze DSN.${al} Controleer UNIPILE_API_KEY en UNIPILE_DSN.`;
  }
  if (err instanceof UnipileTimeoutFout) {
    return `Unipile antwoordde niet op tijd (${err.endpoint}).${al} Bij een time-out op het aanmaken kan de webhook toch bestaan; controleer dat met een dry-run.${opnieuw}`;
  }
  if (err instanceof UnipileTijdelijkeFout) {
    const wacht = err.retryAfterSeconden !== undefined ? `${err.retryAfterSeconden} seconden` : 'een paar minuten';
    const oorzaak = err.status === 429 ? 'Unipile vroeg om te vertragen (HTTP 429)' : 'Unipile is tijdelijk niet bereikbaar';
    return `${oorzaak}.${al} Probeer het over ${wacht} opnieuw.${opnieuw}`;
  }
  if (err instanceof UnipileFout) return `${err.message}${al}${opnieuw}`;
  return `Onverwachte fout: ${err instanceof Error ? err.message : String(err)}.${al}${opnieuw}`;
}

/** Vervangt elk geheim in de tekst door sterretjes. */
export function maskeer(tekst: string, geheimen: readonly string[]): string {
  let uit = tekst;
  for (const g of geheimen) if (g) uit = uit.split(g).join('********');
  return uit;
}

const ACTIE_TEKST: Record<WebhookActie, string> = {
  aangemaakt: 'aangemaakt',
  zou_aanmaken: 'zou worden aangemaakt',
  bestaat_al: 'bestaat al, overgeslagen',
};

/** Leesbaar overzicht; het geheim staat er nooit in, alleen sterretjes. */
export function beschrijf(
  regels: readonly WebhookRegel[],
  opties: { requestUrl: string; uitvoeren: boolean },
): string {
  const uit: string[] = [
    opties.uitvoeren ? 'Webhooks registreren:' : 'Dry-run — er wordt niets aangemaakt:',
    `  URL:    ${opties.requestUrl}`,
    `  Header: ${WEBHOOK_SECRET_HEADER}: ********`,
    '  Accounts: alle huidige en toekomstige (geen account_ids)',
    '',
  ];
  for (const r of regels) {
    const id = r.webhookId ? ` [${r.webhookId}]` : '';
    uit.push(`- ${r.naam} (source ${r.bron}): ${ACTIE_TEKST[r.actie]}${id}`);
    uit.push(`    events: ${r.events.join(', ')}`);
    if (r.waarschuwing) uit.push(`    LET OP: ${r.waarschuwing}`);
  }
  if (!opties.uitvoeren && regels.some((r) => r.actie === 'zou_aanmaken')) {
    uit.push('', 'Draai opnieuw met --uitvoeren om ze echt aan te maken.');
  }
  return uit.join('\n');
}

export interface WebhookEnv {
  unipileDsn: string;
  unipileApiKey: string;
  webhookSecret: string;
}

/**
 * Leest DSN, API-sleutel en WEBHOOK_SECRET uit één env-bestand (niet uit
 * process.env), zodat productiewaarden tijdelijk in bijv. `.env.railway`
 * kunnen staan. Meldingen noemen alleen namen, nooit waarden.
 */
export async function leesEnvBestand(pad: string): Promise<WebhookEnv> {
  let inhoud: string;
  try {
    inhoud = await readFile(pad, 'utf8');
  } catch {
    throw new Error(`Env-bestand ${pad} niet gevonden of kan het niet lezen. Geef het juiste pad op met --env-file.`);
  }
  const waarden = parseEnv(inhoud);
  const namen = ['UNIPILE_DSN', 'UNIPILE_API_KEY', 'WEBHOOK_SECRET'] as const;
  const ontbreekt = namen.filter((n) => !waarden[n]?.trim());
  if (ontbreekt.length > 0) {
    throw new Error(`In ${pad} ontbreekt of is leeg: ${ontbreekt.join(', ')}. Vul ze aan en draai opnieuw.`);
  }
  return {
    unipileDsn: waarden['UNIPILE_DSN']!.trim(),
    unipileApiKey: waarden['UNIPILE_API_KEY']!.trim(),
    webhookSecret: waarden['WEBHOOK_SECRET']!.trim(),
  };
}

/**
 * Volledige scriptflow. Volgorde is bewust: eerst argumenten, dan het
 * env-bestand, pas daarna een client — elke invoerfout stopt dus vóór er
 * één verzoek naar Unipile gaat. Geeft het (gemaskeerde) overzicht terug;
 * fouten worden gemaskeerd doorgegooid.
 */
export async function draaiRegistratie(
  argv: readonly string[],
  deps: { requestUrl: string; maakClient: (env: WebhookEnv) => UnipileClient },
): Promise<string> {
  const { envBestand, uitvoeren } = parseerArgumenten(argv);
  const env = await leesEnvBestand(envBestand);
  const geheimen = [env.unipileApiKey, env.webhookSecret];
  try {
    const regels = await registreerWebhooks(deps.maakClient(env), {
      requestUrl: deps.requestUrl,
      geheim: env.webhookSecret,
      uitvoeren,
    });
    const kop = `Env-bestand: ${envBestand} (DSN ${env.unipileDsn})`;
    return maskeer(`${kop}\n${beschrijf(regels, { requestUrl: deps.requestUrl, uitvoeren })}`, geheimen);
  } catch (err) {
    const bericht = err instanceof Error ? err.message : String(err);
    throw new Error(maskeer(bericht, geheimen));
  }
}

const GEBRUIK =
  'Gebruik: npm run webhooks:registreer -- [--env-file <pad>] [--dry-run | --uitvoeren]';

export function parseerArgumenten(argv: readonly string[]): {
  envBestand: string;
  uitvoeren: boolean;
} {
  let envBestand = '.env';
  let uitvoeren = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--uitvoeren') uitvoeren = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--env-file=')) envBestand = arg.slice('--env-file='.length);
    else if (arg === '--env-file') {
      const waarde = argv[i + 1];
      if (!waarde || waarde.startsWith('--')) throw new Error(`Optie --env-file heeft geen pad.\n${GEBRUIK}`);
      envBestand = waarde;
      i++;
    } else throw new Error(`Onbekende optie ${arg}.\n${GEBRUIK}`);
  }
  if (!envBestand.trim()) throw new Error(`Optie --env-file heeft geen pad.\n${GEBRUIK}`);
  if (dryRun && uitvoeren) {
    throw new Error(`Kies --dry-run of --uitvoeren, niet allebei.\n${GEBRUIK}`);
  }
  return { envBestand, uitvoeren };
}
