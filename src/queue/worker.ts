import type { Backend } from '../db/backend.ts';
import { startAfkoeling } from '../budget/afkoeling.ts';
import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import { telInviteAlsOpenstaand } from '../budget/openstaand.ts';
import { verlagingNaUnipileSignaal } from '../budget/opbouw.ts';
import { vindAccount, werkAccountStatusBij } from '../register/accounts.ts';
import type { Account } from '../register/accounts.ts';
import type { UnipileClient } from '../unipile/client.ts';
import {
  Unipile422Fout,
  UnipileAccountCredentialsFout,
  UnipileFout,
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
  type Unipile422Code,
} from '../unipile/errors.ts';

import {
  zetActieStatus,
  type Actie,
  type ActieStatus,
} from './acties.ts';

/**
 * Worker: voert één gereserveerde actie uit via `src/unipile/`, slaat het
 * antwoord op, en vertaalt fouten naar actie-/account-status volgens SPEC §5
 * en docs/fase-2-plan.md §3.4.
 *
 * - 429 of 422 `limit_exceeded` / `connection_limit_reached` → account in
 *   afkoeling (48u), actie terug naar `queued`.
 * - UnipileAccountCredentialsFout → alleen dit account naar `CREDENTIALS` en
 *   `reconnectHook` aanroepen; actie terug naar `queued`.
 * - UnipileGatewayAuthFout (401/403) → signaal `gatewayAuthFout: true` zodat
 *   de planner alles stopt; account blijft ongewijzigd (het is onze API-sleutel).
 * - Overige 422 → `failed` (permanent, NL-reden).
 * - Timeout bij `invite`/`message`/`inmail` → status `onzeker`: LinkedIn
 *   kan het verzoek wél hebben verstuurd; automatisch opnieuw proberen
 *   zou dubbele verzending naar dezelfde persoon betekenen. Een event
 *   komt in de events-tabel zodat Rubert handmatig in LinkedIn kan
 *   controleren en de actie op `done` of opnieuw `approved` zet. Budget
 *   blijft verbruikt en een invite telt mee in `openstaande_verzoeken`.
 * - Timeout bij `search`/`profile` → `queued` + 5 minuten; herhaaldelijk
 *   lezen is onschadelijk.
 * - Succes → `done`, antwoord in `unipile_response`; een invite verhoogt in
 *   dezelfde transactie `openstaande_verzoeken`. Unipile-usage-signaal
 *   ≥ 75% verlaagt opbouw_factor en vraagt de planner dit actietype vandaag
 *   te stoppen.
 */

export interface WorkerContext {
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  /**
   * Hook die een reconnect-link aanmaakt (via src/register/koppelflow). De
   * worker roept hem aan bij een account-credentials-fout zodat de klant
   * meteen een link krijgt om opnieuw te koppelen.
   */
  reconnectHook?: (accountId: string) => Promise<void>;
}

export interface WorkerUitkomst {
  status: Extract<ActieStatus, 'done' | 'failed' | 'queued' | 'onzeker'>;
  reden: string | null;
  response?: Record<string, unknown>;
  usageSignaalPercentage?: number;
  typeDagStop?: boolean;
  /** Alleen dit account pauzeren (CREDENTIALS); andere accounts blijven lopen. */
  alleenDitAccountPauzeren?: boolean;
  /** Signaal naar planner: gateway-sleutel is kapot, stop alles. */
  gatewayAuthFout?: boolean;
}

const UITVOER_TIME_OUT_HERPLANNING_SECONDEN = 300;

/**
 * Actietypes die iets naar een persoon versturen. Bij een time-out op deze
 * types weten we niet of LinkedIn het verzoek wél of niet heeft ontvangen;
 * automatisch opnieuw sturen zou dubbele uitnodigingen of berichten
 * veroorzaken.
 */
const VERZEND_TYPES: ReadonlySet<Actie['type']> = new Set(['invite', 'message', 'inmail']);

