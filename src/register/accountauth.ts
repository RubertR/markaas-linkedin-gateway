import type { Backend } from '../db/backend.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { UnipileClient } from '../unipile/client.ts';
import {
  UnipileAccountBeperktFout,
  UnipileAccountCredentialsFout,
  UnipileFunctieNietInAbonnementFout,
  UnipileGatewayAuthFout,
  UnipileOnbekendeAuthFout,
  type UnipileAccountAuthFout,
} from '../unipile/errors.ts';

import type { Account } from './accounts.ts';
import { statusStrengte, type AccountStatus } from './status.ts';

/**
 * Gevolgen van een 401/403 van Unipile voor één account (SPEC §6a). De
 * classificatie zelf zit in `src/unipile/` (foutklassen); hier staat wat de
 * gateway daarmee doet. De worker (dus ook de planner en de synchrone
 * MCP-tools) en de verzoeken-sync gebruiken allemaal deze functie.
 *
 * | Fout                                 | Gevolg                                             |
 * | ------------------------------------ | -------------------------------------------------- |
 * | UnipileAccountCredentialsFout        | account → CREDENTIALS, reconnect-link              |
 * | UnipileAccountBeperktFout            | account → STOPPED, géén reconnect-link             |
 * | UnipileFunctieNietInAbonnementFout   | alleen de actie mislukt; account blijft OK         |
 * | UnipileOnbekendeAuthFout             | controle-aanroep: kapot → gateway stopt;           |
 * |                                      | lukt → account → ERROR met status en type          |
 *
 * Per account hoogstens één controle-aanroep per
 * `unipile_controle.min_interval_minuten` (config/limits.json); daarbinnen
 * geldt de uitkomst van de laatste controle. De controles staan als
 * gateway-event `unipile_controle` in de events-tabel, met het moment van de
 * Klok, zodat het ook over meerdere workers en herstarts heen klopt.
 *
 * Elke statuswijziging komt als gateway-event `account_status` in de
 * events-tabel. De gateway verlaagt nooit een strengere status
 * (`STOPPED` > `ERROR` > `CREDENTIALS`).
 */

export interface AccountAuthDeps {
  db: Backend;
  unipile: UnipileClient;
  klok: Klok;
  limieten: Limieten;
  /** Maakt een reconnect-link (src/register/koppelflow). Best-effort. */
  reconnectHook?: (accountId: string) => Promise<void>;
}

export type AccountAuthGevolg =
  | 'credentials'
  | 'gestopt'
  | 'functie_ontbreekt'
  | 'account_fout'
  | 'gateway_kapot'
  | 'controle_mislukt';

export interface AccountAuthUitkomst {
  gevolg: AccountAuthGevolg;
  /** NL-reden voor de actie, de skill en de goedkeuringspagina. */
  reden: string;
}

export interface AccountAuthOpties {
  /** `false` = dry-run: niets schrijven (geen status, geen events). Standaard `true`. */
  schrijven?: boolean;
}

export const FUNCTIE_NIET_IN_ABONNEMENT_TEKST =
  'functie zit niet in het LinkedIn-abonnement van dit account';

export async function verwerkAccountAuthFout(
  deps: AccountAuthDeps,
  account: Account,
  err: UnipileAccountAuthFout,
  opties: AccountAuthOpties = {},
): Promise<AccountAuthUitkomst> {
  const schrijven = opties.schrijven !== false;
  const nu = deps.klok.nu();

  if (err instanceof UnipileAccountCredentialsFout) {
    const reden =
      `LinkedIn-sessie van dit account werkt niet (${err.code}${err.status ? `, HTTP ${err.status}` : ''}); ` +
      'alleen dit account op CREDENTIALS gezet en een reconnect-link aangemaakt. Andere accounts lopen door.';
    if (schrijven) {
      const gewijzigd = await zetAccountStatusDoorGateway(
        deps.db,
        account.id,
        'CREDENTIALS',
        { reden, ...httpDetails(err.status, `errors/${err.code}`, err.endpoint) },
        nu,
      );
      if (gewijzigd && deps.reconnectHook) {
        try {
          await deps.reconnectHook(account.id);
        } catch {
          /* best-effort; de account_status-webhook geeft normaal ook een link. */
        }
      }
    }
    return { gevolg: 'credentials', reden };
  }

  if (err instanceof UnipileAccountBeperktFout) {
    const reden =
      `LinkedIn heeft dit account beperkt (${err.foutType}); alleen dit account op STOPPED gezet, zonder reconnect-link. ` +
      'De eigenaar moet eerst zelf in LinkedIn kijken; daarna heractiveert Rubert het account.';
    if (schrijven) {
      await zetAccountStatusDoorGateway(
        deps.db,
        account.id,
        'STOPPED',
        { reden, ...httpDetails(err.status, err.foutType, err.endpoint) },
        nu,
      );
    }
    return { gevolg: 'gestopt', reden };
  }

  if (err instanceof UnipileFunctieNietInAbonnementFout) {
    return {
      gevolg: 'functie_ontbreekt',
      reden:
        `Deze ${FUNCTIE_NIET_IN_ABONNEMENT_TEKST} (${err.foutType}). ` +
        'De actie is mislukt en telt mee in het budget; het account blijft actief. Kies een functie die bij het abonnement past.',
    };
  }

  if (err instanceof UnipileOnbekendeAuthFout) {
    return await verwerkOnbekend(deps, account, err, schrijven, nu);
  }

  // Exhaustief; TypeScript bewaakt dat hier niets meer overblijft.
  const nooit: never = err;
  throw new Error(`Onbekende auth-fout: ${String(nooit)}`);
}

