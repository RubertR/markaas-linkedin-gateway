import type { Backend } from '../db/backend.ts';
import type { Klok } from '../budget/klok.ts';
import type { ActieType, Limieten } from '../budget/limits.ts';
import { reserveerEnVerbruik } from '../budget/verbruik.ts';
import type { Beoordeling, ControleNaam } from '../budget/beoordeel.ts';
import { vindAccount, type Account } from '../register/accounts.ts';
import { REDEN_TE_LANG_OP_PAUZE, pauzeUitleg } from '../register/accountpauze.ts';
import type { UnipileClient } from '../unipile/client.ts';

import {
  vindActie,
  zetActieStatus,
  type Actie,
  type ActieStatus,
} from './acties.ts';
import type { PauzeKiezer } from './pauze.ts';
import { voerActieUit, type WorkerContext, type WorkerUitkomst } from './worker.ts';

/**
 * Planner: één tick kiest per account de oudste openstaande actie, laat de
 * budgetmotor beslissen en dispatcht hem naar de worker. Zie docs/fase-2-plan
 * §3.4. De planner is bewust niet-blokkerend over accounts heen: zodra één
 * worker klaar is, blijft de rest doorlopen tot alle accounts gewerkt hebben.
 *
 * Resultaatregels:
 * - toegestaan → worker voert uit (done/failed/queued-fout).
 * - wachtrij (tijdelijk) → actie terug in de wachtrij met reden en een
 *   nieuwe gepland_op op het vroegst toegestane moment.
 * - weigering (structureel) → actie "rejected" met reden.
 * - wachtrij omdat het account op pauze staat (SPEC §6b) → zie
 *   `parkeerOmAccountPauze`: 60 minuten geparkeerd, vervalt na
 *   `account_pauze.max_parkeer_dagen`.
 *
 * Een 401/403 van Unipile stopt alleen het account waar hij over gaat (SPEC
 * §6a; de worker beslist via src/register/accountauth.ts): andere accounts
 * lopen in dezelfde tick gewoon door. Alleen als ook de controle-aanroep
 * (`GET /api/v1/accounts` zonder account-context) wordt geweigerd, is onze
 * eigen API-sleutel kapot. Dan stopt de planner alles: hij geeft
 * `gatewayGestopt: true` terug zodat de lus stopt tot een herstart; de
 * account-status wordt dan NIET aangepast.
 */

export interface PlannerContext {
  db: Backend;
  unipile: UnipileClient;
  limieten: Limieten;
  klok: Klok;
  pauzeKiezer: PauzeKiezer;
  reconnectHook?: (accountId: string) => Promise<void>;
}

export type PlannerDetailStatus = 'done' | 'failed' | 'queued' | 'rejected' | 'onzeker';

export interface PlannerDetail {
  actieId: string;
  accountId: string;
  type: ActieType;
  resultaat: PlannerDetailStatus;
  reden: string | null;
  /** De worker meldde dat onze Unipile-sleutel kapot is (SPEC §6a). */
  gatewayAuthFout?: boolean;
}

export interface PlannerTickResultaat {
  verwerkt: number;
  gatewayGestopt: boolean;
  details: PlannerDetail[];
}

export async function voerPlannerTickUit(ctx: PlannerContext): Promise<PlannerTickResultaat> {
  const nu = ctx.klok.nu();
  const accountIds = await accountsMetWachtendeActies(ctx.db, nu);
  const details: PlannerDetail[] = [];
  let gatewayGestopt = false;

  for (const accountId of accountIds) {
    if (gatewayGestopt) break;
    const actie = await claimOudsteActie(ctx.db, accountId, nu);
    if (!actie) continue;
    const detail = await verwerkActie(ctx, actie);
    details.push(detail);
    if (detail.gatewayAuthFout) gatewayGestopt = true;
  }

  return { verwerkt: details.length, gatewayGestopt, details };
}

async function accountsMetWachtendeActies(db: Backend, nu: Date): Promise<string[]> {
  const rijen = await db.query<{ account_id: string }>(
    `select distinct account_id from actions
     where status in ('approved'::action_status, 'queued'::action_status)
       and (gepland_op is null or gepland_op <= $1)
     order by account_id`,
    [nu.toISOString()],
  );
  return rijen.map((r) => r.account_id);
}

/**
 * Claimt atomisch de oudste openstaande actie voor dit account door haar
 * naar `running` te zetten. De `UPDATE ... WHERE status IN (...)`-constraint
 * voorkomt dat twee gelijktijdige planners dezelfde actie claimen: wie het
 * laatst komt vindt de rij niet meer in de verwachte status en krijgt leeg
 * terug.
 */