const PERMANENTE_422: ReadonlySet<Unipile422Code> = new Set([
  'already_invited_recently',
  'already_connected',
  'cannot_resend_yet',
  'insufficient_credits',
  'not_allowed_inmail',
  'user_unreachable',
]);

const LIMIET_422: ReadonlySet<Unipile422Code> = new Set([
  'limit_exceeded',
  'connection_limit_reached',
]);

export async function voerActieUit(ctx: WorkerContext, actie: Actie): Promise<WorkerUitkomst> {
  const account = await vindAccount(ctx.db, actie.accountId);
  if (!account) {
    const reden = `Account ${actie.accountId} bestaat niet; actie kan niet worden uitgevoerd.`;
    await persisteer(ctx.db, actie.id, 'failed', { reden });
    return { status: 'failed', reden };
  }
  if (!account.unipileAccountId) {
    const reden =
      'Account mist unipile_account_id (nog niet gekoppeld); eerst koppelen voordat acties lopen.';
    await persisteer(ctx.db, actie.id, 'failed', { reden });
    return { status: 'failed', reden };
  }

  try {
    const uitkomst = await voerType(ctx, account, actie);
    const basis: WorkerUitkomst = {
      status: 'done',
      reden: null,
      response: uitkomst.response as unknown as Record<string, unknown>,
    };
    const signaal = uitkomst.usagePercentage;
    if (signaal !== undefined) {
      basis.usageSignaalPercentage = signaal;
      const nieuweFactor = verlagingNaUnipileSignaal({
        huidigeFactor: account.opbouwFactor,
        usagePercentage: signaal,
        signaal: ctx.limieten.unipile_usage_signaal,
      });
      if (nieuweFactor !== null) {
        await ctx.db.query(
          `update accounts set opbouw_factor = $2 where id = $1`,
          [account.id, nieuweFactor],
        );
      }
      if (signaal >= ctx.limieten.unipile_usage_signaal.afremmen_bij_percentage) {
        basis.typeDagStop = true;
      }
    }
    await persisteerVerzonden(ctx.db, actie, 'done', {
      reden: null,
      uitgevoerdOp: ctx.klok.nu(),
      unipileResponse: basis.response ?? null,
    });
    return basis;
  } catch (err) {
    return await verwerkFout(ctx, account, actie, err);
  }
}

interface VoerUitkomst {
  response: Record<string, unknown>;
  usagePercentage?: number;
}

