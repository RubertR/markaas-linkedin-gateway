import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vindAccount } from '../register/accounts.ts';
import { verwerkAcceptatie } from '../sequences/motor.ts';
import type { WerkdagenKiezer } from '../sequences/wachttijd.ts';

import { registreerAcceptatie, relatieProviderId, type UnipileWebhookPayload } from './unipile.ts';

/**
 * Eenmalig herstel van `new_relation`-events die binnenkwamen toen de gateway
 * `user_provider_id` nog niet las: er werd geen acceptatie geregistreerd en
 * de sequentie bleef op 'lopend'. De teller `openstaande_verzoeken` is toen
 * wél verlaagd, dus die raken we hier niet aan.
 * Zonder `uitvoeren` alleen een plan (dry-run).
 */

export interface AcceptatieHerstelRegel {
  eventId: string;
  ontvangenOp: string;
  /** Uitkomst in gewone taal. */
  uitkomst: string;
  sequentieId: string | null;
  leadNaam: string | null;
  uitgevoerd: boolean;
}

export async function herstelGemisteAcceptaties(
  db: Backend,
  limieten: Limieten,
  klok: Klok,
  werkdagen: WerkdagenKiezer,
  opties: { uitvoeren: boolean },
): Promise<AcceptatieHerstelRegel[]> {
  const events = await db.query<{
    id: string;
    account_id: string;
    ontvangen_op: string;
    payload: UnipileWebhookPayload;
  }>(
    `select id::text, account_id::text, ontvangen_op::text, payload
     from events
     where type = 'new_relation' and account_id is not null
     order by ontvangen_op asc`,
  );

  const regels: AcceptatieHerstelRegel[] = [];
  for (const e of events) {
    const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    const providerId = relatieProviderId(payload);
    const basis = { eventId: e.id, ontvangenOp: e.ontvangen_op, sequentieId: null, leadNaam: null, uitgevoerd: false };
    if (!providerId) {
      regels.push({ ...basis, uitkomst: 'Geen provider-id in de payload; overgeslagen.' });
      continue;
    }

    const al = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from events
       where account_id = $1 and type = 'acceptatie'
         and payload ->> 'attendee_provider_id' = $2`,
      [e.account_id, providerId],
    );
    if (Number(al[0]?.aantal ?? '0') > 0) {
      regels.push({ ...basis, uitkomst: 'Acceptatie was al geregistreerd; niets te doen.' });
      continue;
    }

    const seq = await db.query<{ id: string; lead_naam: string | null }>(
      `select id::text, lead_naam from sequences
       where account_id = $1 and lead_provider_id = $2 and status = 'lopend'
       order by aangemaakt_op desc limit 1`,
      [e.account_id, providerId],
    );
    const sequentieId = seq[0]?.id ?? null;
    const leadNaam = seq[0]?.lead_naam ?? null;
    const plan = sequentieId
      ? 'Sequentie naar geaccepteerd; eerste bericht wordt ingepland.'
      : 'Geen lopende sequentie (connectie buiten de gateway); alleen acceptatie vastleggen.';

    if (!opties.uitvoeren) {
      regels.push({ ...basis, sequentieId, leadNaam, uitkomst: plan });
      continue;
    }

    const account = await vindAccount(db, e.account_id);
    const unipileAccountId = payload.account_id?.toString();
    if (!account || !unipileAccountId) {
      regels.push({ ...basis, sequentieId, leadNaam, uitkomst: 'Account niet gevonden; overgeslagen.' });
      continue;
    }
    const nieuw = await registreerAcceptatie(db, account.id, unipileAccountId, providerId, 'new_relation');
    if (!nieuw) {
      regels.push({ ...basis, sequentieId, leadNaam, uitkomst: 'Intussen al geregistreerd; overgeslagen.' });
      continue;
    }
    const gevolg = await verwerkAcceptatie(db, limieten, klok, werkdagen, {
      accountId: account.id,
      leadProviderId: providerId,
      accountTijdzone: account.tijdzone,
    });
    regels.push({
      ...basis,
      sequentieId: gevolg.sequentieId ?? sequentieId,
      leadNaam,
      uitkomst: gevolg.gewijzigd ? plan : `Acceptatie vastgelegd. ${gevolg.reden ?? ''}`.trim(),
      uitgevoerd: true,
    });
  }
  return regels;
}