async function claimOudsteActie(
  db: Backend,
  accountId: string,
  nu: Date,
): Promise<Actie | null> {
  return db.transaction(async (tx) => {
    const kandidaten = await tx.query<{ id: string }>(
      `select id from actions
       where account_id = $1
         and status in ('approved'::action_status, 'queued'::action_status)
         and (gepland_op is null or gepland_op <= $2)
       order by aangemaakt_op
       limit 1
       for update skip locked`,
      [accountId, nu.toISOString()],
    );
    const kandidaatId = kandidaten[0]?.id;
    if (!kandidaatId) return null;
    const rijen = await tx.query<{ id: string }>(
      `update actions
       set status = 'running'::action_status
       where id = $1
         and status in ('approved'::action_status, 'queued'::action_status)
       returning id`,
      [kandidaatId],
    );
    if (rijen.length === 0) return null;
    return vindActie(tx, kandidaatId);
  });
}

async function verwerkActie(ctx: PlannerContext, actie: Actie): Promise<PlannerDetail> {
  const account = await vindAccount(ctx.db, actie.accountId);
  if (!account) {
    const reden = `Account ${actie.accountId} bestaat niet; actie gemarkeerd als failed.`;
    await zetActieStatus(ctx.db, actie.id, 'failed', { reden });
    return basisDetail(actie, 'failed', reden);
  }

  const laatsteActieOp = await laatsteUitgevoerdOp(ctx.db, account.id);
  const minPauzeSeconden = ctx.pauzeKiezer.kies(ctx.limieten.tijdvenster.pauze_tussen_acties_minuten);

  const beoordeling = await reserveerEnVerbruik(ctx.db, {
    accountId: account.id,
    actieType: actie.type,
    goedgekeurd: actie.goedgekeurdDoor !== null,
    klok: ctx.klok,
    limieten: ctx.limieten,
    minPauzeSeconden,
    laatsteActieOp,
  });

  if (beoordeling.status === 'wachtrij' && beoordeling.accountPauze) {
    return await parkeerOmAccountPauze(ctx, actie, account, beoordeling);
  }

  // Niet (meer) om een accountpauze geparkeerd: het ijkpunt vervalt, zodat
  // een latere pauze weer vanaf nul telt.
  const wisPauze = actie.pauzeGeparkeerdSinds ? { pauzeGeparkeerdSinds: null } : {};

  if (beoordeling.status === 'wachtrij') {
    const geplandOp = volgendeToegestaneMoment(ctx, account, beoordeling);
    await zetActieStatus(ctx.db, actie.id, 'queued', {
      reden: beoordeling.reden,
      geplandOp,
      ...wisPauze,
    });
    return basisDetail(actie, 'queued', beoordeling.reden);
  }

  if (beoordeling.status === 'weigering') {
    await zetActieStatus(ctx.db, actie.id, 'rejected', { reden: beoordeling.reden, ...wisPauze });
    return basisDetail(actie, 'rejected', beoordeling.reden);
  }

  if (actie.pauzeGeparkeerdSinds) {
    await zetActieStatus(ctx.db, actie.id, 'running', wisPauze);
  }

  // Toegestaan: worker voert uit.
  const workerCtx: WorkerContext = {
    db: ctx.db,
    unipile: ctx.unipile,
    limieten: ctx.limieten,
    klok: ctx.klok,
    ...(ctx.reconnectHook ? { reconnectHook: ctx.reconnectHook } : {}),
  };
  const uitkomst = await voerActieUit(workerCtx, actie);
  return werkDetail(actie, uitkomst);
}

/** Minuten tot een om accountpauze geparkeerde actie opnieuw wordt beoordeeld (SPEC §6b). */
const ACCOUNT_PAUZE_WACHT_MINUTEN = 60;

/**
 * Account op pauze (SPEC §6b punt 1).
 *
 * - `invite`, `message`, `inmail`: blijven `queued` en worden elke 60 minuten
 *   opnieuw beoordeeld, net als bij de betaalpoort. Is het account weer `OK`,
 *   dan lopen ze door.
 * - Vervallen: na `account_pauze.max_parkeer_dagen` wordt de actie
 *   `rejected` met "account stond te lang op pauze".
 *   **IJkpunt** is `pauze_geparkeerd_sinds`: het moment waarop de planner de
 *   actie voor het eerst om de accountpauze parkeerde. Niet `goedgekeurd_op`
 *   of `aangemaakt_op`: een actie die al dagen op dagbudget of de betaalpoort
 *   wachtte, krijgt zo bij een pauze nog steeds de volle termijn, en de
 *   termijn telt alleen tijd dat het account echt op pauze stond. Wordt de
 *   actie daarna om een andere reden beoordeeld (account weer `OK`), dan wist
 *   `verwerkActie` het ijkpunt; een latere pauze begint opnieuw.
 * - `search`/`profile` in de wachtrij worden niet geparkeerd maar direct
 *   `rejected`: een zoekopdracht die uren later vanzelf draait, heeft geen nut
 *   (zelfde regel als de synchrone MCP-tools). Er is geen budget verbruikt.
 */