type ControleUitkomst = 'sleutel_ok' | 'sleutel_kapot' | 'onbeslist';

interface ControleResultaat {
  uitkomst: ControleUitkomst;
  detail?: string;
}

async function verwerkOnbekend(
  deps: AccountAuthDeps,
  account: Account,
  err: UnipileOnbekendeAuthFout,
  schrijven: boolean,
  nu: Date,
): Promise<AccountAuthUitkomst> {
  const typeTekst = err.foutType ? `type ${err.foutType}` : 'zonder type';
  const controle = await controleerMetLimiet(deps, account.id, schrijven, nu);

  if (controle.uitkomst === 'sleutel_kapot') {
    return {
      gevolg: 'gateway_kapot',
      reden:
        `Gateway-API-sleutel afgewezen door Unipile (HTTP ${err.status ?? '?'} ${typeTekst} op ${err.endpoint}, ` +
        'en ook de controle-aanroep werd geweigerd); alles stilgezet voor onderzoek door Rubert.',
    };
  }
  if (controle.uitkomst === 'onbeslist') {
    return {
      gevolg: 'controle_mislukt',
      reden:
        `Unipile weigerde de aanvraag (HTTP ${err.status ?? '?'} ${typeTekst}) en de controle-aanroep gaf geen uitsluitsel` +
        `${controle.detail ? ` (${controle.detail})` : ''}. Account ongewijzigd; de actie wordt later opnieuw geprobeerd.`,
    };
  }
  const reden =
    `Unipile weigerde de aanvraag voor dit account (HTTP ${err.status ?? '?'}, ${typeTekst}, op ${err.endpoint}), ` +
    'maar de gateway-sleutel werkt (controle-aanroep geslaagd). Alleen dit account op ERROR; Rubert zoekt de oorzaak uit.';
  if (schrijven) {
    await zetAccountStatusDoorGateway(
      deps.db,
      account.id,
      'ERROR',
      { reden, ...httpDetails(err.status, err.foutType, err.endpoint) },
      nu,
    );
  }
  return { gevolg: 'account_fout', reden };
}

/**
 * Doet de controle-aanroep, tenzij er voor dit account binnen het interval al
 * een was: dan geldt de uitkomst van die laatste controle.
 */