async function voerType(
  ctx: WorkerContext,
  account: Account,
  actie: Actie,
): Promise<VoerUitkomst> {
  const uid = account.unipileAccountId;
  if (!uid) throw new Error('unipileAccountId ontbreekt; eerder gevalideerd.');
  switch (actie.type) {
    case 'invite': {
      const p = actie.payload as { providerId: string; message?: string; userEmail?: string };
      const invArgs: Parameters<UnipileClient['stuurInvite']>[0] = {
        accountId: uid,
        providerId: p.providerId,
      };
      if (p.message !== undefined) invArgs.message = p.message;
      if (p.userEmail !== undefined) invArgs.userEmail = p.userEmail;
      const antwoord = await ctx.unipile.stuurInvite(invArgs);
      const uit: VoerUitkomst = { response: { ...antwoord } };
      if (antwoord.usage) uit.usagePercentage = antwoord.usage.percentage;
      return uit;
    }
    case 'message': {
      const p = actie.payload as { chatId: string; tekst: string; quoteId?: string };
      const msgArgs: Parameters<UnipileClient['stuurBericht']>[0] = {
        accountId: uid,
        chatId: p.chatId,
        tekst: p.tekst,
      };
      if (p.quoteId !== undefined) msgArgs.quoteId = p.quoteId;
      const antwoord = await ctx.unipile.stuurBericht(msgArgs);
      return { response: { ...antwoord } };
    }
    case 'inmail': {
      const p = actie.payload as {
        attendeesIds: string[];
        tekst: string;
        onderwerp?: string;
        linkedinApi?: 'classic' | 'sales_navigator';
      };
      const inmailArgs: Parameters<UnipileClient['startGesprek']>[0] = {
        accountId: uid,
        attendeesIds: p.attendeesIds,
        tekst: p.tekst,
        isInmail: true,
      };
      if (p.onderwerp !== undefined) inmailArgs.onderwerp = p.onderwerp;
      if (p.linkedinApi !== undefined) inmailArgs.linkedinApi = p.linkedinApi;
      const antwoord = await ctx.unipile.startGesprek(inmailArgs);
      return { response: { ...antwoord } };
    }
    case 'profile': {
      const p = actie.payload as { identifier: string; secties?: string };
      const profArgs: Parameters<UnipileClient['haalProfiel']>[0] = {
        accountId: uid,
        identifier: p.identifier,
      };
      if (p.secties !== undefined) profArgs.secties = p.secties;
      const antwoord = await ctx.unipile.haalProfiel(profArgs);
      return { response: { ...antwoord } };
    }
    case 'search': {
      const p = actie.payload as {
        api?: 'classic' | 'sales_navigator';
        category?: 'people' | 'companies';
        keywords?: string;
        limit?: number;
        cursor?: string;
        filters?: Record<string, unknown>;
      };
      const zoekArgs: Parameters<UnipileClient['zoekPersonen']>[0] = { accountId: uid };
      if (p.api !== undefined) zoekArgs.api = p.api;
      if (p.category !== undefined) zoekArgs.category = p.category;
      if (p.keywords !== undefined) zoekArgs.keywords = p.keywords;
      if (p.limit !== undefined) zoekArgs.limit = p.limit;
      if (p.cursor !== undefined) zoekArgs.cursor = p.cursor;
      if (p.filters !== undefined) zoekArgs.filters = p.filters;
      const antwoord = await ctx.unipile.zoekPersonen(zoekArgs);
      return { response: { ...antwoord } };
    }
  }
}

async function verwerkFout(
  ctx: WorkerContext,
  account: Account,
  actie: Actie,
  err: unknown,
): Promise<WorkerUitkomst> {
  if (err instanceof UnipileGatewayAuthFout) {
    const reden =
      'Gateway-API-sleutel afgewezen door Unipile; alles stilgezet voor onderzoek door Rubert.';
    await persisteer(ctx.db, actie.id, 'queued', { reden });
    return { status: 'queued', reden, gatewayAuthFout: true };
  }

  if (err instanceof UnipileAccountCredentialsFout) {
    const reden =
      'LinkedIn-sessie voor dit account is verlopen; alleen dit account gepauzeerd en reconnect-link aangemaakt.';
    await werkAccountStatusBij(ctx.db, account.id, 'CREDENTIALS');
    if (ctx.reconnectHook) {
      try {
        await ctx.reconnectHook(account.id);
      } catch {
        /* reconnect-link is best-effort; webhook ontvangt reconnect normaal gesproken ook. */
      }
    }
    await persisteer(ctx.db, actie.id, 'queued', { reden });
    return { status: 'queued', reden, alleenDitAccountPauzeren: true };
  }

  if (err instanceof UnipileTijdelijkeFout && err.status === 429) {
    const reden =
      'LinkedIn vroeg te snel om pauze (HTTP 429); account 48 uur in afkoeling en actie terug in de wachtrij.';
    await startAfkoeling(ctx.db, account.id, ctx.klok.nu(), ctx.limieten.afkoeling);
    await persisteer(ctx.db, actie.id, 'queued', { reden });
    return { status: 'queued', reden };
  }

  if (err instanceof UnipileTimeoutFout) {
    if (VERZEND_TYPES.has(actie.type)) {
      const reden =
        'Time-out: mogelijk verzonden. Controleer in LinkedIn en zet handmatig op done of opnieuw approved.';
      await persisteerVerzonden(ctx.db, actie, 'onzeker', { reden });
      await bewaarOnzekerEvent(ctx.db, actie, reden, ctx.klok.nu());
      return { status: 'onzeker', reden };
    }
    const nu = ctx.klok.nu();
    const geplandOp = new Date(nu.getTime() + UITVOER_TIME_OUT_HERPLANNING_SECONDEN * 1000);
    const reden =
      'Unipile niet bereikbaar binnen de time-out; actie opnieuw inplannen over 5 minuten (herhaaldelijk lezen is onschadelijk).';
    await persisteer(ctx.db, actie.id, 'queued', { reden, geplandOp });
    return { status: 'queued', reden };
  }

  if (err instanceof Unipile422Fout) {
    const code = err.code as Unipile422Code;
    if (LIMIET_422.has(code)) {
      await startAfkoeling(ctx.db, account.id, ctx.klok.nu(), ctx.limieten.afkoeling);
      await persisteer(ctx.db, actie.id, 'queued', { reden: err.message });
      return { status: 'queued', reden: err.message };
    }
    if (PERMANENTE_422.has(code)) {
      await persisteer(ctx.db, actie.id, 'failed', { reden: err.message });
      return { status: 'failed', reden: err.message };
    }
    // Onbekende 422-code: liever conservatief failen dan vastdraaien.
    await persisteer(ctx.db, actie.id, 'failed', { reden: err.message });
    return { status: 'failed', reden: err.message };
  }

  if (err instanceof UnipileTijdelijkeFout) {
    const reden = `Unipile-serverfout; actie opnieuw proberen over 5 minuten (${err.message}).`;
    const geplandOp = new Date(ctx.klok.nu().getTime() + 5 * 60 * 1000);
    await persisteer(ctx.db, actie.id, 'queued', { reden, geplandOp });
    return { status: 'queued', reden };
  }

  if (err instanceof UnipileFout) {
    await persisteer(ctx.db, actie.id, 'failed', { reden: err.message });
    return { status: 'failed', reden: err.message };
  }

  const reden = `Onverwachte fout tijdens uitvoeren van actie: ${(err as Error)?.message ?? String(err)}`;
  await persisteer(ctx.db, actie.id, 'failed', { reden });
  return { status: 'failed', reden };
}

