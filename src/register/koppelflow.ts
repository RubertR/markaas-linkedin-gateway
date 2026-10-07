import type { Backend } from '../db/backend.ts';
import type { KoppellinkAanvraag, UnipileClient } from '../unipile/client.ts';
import {
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
} from '../unipile/errors.ts';

import {
  markeerAccountGekoppeld,
  vindAccount,
  vindAccountBijUnipileId,
  werkAccountStatusBij,
} from './accounts.ts';

export interface KoppelflowOpties {
  notifyUrl: string;
  apiUrl: string;
  linkDuurUren?: number;
  /** Optioneel: waar Unipile de browser na koppelen heen stuurt (SPEC §14.2 punt 6). */
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
}

const STANDAARD_LINK_DUUR_UREN = 24;

export type KoppelflowOorzaak = 'tijdelijk' | 'timeout' | 'invoer' | 'onbekend';

export class KoppelflowFout extends Error {
  readonly oorzaak: KoppelflowOorzaak;
  readonly retryAfterSeconden: number | undefined;
  readonly origineel: unknown;

  constructor(oorzaak: KoppelflowOorzaak, bericht: string, opties: {
    retryAfterSeconden?: number;
    origineel?: unknown;
  } = {}) {
    super(bericht);
    this.name = 'KoppelflowFout';
    this.oorzaak = oorzaak;
    this.retryAfterSeconden = opties.retryAfterSeconden;
    this.origineel = opties.origineel;
  }
}

function vervaltOp(uren: number): Date {
  return new Date(Date.now() + uren * 60 * 60 * 1000);
}

function omzettenNaarKoppelflowFout(err: unknown): KoppelflowFout | undefined {
  if (err instanceof UnipileTimeoutFout) {
    return new KoppelflowFout(
      'timeout',
      'Unipile reageerde niet op tijd bij het aanmaken van de koppellink; probeer het over enkele minuten opnieuw.',
      { origineel: err },
    );
  }
  if (err instanceof UnipileTijdelijkeFout) {
    const opties: { retryAfterSeconden?: number; origineel: unknown } = { origineel: err };
    if (err.retryAfterSeconden !== undefined) opties.retryAfterSeconden = err.retryAfterSeconden;
    return new KoppelflowFout(
      'tijdelijk',
      `Koppellink is tijdelijk niet beschikbaar (Unipile of LinkedIn vroeg om vertragen). Probeer het over ${err.retryAfterSeconden ?? 'een paar'} seconden opnieuw.`,
      opties,
    );
  }
  return undefined;
}

export async function maakCreateLink(
  db: Backend,
  unipile: UnipileClient,
  opties: KoppelflowOpties,
  accountId: string,
): Promise<{ url: string }> {
  const account = await vindAccount(db, accountId);
  if (!account) {
    throw new KoppelflowFout('invoer', `Onbekend account-id: ${accountId}.`);
  }
  try {
    const aanvraag: KoppellinkAanvraag = {
      type: 'create',
      naam: account.id,
      notifyUrl: opties.notifyUrl,
      apiUrl: opties.apiUrl,
      vervaltOp: vervaltOp(opties.linkDuurUren ?? STANDAARD_LINK_DUUR_UREN),
      singleUse: true,
    };
    if (opties.successRedirectUrl) aanvraag.successRedirectUrl = opties.successRedirectUrl;
    if (opties.failureRedirectUrl) aanvraag.failureRedirectUrl = opties.failureRedirectUrl;
    return await unipile.maakKoppellink(aanvraag);
  } catch (err) {
    if (err instanceof UnipileGatewayAuthFout) throw err;
    const flowFout = omzettenNaarKoppelflowFout(err);
    if (flowFout) throw flowFout;
    throw err;
  }
}