async function parkeerOmAccountPauze(
  ctx: PlannerContext,
  actie: Actie,
  account: Account,
  beoordeling: Extract<Beoordeling, { status: 'wachtrij' }>,
): Promise<PlannerDetail> {
  const nu = ctx.klok.nu();
  if (actie.type === 'search' || actie.type === 'profile') {
    const reden =
      `Niet uitgevoerd: ${pauzeUitleg(account.status)}. Een ${actie.type} wordt op een account met pauze niet geparkeerd; ` +
      'er is geen budget verbruikt. Vraag hem opnieuw aan zodra het account weer werkt.';
    await zetActieStatus(ctx.db, actie.id, 'rejected', { reden, pauzeGeparkeerdSinds: null });
    return basisDetail(actie, 'rejected', reden);
  }

  const sinds = actie.pauzeGeparkeerdSinds ?? nu;
  const maxDagen = ctx.limieten.account_pauze.max_parkeer_dagen;
  if (nu.getTime() - sinds.getTime() >= maxDagen * 86_400_000) {
    const reden =
      `${REDEN_TE_LANG_OP_PAUZE}: ` +
      `de actie wachtte sinds ${sinds.toISOString()} langer dan ${maxDagen} dagen omdat ${pauzeUitleg(account.status)}. ` +
      'De actie is vervallen zodat er geen verouderd bericht meer weggaat; keur zo nodig een nieuwe versie goed.';
    await zetActieStatus(ctx.db, actie.id, 'rejected', { reden });
    return basisDetail(actie, 'rejected', reden);
  }

  await zetActieStatus(ctx.db, actie.id, 'queued', {
    reden: beoordeling.reden,
    geplandOp: new Date(nu.getTime() + ACCOUNT_PAUZE_WACHT_MINUTEN * 60_000),
    pauzeGeparkeerdSinds: sinds,
  });
  return basisDetail(actie, 'queued', beoordeling.reden);
}

function werkDetail(actie: Actie, uitkomst: WorkerUitkomst): PlannerDetail {
  const detail = basisDetail(actie, uitkomst.status, uitkomst.reden);
  if (uitkomst.gatewayAuthFout) detail.gatewayAuthFout = true;
  return detail;
}

function basisDetail(
  actie: Actie,
  resultaat: PlannerDetailStatus,
  reden: string | null,
): PlannerDetail {
  return {
    actieId: actie.id,
    accountId: actie.accountId,
    type: actie.type,
    resultaat,
    reden,
  };
}

async function laatsteUitgevoerdOp(db: Backend, accountId: string): Promise<Date | null> {
  const rijen = await db.query<{ uitgevoerd_op: string | Date | null }>(
    `select max(uitgevoerd_op) as uitgevoerd_op from actions
     where account_id = $1 and uitgevoerd_op is not null`,
    [accountId],
  );
  const w = rijen[0]?.uitgevoerd_op;
  if (!w) return null;
  return w instanceof Date ? w : new Date(w);
}

/**
 * Bepaal de eerste gelegenheid waarop deze actie weer opnieuw mag worden
 * aangeboden. Grove inschatting op basis van de controlenaam; de volgende
 * planner-tick zal opnieuw oordelen en, indien nodig, nog iets verder
 * doorschuiven.
 */
function volgendeToegestaneMoment(
  ctx: PlannerContext,
  account: Account,
  beoordeling: Extract<Beoordeling, { status: 'wachtrij' }>,
): Date {
  const nu = ctx.klok.nu();
  if (beoordeling.controle === 'afkoeling' && account.afkoelingTot) {
    return new Date(account.afkoelingTot.getTime() + 1_000);
  }
  const minuten = standaardWachtMinuten(beoordeling.controle);
  return new Date(nu.getTime() + minuten * 60_000);
}

function standaardWachtMinuten(controle: ControleNaam): number {
  switch (controle) {
    case 'tijdvenster':
      return 30;
    case 'dagbudget':
      return 6 * 60;
    case 'weekbudget':
      return 6 * 60;
    case 'afkoeling':
      return 60;
    case 'account_gezond':
      return 2;
    case 'abonnement':
      return 60;
    case 'goedgekeurd':
      return 60;
  }
}

// Houd ActieStatus bereikbaar voor consumers.
export type { ActieStatus };