async function persisteer(
  db: Backend,
  actieId: string,
  status: ActieStatus,
  opties: {
    reden?: string | null;
    geplandOp?: Date | null;
    uitgevoerdOp?: Date | null;
    unipileResponse?: Record<string, unknown> | null;
  },
): Promise<void> {
  await zetActieStatus(db, actieId, status, opties);
}

/**
 * `done` of `onzeker`: de actie is (mogelijk) verzonden. Bij een invite gaat
 * `openstaande_verzoeken` in dezelfde transactie omhoog (SPEC §5a); bij
 * `onzeker` ook, want LinkedIn kan hem wél hebben ontvangen (veilige kant).
 */
async function persisteerVerzonden(
  db: Backend,
  actie: Actie,
  status: Extract<ActieStatus, 'done' | 'onzeker'>,
  opties: Parameters<typeof persisteer>[3],
): Promise<void> {
  await db.transaction(async (tx) => {
    await zetActieStatus(tx, actie.id, status, opties);
    if (actie.type === 'invite') await telInviteAlsOpenstaand(tx, actie);
    return true;
  });
}

/**
 * Legt een `actie_onzeker`-event vast zodat Rubert in de events-tabel ziet
 * welke acties handmatige controle in LinkedIn nodig hebben. Dedup per
 * actie-id: één event per onzeker-overgang.
 */
async function bewaarOnzekerEvent(
  db: Backend,
  actie: Actie,
  reden: string,
  nu: Date,
): Promise<void> {
  const externId = `actie_onzeker:${actie.id}`;
  const payload = {
    actie_id: actie.id,
    account_id: actie.accountId,
    type: actie.type,
    reden,
    ontvangen_op: nu.toISOString(),
  };
  try {
    await db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('gateway', 'actie_onzeker', $1, $2, $3::jsonb)`,
      [externId, actie.accountId, JSON.stringify(payload)],
    );
  } catch (err) {
    const bericht = (err as Error)?.message ?? '';
    if (/duplicate|unique/i.test(bericht)) return;
    throw err;
  }
}