export async function maakReconnectLink(
  db: Backend,
  unipile: UnipileClient,
  opties: KoppelflowOpties,
  accountId: string,
): Promise<{ url: string }> {
  const account = await vindAccount(db, accountId);
  if (!account) {
    throw new KoppelflowFout('invoer', `Onbekend account-id: ${accountId}.`);
  }
  if (!account.unipileAccountId) {
    throw new KoppelflowFout(
      'invoer',
      `Account ${accountId} is nog niet gekoppeld — er is geen unipile_account_id om te herkoppelen. Maak eerst een create-link.`,
    );
  }
  try {
    return await unipile.maakKoppellink({
      type: 'reconnect',
      naam: account.id,
      notifyUrl: opties.notifyUrl,
      apiUrl: opties.apiUrl,
      vervaltOp: vervaltOp(opties.linkDuurUren ?? STANDAARD_LINK_DUUR_UREN),
      reconnectAccountId: account.unipileAccountId,
    });
  } catch (err) {
    if (err instanceof UnipileGatewayAuthFout) throw err;
    const flowFout = omzettenNaarKoppelflowFout(err);
    if (flowFout) throw flowFout;
    throw err;
  }
}

export interface KoppelCallbackPayload {
  status: string;
  account_id: string;
  name?: string;
}

export interface KoppelCallbackUitkomst {
  verwerkt: boolean;
  reden?: string;
}

export interface VerwerkOpties {
  nu?: Date;
  dedupVensterMinuten?: number;
}

const STANDAARD_DEDUP_VENSTER_MINUTEN = 10;

function tijdvenster(nu: Date, minuten: number): number {
  return Math.floor(nu.getTime() / (minuten * 60 * 1000));
}

export async function verwerkKoppelCallback(
  db: Backend,
  payload: KoppelCallbackPayload,
  opties: VerwerkOpties = {},
): Promise<KoppelCallbackUitkomst> {
  if (!payload.status?.trim()) {
    throw new KoppelflowFout('invoer', 'Callback zonder status ontvangen.');
  }
  if (!payload.account_id?.trim()) {
    throw new KoppelflowFout('invoer', 'Callback zonder account_id ontvangen.');
  }

  const nu = opties.nu ?? new Date();
  const venster = opties.dedupVensterMinuten ?? STANDAARD_DEDUP_VENSTER_MINUTEN;
  const bucket = tijdvenster(nu, venster);
  const externId = `hosted:${payload.status}:${payload.account_id}${
    payload.name ? `:${payload.name}` : ''
  }:v${bucket}`;

  const opgeslagen = await bewaarEventEenmaal(db, externId, payload);
  if (!opgeslagen) {
    return {
      verwerkt: false,
      reden: `Callback is al verwerkt binnen dit dedup-venster van ${venster} minuten (dubbele levering).`,
    };
  }

  if (payload.status === 'CREATION_SUCCESS') {
    if (!payload.name?.trim()) {
      return {
        verwerkt: false,
        reden: 'Callback zonder "name" ontvangen; onbekend account — event opgeslagen voor onderzoek.',
      };
    }
    const account = await vindAccount(db, payload.name);
    if (!account) {
      return {
        verwerkt: false,
        reden: `Onbekend account "${payload.name}" in name-veld; event opgeslagen voor onderzoek.`,
      };
    }
    await markeerAccountGekoppeld(db, account.id, payload.account_id);
    return { verwerkt: true };
  }

  if (payload.status === 'RECONNECTED') {
    const account = await vindAccountBijUnipileId(db, payload.account_id);
    if (!account) {
      return {
        verwerkt: false,
        reden: `Onbekend unipile_account_id "${payload.account_id}" bij RECONNECTED; event opgeslagen voor onderzoek.`,
      };
    }
    // Alleen status naar OK. afkoeling_tot komt van een LinkedIn-waarschuwing/429
    // en heeft niets met de sessie te maken — die blijft dus staan.
    await werkAccountStatusBij(db, account.id, 'OK');
    return { verwerkt: true };
  }

  return {
    verwerkt: false,
    reden: `Onbekende callback-status "${payload.status}"; event opgeslagen voor onderzoek.`,
  };
}

async function bewaarEventEenmaal(
  db: Backend,
  externId: string,
  payload: KoppelCallbackPayload,
): Promise<boolean> {
  try {
    await db.query(
      `insert into events(bron, type, extern_id, payload)
       values ('unipile', 'hosted_auth', $1, $2::jsonb)`,
      [externId, JSON.stringify(payload)],
    );
    return true;
  } catch (err) {
    const bericht = (err as Error)?.message ?? '';
    if (/duplicate|unique/i.test(bericht)) return false;
    throw err;
  }
}