async function controleerMetLimiet(
  deps: AccountAuthDeps,
  accountId: string,
  schrijven: boolean,
  nu: Date,
): Promise<ControleResultaat> {
  const intervalMs = deps.limieten.unipile_controle.min_interval_minuten * 60_000;
  const grens = new Date(nu.getTime() - intervalMs);
  const eerder = await deps.db.query<{ payload: unknown }>(
    `select payload from events
     where bron = 'gateway' and type = 'unipile_controle' and account_id = $1
       and (payload ->> 'op')::timestamptz > $2::timestamptz
       and (payload ->> 'op')::timestamptz <= $3::timestamptz
     order by (payload ->> 'op')::timestamptz desc
     limit 1`,
    [accountId, grens.toISOString(), nu.toISOString()],
  );
  const vorige = leesControle(eerder[0]?.payload);
  if (vorige) return vorige;

  let resultaat: ControleResultaat;
  try {
    await deps.unipile.controleerGatewaySleutel();
    resultaat = { uitkomst: 'sleutel_ok' };
  } catch (fout) {
    resultaat =
      fout instanceof UnipileGatewayAuthFout
        ? { uitkomst: 'sleutel_kapot', detail: fout.message }
        : { uitkomst: 'onbeslist', detail: (fout as Error)?.message ?? String(fout) };
  }
  if (schrijven) {
    await deps.db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('gateway', 'unipile_controle', $1, $2, $3::text::jsonb)
       on conflict (bron, extern_id) where extern_id is not null do nothing`,
      [
        `unipile_controle:${accountId}:${nu.toISOString()}`,
        accountId,
        JSON.stringify({ op: nu.toISOString(), ...resultaat }),
      ],
    );
  }
  return resultaat;
}

function leesControle(payload: unknown): ControleResultaat | null {
  const obj = typeof payload === 'string' ? safeParse(payload) : payload;
  if (!obj || typeof obj !== 'object') return null;
  const uitkomst = (obj as { uitkomst?: unknown }).uitkomst;
  if (uitkomst !== 'sleutel_ok' && uitkomst !== 'sleutel_kapot' && uitkomst !== 'onbeslist') {
    return null;
  }
  const detail = (obj as { detail?: unknown }).detail;
  return typeof detail === 'string' ? { uitkomst, detail } : { uitkomst };
}

function safeParse(tekst: string): unknown {
  try {
    return JSON.parse(tekst);
  } catch {
    return null;
  }
}

function httpDetails(
  status: number | undefined,
  foutType: string | undefined,
  endpoint: string,
): Omit<GatewayStatusDetails, 'reden'> {
  return {
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(foutType !== undefined ? { foutType } : {}),
    endpoint,
  };
}

export interface GatewayStatusDetails {
  reden: string;
  httpStatus?: number;
  foutType?: string;
  endpoint?: string;
}

/**
 * Zet de status van één account vanuit de gateway en legt dat vast als
 * gateway-event `account_status` (dedup-veilig). Verlaagt nooit een
 * strengere status (`STOPPED` > `ERROR` > `CREDENTIALS`) en doet niets als de
 * status al zo staat. Geeft `true` als de status echt is gewijzigd.
 *
 * Status en event gaan in één transactie, zodat `events.ontvangen_op` gelijk
 * is aan `accounts.status_sinds`: zo herkent de webhook dat deze status van de
 * gateway komt (`statusDoorGatewayGezet`).
 */
export async function zetAccountStatusDoorGateway(
  db: Backend,
  accountId: string,
  status: AccountStatus,
  details: GatewayStatusDetails,
  nu: Date,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rijen = await tx.query<{ status: AccountStatus }>(
      `select status from accounts where id = $1 for update`,
      [accountId],
    );
    const huidig = rijen[0]?.status;
    if (!huidig) return false;
    if (huidig === status) return false;
    if (statusStrengte(status) < statusStrengte(huidig)) return false;
    await tx.query(
      `update accounts set status = $2::account_status, status_sinds = now() where id = $1`,
      [accountId, status],
    );
    const payload = {
      status,
      vorige_status: huidig,
      reden: details.reden,
      ...(details.httpStatus !== undefined ? { http_status: details.httpStatus } : {}),
      ...(details.foutType !== undefined ? { fout_type: details.foutType } : {}),
      ...(details.endpoint !== undefined ? { endpoint: details.endpoint } : {}),
      op: nu.toISOString(),
    };
    await tx.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('gateway', 'account_status', $1, $2, $3::text::jsonb)
       on conflict (bron, extern_id) where extern_id is not null do nothing`,
      [`account_status:${accountId}:${status}:${nu.toISOString()}`, accountId, JSON.stringify(payload)],
    );
    return true;
  });
}

/**
 * Is de huidige status van dit account door de gateway gezet (en sindsdien
 * niet meer gewijzigd)? Dan staat er een gateway-event `account_status` met
 * die status van op of na `status_sinds`.
 */
export async function statusDoorGatewayGezet(db: Backend, accountId: string): Promise<boolean> {
  const rijen = await db.query<{ ja: number }>(
    `select 1 as ja from events e
     join accounts a on a.id = e.account_id
     where e.account_id = $1
       and e.bron = 'gateway' and e.type = 'account_status'
       and e.payload ->> 'status' = a.status::text
       and e.ontvangen_op >= a.status_sinds
     limit 1`,
    [accountId],
  );
  return rijen.length > 0;
}
