import type { Backend } from '../db/backend.ts';
import { vindAccountBijUnipileId, werkAccountStatusBij } from '../register/accounts.ts';
import { maakReconnectLink, type KoppelflowOpties } from '../register/koppelflow.ts';
import { mapUnipileStatus } from '../register/status.ts';
import { opMessageReceived, opNewRelation, type SequentieHookDeps } from '../sequences/hooks.ts';
import type { UnipileClient } from '../unipile/client.ts';

export interface UnipileWebhookPayload {
  event?: string;
  account_id?: string;
  timestamp?: string;
  chat_id?: string;
  message_id?: string;
  is_sender?: boolean;
  attendee_provider_id?: string;
  sender?: { attendee_provider_id?: string };
  [key: string]: unknown;
}

export interface WebhookUitkomst {
  verwerkt: boolean;
  reden?: string;
}

export async function verwerkUnipileWebhook(
  db: Backend,
  unipile: UnipileClient,
  koppelOpties: KoppelflowOpties,
  payload: UnipileWebhookPayload,
  sequentieHook?: SequentieHookDeps,
): Promise<WebhookUitkomst> {
  const event = (payload.event ?? '').toString();
  if (!event) {
    return { verwerkt: false, reden: 'Webhook zonder event-veld ontvangen.' };
  }

  if (event === 'message_received') {
    return await verwerkMessageReceived(db, payload, sequentieHook);
  }
  if (event === 'new_relation') {
    return await verwerkNewRelation(db, payload, sequentieHook);
  }

  // Andere messaging-events (message_read, message_reaction, message_edited,
  // message_deleted, message_delivered) leggen we alleen vast voor later.
  if (event.startsWith('message_')) {
    const chatId = payload.chat_id?.toString() ?? 'geen';
    const messageId = payload.message_id?.toString() ?? payload.timestamp ?? '';
    await bewaarEvent(
      db,
      event,
      `webhook:${event}:${chatId}:${messageId}`,
      payload,
      await vindAccountIdBijPayload(db, payload),
    );
    return { verwerkt: false, reden: `Messaging-event "${event}" opgeslagen voor later.` };
  }

  // Alle overige events zijn account_status (docs: credentials, ok, error,
  // stopped, reconnected, permissions, plus onbekende namen die naar UNKNOWN gaan).
  return await verwerkAccountStatus(db, unipile, koppelOpties, payload);
}

async function verwerkAccountStatus(
  db: Backend,
  unipile: UnipileClient,
  koppelOpties: KoppelflowOpties,
  payload: UnipileWebhookPayload,
): Promise<WebhookUitkomst> {
  const unipileAccountId = payload.account_id?.toString();
  if (!unipileAccountId) {
    return { verwerkt: false, reden: 'account_status-webhook zonder account_id.' };
  }

  const nieuweStatus = mapUnipileStatus(payload.event);
  const account = await vindAccountBijUnipileId(db, unipileAccountId);

  const externId = `webhook:account_status:${unipileAccountId}:${nieuweStatus}:${payload.timestamp ?? ''}`;
  const opgeslagen = await bewaarEvent(
    db,
    'account_status',
    externId,
    payload,
    account?.id ?? null,
  );
  if (!opgeslagen) {
    return { verwerkt: false, reden: 'Webhook is al eerder verwerkt (dubbele levering).' };
  }

  if (!account) {
    return {
      verwerkt: false,
      reden: `Onbekend unipile_account_id "${unipileAccountId}"; event opgeslagen voor onderzoek.`,
    };
  }

  await werkAccountStatusBij(db, account.id, nieuweStatus);

  if (nieuweStatus === 'CREDENTIALS') {
    try {
      const link = await maakReconnectLink(db, unipile, koppelOpties, account.id);
      await bewaarEvent(
        db,
        'reconnect_link_klaar',
        `reconnect_link:${account.id}:${payload.timestamp ?? Date.now()}`,
        { account_id: account.id, url: link.url },
        account.id,
      );
    } catch (err) {
      await bewaarEvent(
        db,
        'reconnect_link_fout',
        `reconnect_link_fout:${account.id}:${payload.timestamp ?? Date.now()}`,
        { account_id: account.id, fout: (err as Error).message },
        account.id,
      );
    }
  }

  return { verwerkt: true };
}

