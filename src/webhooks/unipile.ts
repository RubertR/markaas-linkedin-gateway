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
  attendees?: Array<{ attendee_provider_id?: string }>;
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

  const attendeeProviderId = payload.attendee_provider_id ?? payload.sender?.attendee_provider_id;
  if (attendeeProviderId) {
    const nieuw = await registreerAcceptatie(db, account.id, unipileAccountId, attendeeProviderId, 'new_relation');
    if (!nieuw) {
      return {
        verwerkt: false,
        reden: 'Acceptatie al geregistreerd (eerder signaal); teller en sequentie niet opnieuw bijgewerkt.',
      };
    }
  }
  await verwerkAcceptatieGevolgen(db, account.id, unipileAccountId, attendeeProviderId, sequentieHook);
  return { verwerkt: true };
}

/**
 * Eén acceptatie per account+attendee, ongeacht het signaal (new_relation of
 * het eerste eigen bericht in een nieuw gesprek). De unieke extern_id in de
 * events-tabel is de ontdubbeling. Geeft `false` als ze er al was.
 */
async function registreerAcceptatie(
  db: Backend,
  accountId: string,
  unipileAccountId: string,
  attendeeProviderId: string,
  signaal: 'new_relation' | 'eerste_eigen_bericht',
): Promise<boolean> {
  return await bewaarEvent(
    db,
    'acceptatie',
    `acceptatie:${unipileAccountId}:${attendeeProviderId}`,
    { attendee_provider_id: attendeeProviderId, signaal },
    accountId,
    'gateway',
  );
}

async function verwerkAcceptatieGevolgen(
  db: Backend,
  accountId: string,
  unipileAccountId: string,
  attendeeProviderId: string | undefined,
  sequentieHook?: SequentieHookDeps,
): Promise<void> {
  await db.query(
    `update accounts
     set openstaande_verzoeken = greatest(openstaande_verzoeken - 1, 0)
     where id = $1`,
    [accountId],
  );
  if (sequentieHook) {
    await opNewRelation(sequentieHook, { unipileAccountId, attendeeProviderId });
  }
}

/**
 * Eigen bericht (`is_sender: true`). Telt nooit als reactie en stopt nooit
 * een sequentie. Wel het snelste acceptatiesignaal: bij acceptatie zet
 * LinkedIn de uitnodigingsnotitie als eerste bericht in een nieuw gesprek
 * (docs/unipile-notities.md, waarnemingen 30 sep 2026).
 */
async function verwerkEigenBericht(
  db: Backend,
  payload: UnipileWebhookPayload,
  sequentieHook?: SequentieHookDeps,
): Promise<WebhookUitkomst> {
  const unipileAccountId = payload.account_id?.toString();
  const messageId = payload.message_id?.toString();
  const chatId = payload.chat_id?.toString();
  if (!messageId || !chatId) {
    return { verwerkt: false, reden: 'Eigen bericht zonder chat_id of message_id.' };
  }
  const account = unipileAccountId
    ? await vindAccountBijUnipileId(db, unipileAccountId)
    : null;

  const externId = `webhook:message_sent_self:${chatId}:${messageId}`;
  const opgeslagen = await bewaarEvent(db, 'message_sent_self', externId, payload, account?.id ?? null);
  if (!opgeslagen) {
    return { verwerkt: false, reden: 'Webhook is al eerder verwerkt (dubbele levering).' };
  }
  const geenAcceptatie = (waarom: string): WebhookUitkomst => ({
    verwerkt: false,
    reden: `Eigen bericht opgeslagen; telt niet als reactie. ${waarom}`,
  });
  if (!account || !unipileAccountId) {
    return geenAcceptatie('Onbekend account.');
  }

  const eerdere = await db.query<{ aantal: string }>(
    `select count(*)::text as aantal from events
     where account_id = $1
       and type in ('message_received', 'message_sent_self')
       and payload ->> 'chat_id' = $2
       and extern_id <> $3`,
    [account.id, chatId, externId],
  );
  if (Number(eerdere[0]?.aantal ?? '0') > 0) {
    return geenAcceptatie('Niet het eerste bericht in dit gesprek.');
  }

  const eigen = payload.sender?.attendee_provider_id;
  const ontvangers = (Array.isArray(payload.attendees) ? payload.attendees : [])
    .map((a) => a?.attendee_provider_id)
    .filter((id): id is string => typeof id === 'string' && id !== '' && id !== eigen);
  if (ontvangers.length === 0) {
    return geenAcceptatie('Geen ontvanger in de payload.');
  }

  // 'onzeker' telt mee: zo'n invite verhoogde openstaande_verzoeken ook.
  const uitgenodigd = await db.query<{ provider_id: string }>(
    `select payload ->> 'providerId' as provider_id from actions
     where account_id = $1
       and type = 'invite'
       and status in ('done', 'onzeker')
       and payload ->> 'providerId' = any($2::text[])
     order by uitgevoerd_op desc nulls last
     limit 1`,
    [account.id, ontvangers],
  );
  const attendeeProviderId = uitgenodigd[0]?.provider_id;
  if (!attendeeProviderId) {
    return geenAcceptatie('Geen verstuurde invite naar de ontvanger.');
  }

  // new_relation's van vóór de acceptatie-ontdubbeling hebben geen
  // acceptatie-event; die tellen ook als al geregistreerd.
  const oudeRelatie = await db.query<{ aantal: string }>(
    `select count(*)::text as aantal from events
     where account_id = $1
       and type = 'new_relation'
       and coalesce(payload ->> 'attendee_provider_id', payload -> 'sender' ->> 'attendee_provider_id') = $2`,
    [account.id, attendeeProviderId],
  );
  if (Number(oudeRelatie[0]?.aantal ?? '0') > 0) {
    return geenAcceptatie('Acceptatie al geregistreerd via new_relation.');
  }
  const nieuw = await registreerAcceptatie(
    db, account.id, unipileAccountId, attendeeProviderId, 'eerste_eigen_bericht',
  );
  if (!nieuw) {
    return geenAcceptatie('Acceptatie al geregistreerd.');
  }
  await verwerkAcceptatieGevolgen(db, account.id, unipileAccountId, attendeeProviderId, sequentieHook);
  return {
    verwerkt: true,
    reden: 'Eerste eigen bericht in een nieuw gesprek na verstuurde invite; geregistreerd als acceptatie.',
  };
}

async function verwerkMessageReceived(
  db: Backend,
  payload: UnipileWebhookPayload,
  sequentieHook?: SequentieHookDeps,
): Promise<WebhookUitkomst> {
  if (payload.is_sender === true) {
    return await verwerkEigenBericht(db, payload, sequentieHook);
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
  bron: 'unipile' | 'gateway' = 'unipile',
): Promise<boolean> {
  try {
    await db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ($5::event_source, $1, $2, $3, $4::jsonb)`,
      [type, externId, accountId, JSON.stringify(payload), bron],
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

