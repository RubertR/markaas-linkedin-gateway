import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vindAccount, vindAccountBijUnipileId } from '../register/accounts.ts';

import { verwerkAcceptatie, verwerkReactie, type WebhookGevolg } from './motor.ts';
import type { WerkdagenKiezer } from './wachttijd.ts';

/**
 * Dunne adapter tussen de bestaande Unipile-webhook-flow (src/webhooks/) en
 * de sequentie-motor. De webhook-handler slaat zelf nog het event op in de
 * events-tabel (dedup); deze hooks lezen alleen eigen sequentie-state.
 */

export interface SequentieHookDeps {
  db: Backend;
  limieten: Limieten;
  klok: Klok;
  werkdagen: WerkdagenKiezer;
}

export async function opNewRelation(
  deps: SequentieHookDeps,
  invoer: { unipileAccountId: string; attendeeProviderId: string | undefined },
): Promise<WebhookGevolg> {
  if (!invoer.attendeeProviderId) {
    return {
      sequentieId: null,
      nieuweStatus: null,
      gewijzigd: false,
      reden: 'new_relation zonder attendee_provider_id; geen sequentie bijgewerkt.',
    };
  }
  const account = await vindAccountBijUnipileId(deps.db, invoer.unipileAccountId);
  if (!account) {
    return {
      sequentieId: null,
      nieuweStatus: null,
      gewijzigd: false,
      reden: `Onbekend unipile_account_id "${invoer.unipileAccountId}".`,
    };
  }
  return verwerkAcceptatie(deps.db, deps.limieten, deps.klok, deps.werkdagen, {
    accountId: account.id,
    leadProviderId: invoer.attendeeProviderId,
    accountTijdzone: account.tijdzone,
  });
}

export async function opMessageReceived(
  deps: SequentieHookDeps,
  invoer: {
    unipileAccountId?: string | undefined;
    accountIdIntern?: string | undefined;
    chatId?: string | undefined;
    senderProviderId?: string | undefined;
  },
): Promise<WebhookGevolg> {
  let accountId = invoer.accountIdIntern;
  if (!accountId && invoer.unipileAccountId) {
    const account = await vindAccountBijUnipileId(deps.db, invoer.unipileAccountId);
    if (account) accountId = account.id;
  }
  if (!accountId) {
    return {
      sequentieId: null,
      nieuweStatus: null,
      gewijzigd: false,
      reden: 'Geen account bekend voor deze reactie.',
    };
  }
  if (!(await vindAccount(deps.db, accountId))) {
    return {
      sequentieId: null,
      nieuweStatus: null,
      gewijzigd: false,
      reden: 'Accountrij ontbreekt voor deze reactie.',
    };
  }
  return verwerkReactie(deps.db, deps.limieten, {
    accountId,
    ...(invoer.chatId ? { chatId: invoer.chatId } : {}),
    ...(invoer.senderProviderId ? { leadProviderId: invoer.senderProviderId } : {}),
  });
}