async function verwerkNewRelation(
  db: Backend,
  payload: UnipileWebhookPayload,
  sequentieHook?: SequentieHookDeps,
): Promise<WebhookUitkomst> {
  const unipileAccountId = payload.account_id?.toString();
  if (!unipileAccountId) {
    return { verwerkt: false, reden: 'new_relation-webhook zonder account_id.' };
  }
  const account = await vindAccountBijUnipileId(db, unipileAccountId);

  const attendee = payload.attendee_provider_id ?? payload.sender?.attendee_provider_id ?? 'onbekend';
  const externId = `webhook:new_relation:${unipileAccountId}:${attendee}:${payload.timestamp ?? ''}`;
  const opgeslagen = await bewaarEvent(
    db,
    'new_relation',
    externId,
    payload,
    account?.id ?? null,
  );
  if (!opgeslagen) {
    return { verwerkt: false, reden: 'Webhook is al eerder verwerkt (dubbele levering).' };
  }

  if (!account) {
    return {
      verwerkt: false,
      reden: `Onbekend unipile_account_id "${unipileAccountId}"; event opgeslagen voor onderzoek.`,
    };
  }

  await db.query(
    `update accounts
     set openstaande_verzoeken = greatest(openstaande_verzoeken - 1, 0)
     where id = $1`,
    [account.id],
  );
  if (sequentieHook) {
    await opNewRelation(sequentieHook, {
      unipileAccountId,
      attendeeProviderId:
        payload.attendee_provider_id ?? payload.sender?.attendee_provider_id,
    });
  }
  return { verwerkt: true };
}

async function verwerkMessageReceived(
  db: Backend,
  payload: UnipileWebhookPayload,
  sequentieHook?: SequentieHookDeps,
): Promise<WebhookUitkomst> {
  if (payload.is_sender === true) {
    return {
      verwerkt: false,
      reden: 'Eigen bericht (is_sender=true); overgeslagen — telt niet als reactie.',
    };
  }
  const unipileAccountId = payload.account_id?.toString();
  const messageId = payload.message_id?.toString();
  const chatId = payload.chat_id?.toString();
  if (!messageId || !chatId) {
    return { verwerkt: false, reden: 'message_received zonder chat_id of message_id.' };
  }

  const account = unipileAccountId
    ? await vindAccountBijUnipileId(db, unipileAccountId)
    : null;

  const externId = `webhook:message_received:${chatId}:${messageId}`;
  const opgeslagen = await bewaarEvent(
    db,
    'message_received',
    externId,
    payload,
    account?.id ?? null,
  );
  if (!opgeslagen) {
    return { verwerkt: false, reden: 'Webhook is al eerder verwerkt (dubbele levering).' };
  }
  if (sequentieHook && account) {
    await opMessageReceived(sequentieHook, {
      accountIdIntern: account.id,
      chatId,
      senderProviderId:
        payload.sender?.attendee_provider_id ?? payload.attendee_provider_id,
    });
  }
  return { verwerkt: true };
}

async function bewaarEvent(
  db: Backend,
  type: string,
  externId: string,
  payload: unknown,
  accountId: string | null,
): Promise<boolean> {
  try {
    await db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('unipile', $1, $2, $3, $4::jsonb)`,
      [type, externId, accountId, JSON.stringify(payload)],
    );
    return true;
  } catch (err) {
    const bericht = (err as Error)?.message ?? '';
    if (/duplicate|unique/i.test(bericht)) return false;
    throw err;
  }
}

async function vindAccountIdBijPayload(
  db: Backend,
  payload: UnipileWebhookPayload,
): Promise<string | null> {
  const unipileAccountId = payload.account_id?.toString();
  if (!unipileAccountId) return null;
  const account = await vindAccountBijUnipileId(db, unipileAccountId);
  return account?.id ?? null;
}

