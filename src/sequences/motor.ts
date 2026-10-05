import type { Klok } from '../budget/klok.ts';
import type { Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, type Actie } from '../queue/acties.ts';

import { teltDoorWerkdagen, type WerkdagenKiezer } from './wachttijd.ts';

/**
 * Sequentie-motor (SPEC §8a). Pure stap-logica: start een sequentie, verwerk
 * webhook-triggers (new_relation, message_received), en voer de tick uit die
 * stappen 2 en 3 inplant.
 *
 * Harde regel: deze module zet NOOIT een actie op `approved`. Elke stap komt
 * als `draft` in de wachtrij en loopt via de goedkeuringspagina (SPEC §12,
 * CLAUDE.md regel 1).
 */

export type SequentieStatus =
  | 'lopend'
  | 'geaccepteerd'
  | 'reactie'
  | 'gestopt'
  | 'mislukt';

export interface Sequentie {
  id: string;
  accountId: string;
  leadLinkedinUrl: string;
  leadProviderId: string | null;
  leadNaam: string;
  leadFunctie: string;
  leadBedrijf: string;
  waarom: string;
  tekstInvite: string;
  tekstBericht: string;
  tekstOpvolging: string;
  stap: number;
  status: SequentieStatus;
  volgendeActieOp: Date | null;
  stopReden: string | null;
  aangemaaktOp: Date;
}

interface SequentieRij {
  id: string;
  account_id: string;
  lead_linkedin_url: string;
  lead_provider_id: string | null;
  lead_naam: string | null;
  lead_functie: string | null;
  lead_bedrijf: string | null;
  waarom: string | null;
  tekst_invite: string | null;
  tekst_bericht: string | null;
  tekst_opvolging: string | null;
  stap: number;
  status: SequentieStatus;
  volgende_actie_op: string | Date | null;
  stop_reden: string | null;
  aangemaakt_op: string | Date;
}

function alsDatum(w: string | Date): Date {
  return w instanceof Date ? w : new Date(w);
}

function mapSequentie(rij: SequentieRij): Sequentie {
  return {
    id: rij.id,
    accountId: rij.account_id,
    leadLinkedinUrl: rij.lead_linkedin_url,
    leadProviderId: rij.lead_provider_id,
    leadNaam: rij.lead_naam ?? '',
    leadFunctie: rij.lead_functie ?? '',
    leadBedrijf: rij.lead_bedrijf ?? '',
    waarom: rij.waarom ?? '',
    tekstInvite: rij.tekst_invite ?? '',
    tekstBericht: rij.tekst_bericht ?? '',
    tekstOpvolging: rij.tekst_opvolging ?? '',
    stap: rij.stap,
    status: rij.status,
    volgendeActieOp: rij.volgende_actie_op ? alsDatum(rij.volgende_actie_op) : null,
    stopReden: rij.stop_reden,
    aangemaaktOp: alsDatum(rij.aangemaakt_op),
  };
}

const SEQ_KOLOMMEN = `id, account_id, lead_linkedin_url, lead_provider_id,
    lead_naam, lead_functie, lead_bedrijf, waarom,
    tekst_invite, tekst_bericht, tekst_opvolging,
    stap, status, volgende_actie_op, stop_reden, aangemaakt_op`;

export interface Lead {
  providerId: string;
  naam: string;
  functie: string;
  bedrijf: string;
  linkedinUrl: string;
  waarom: string;
}

export interface SequentieTeksten {
  invite: string;
  bericht: string;
  opvolging: string;
}

export interface StartSequentieInvoer {
  accountId: string;
  lead: Lead;
  teksten: SequentieTeksten;
}

export interface StartSequentieResultaat {
  sequentie: Sequentie;
  invite: Actie;
}

/**
 * Start een sequentie en maak meteen de `draft`-invite voor stap 1.
 * Idempotent per (account_id, lead_linkedin_url): dubbel starten gooit
 * een NL-fout zodat skills weten dat er al een sequentie loopt.
 */
export async function startSequentie(
  db: Backend,
  invoer: StartSequentieInvoer,
): Promise<StartSequentieResultaat> {
  valideerLead(invoer.lead);
  valideerTeksten(invoer.teksten);

  return db.transaction(async (tx) => {
    // Opnieuw starten mag alleen na een afwijzing op de goedkeuringspagina:
    // status 'gestopt' én een afgewezen stap. Andere stops ('reactie',
    // 'verzoek niet geaccepteerd', 'sequentie voltooid') blokkeren blijvend.
    const blokkerend = await tx.query<SequentieRij>(
      `select ${SEQ_KOLOMMEN} from sequences s
       where account_id = $1 and lead_linkedin_url = $2
         and not (
           status = 'gestopt'
           and exists (
             select 1 from actions a where a.sequence_id = s.id and a.status = 'rejected'
           )
         )
       order by aangemaakt_op desc
       limit 1`,
      [invoer.accountId, invoer.lead.linkedinUrl],
    );
    if (blokkerend[0]) {
      throw new Error(
        `Er loopt al een sequentie voor deze lead op dit account (sequentie-id ${blokkerend[0].id}, status ${blokkerend[0].status}); start geen tweede. Opnieuw starten kan alleen nadat een stap is afgewezen op de goedkeuringspagina.`,
      );
    }

    const seqRijen = await tx.query<SequentieRij>(
      `insert into sequences(
         account_id, lead_linkedin_url, lead_provider_id,
         lead_naam, lead_functie, lead_bedrijf, waarom,
         tekst_invite, tekst_bericht, tekst_opvolging,
         stap, status
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 'lopend')
       returning ${SEQ_KOLOMMEN}`,
      [
        invoer.accountId,
        invoer.lead.linkedinUrl,
        invoer.lead.providerId,
        invoer.lead.naam,
        invoer.lead.functie,
        invoer.lead.bedrijf,
        invoer.lead.waarom,
        invoer.teksten.invite,
        invoer.teksten.bericht,
        invoer.teksten.opvolging,
      ],
    );
    const seqRij = seqRijen[0];
    if (!seqRij) throw new Error('Sequentie aanmaken gaf geen rij terug.');
    const sequentie = mapSequentie(seqRij);

    const invite = await maakActie(tx, {
      accountId: invoer.accountId,
      type: 'invite',
      payload: {
        providerId: invoer.lead.providerId,
        message: invoer.teksten.invite,
        ontvanger_naam: invoer.lead.naam,
        ontvanger_functie: invoer.lead.functie,
        ontvanger_bedrijf: invoer.lead.bedrijf,
        ontvanger_url: invoer.lead.linkedinUrl,
        waarom: invoer.lead.waarom,
        _skill: 'sequentie',
        sequence_id: sequentie.id,
        sequence_stap: 1,
      },
    });
    await koppelActieAanSequentie(tx, invite.id, sequentie.id, 1);

    return { sequentie, invite };
  });
}

async function koppelActieAanSequentie(
  db: Backend,
  actieId: string,
  sequentieId: string,
  stap: number,
): Promise<void> {
  await db.query(
    `update actions set sequence_id = $2, sequence_stap = $3 where id = $1`,
    [actieId, sequentieId, stap],
  );
}

function valideerLead(lead: Lead): void {
  for (const veld of ['providerId', 'naam', 'functie', 'bedrijf', 'linkedinUrl', 'waarom'] as const) {
    const w = lead[veld];
    if (typeof w !== 'string' || w.trim() === '') {
      throw new Error(
        `Veld "lead.${veld}" is verplicht en moet een niet-lege tekst zijn.`,
      );
    }
  }
  if (!/^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(lead.linkedinUrl)) {
    throw new Error(
      `Veld "lead.linkedinUrl" moet een https://linkedin.com-URL zijn (gaf ${lead.linkedinUrl}).`,
    );
  }
}

function valideerTeksten(teksten: SequentieTeksten): void {
  for (const veld of ['invite', 'bericht', 'opvolging'] as const) {
    const w = teksten[veld];
    if (typeof w !== 'string' || w.trim() === '') {
      throw new Error(
        `Veld "teksten.${veld}" is verplicht en moet een niet-lege tekst zijn.`,
      );
    }
  }
}

// -- queries --------------------------------------------------------------

export async function vindSequentie(
  db: Backend,
  id: string,
): Promise<Sequentie | null> {
  const rijen = await db.query<SequentieRij>(
    `select ${SEQ_KOLOMMEN} from sequences where id = $1`,
    [id],
  );
  return rijen[0] ? mapSequentie(rijen[0]) : null;
}

export async function vindSequentieBijLead(
  db: Backend,
  accountId: string,
  leadLinkedinUrl: string,
): Promise<Sequentie | null> {
  const rijen = await db.query<SequentieRij>(
    `select ${SEQ_KOLOMMEN} from sequences
     where account_id = $1 and lead_linkedin_url = $2
     order by aangemaakt_op desc
     limit 1`,
    [accountId, leadLinkedinUrl],
  );
  return rijen[0] ? mapSequentie(rijen[0]) : null;
}

/**
 * Zoekt een lopende sequentie op basis van het Unipile-account-id en de
 * provider-id van de lead (zoals een webhook ze doorgeeft).
 */
export async function vindLopendeSequentieBijProvider(
  db: Backend,
  unipileAccountId: string,
  leadProviderId: string,
): Promise<Sequentie | null> {
  const rijen = await db.query<SequentieRij>(
    `select ${SEQ_KOLOMMEN.split(',').map((k) => `s.${k.trim()}`).join(', ')} from sequences s
     join accounts a on a.id = s.account_id
     where a.unipile_account_id = $1
       and s.lead_provider_id = $2
       and s.status in ('lopend', 'geaccepteerd')
     order by s.aangemaakt_op desc
     limit 1`,
    [unipileAccountId, leadProviderId],
  );
  return rijen[0] ? mapSequentie(rijen[0]) : null;
}

export async function lijstActiesVoorSequentie(
  db: Backend,
  sequentieId: string,
): Promise<
  Array<{
    id: string;
    stap: number | null;
    type: string;
    status: string;
    uitgevoerdOp: Date | null;
  }>
> {
  const rijen = await db.query<{
    id: string;
    sequence_stap: number | null;
    type: string;
    status: string;
    uitgevoerd_op: string | Date | null;
  }>(
    `select id, sequence_stap, type::text as type, status::text as status, uitgevoerd_op
     from actions where sequence_id = $1
     order by coalesce(sequence_stap, 0), aangemaakt_op`,
    [sequentieId],
  );
  return rijen.map((r) => ({
    id: r.id,
    stap: r.sequence_stap,
    type: r.type,
    status: r.status,
    uitgevoerdOp: r.uitgevoerd_op ? alsDatum(r.uitgevoerd_op) : null,
  }));
}

// -- webhook-hooks --------------------------------------------------------

export interface WebhookGevolg {
  sequentieId: string | null;
  nieuweStatus: SequentieStatus | null;
  gewijzigd: boolean;
  reden?: string;
}

/**
 * Reactie op `new_relation`: zet een lopende sequentie op `geaccepteerd` en
 * plan de aanmaak van stap 2 (eerste bericht) in. Idempotent: tweede
 * webhook voor dezelfde sequentie heeft geen effect.
 */
export async function verwerkAcceptatie(
  db: Backend,
  limieten: Limieten,
  klok: Klok,
  werkdagen: WerkdagenKiezer,
  invoer: { accountId: string; leadProviderId: string; accountTijdzone: string },
): Promise<WebhookGevolg> {
  const sequentie = await vindLopendeSequentieBijLead(db, invoer.accountId, invoer.leadProviderId);
  if (!sequentie) {
    return { sequentieId: null, nieuweStatus: null, gewijzigd: false, reden: 'Geen lopende sequentie gevonden voor deze lead.' };
  }
  if (sequentie.status !== 'lopend') {
    return {
      sequentieId: sequentie.id,
      nieuweStatus: sequentie.status,
      gewijzigd: false,
      reden: `Sequentie heeft status "${sequentie.status}"; geen stap 2 ingepland.`,
    };
  }
  const bereik = limieten.sequenties.wachttijden_werkdagen.eerste_bericht_na_acceptatie;
  const dagen = werkdagen.kies(bereik);
  const geplandOp = teltDoorWerkdagen(klok.nu(), dagen, invoer.accountTijdzone);

  const geldig = await db.query<SequentieRij>(
    `update sequences
       set status = 'geaccepteerd', stap = 1, volgende_actie_op = $2
     where id = $1 and status = 'lopend'
     returning ${SEQ_KOLOMMEN}`,
    [sequentie.id, geplandOp.toISOString()],
  );
  if (!geldig[0]) {
    // Race: iemand anders was eerder; opnieuw lezen voor stabiele uitkomst.
    return { sequentieId: sequentie.id, nieuweStatus: sequentie.status, gewijzigd: false };
  }
  return { sequentieId: sequentie.id, nieuweStatus: 'geaccepteerd', gewijzigd: true };
}

/**
 * Reactie op `message_received` van de lead: stop de sequentie en wijs
 * openstaande `draft`/`queued`-stappen af met de standaardreden.
 */
export async function verwerkReactie(
  db: Backend,
  limieten: Limieten,
  invoer: { accountId: string; chatId?: string; leadProviderId?: string | undefined },
): Promise<WebhookGevolg> {
  const sequentie = await vindActieveSequentieBijReactie(db, invoer);
  if (!sequentie) {
    return { sequentieId: null, nieuweStatus: null, gewijzigd: false, reden: 'Geen actieve sequentie herkend voor deze reactie.' };
  }
  if (sequentie.status === 'reactie' || sequentie.status === 'gestopt' || sequentie.status === 'mislukt') {
    return { sequentieId: sequentie.id, nieuweStatus: sequentie.status, gewijzigd: false };
  }
  const reden = limieten.sequenties.stop_redenen.reactie;
  await db.transaction(async (tx) => {
    await tx.query(
      `update sequences
         set status = 'reactie', volgende_actie_op = null, stop_reden = $2
       where id = $1 and status in ('lopend', 'geaccepteerd')`,
      [sequentie.id, reden],
    );
    await tx.query(
      `update actions
         set status = 'rejected'::action_status, reden = $2
       where sequence_id = $1 and status in ('draft', 'queued', 'approved')`,
      [sequentie.id, reden],
    );
    return true as const;
  });
  return { sequentieId: sequentie.id, nieuweStatus: 'reactie', gewijzigd: true };
}

/**
 * Afwijzing van een sequentie-stap op de goedkeuringspagina: stop de
 * sequentie (`gestopt`, stop_reden "afgewezen bij goedkeuring: <reden>") en
 * wijs de overige openstaande stappen af. Roep aan binnen dezelfde transactie
 * als het afwijzen van de actie. Geeft het sequentie-id terug, of `null` als
 * de actie niet bij een actieve sequentie hoort.
 */
export async function stopSequentieNaAfwijzing(
  db: Backend,
  limieten: Limieten,
  invoer: { actieId: string; reden: string },
): Promise<string | null> {
  const stopReden = `${limieten.sequenties.stop_redenen.afgewezen}: ${invoer.reden}`;
  const rijen = await db.query<{ id: string }>(
    `update sequences s
       set status = 'gestopt', volgende_actie_op = null, stop_reden = $2
     from actions a
     where a.id = $1
       and s.id = a.sequence_id
       and s.status in ('lopend', 'geaccepteerd')
     returning s.id`,
    [invoer.actieId, stopReden],
  );
  const sequentieId = rijen[0]?.id;
  if (!sequentieId) return null;
  await db.query(
    `update actions
       set status = 'rejected'::action_status, reden = $3
     where sequence_id = $1 and id <> $2 and status in ('draft', 'queued', 'approved')`,
    [sequentieId, invoer.actieId, stopReden],
  );
  return sequentieId;
}

async function vindLopendeSequentieBijLead(
  db: Backend,
  accountId: string,
  leadProviderId: string,
): Promise<Sequentie | null> {
  const rijen = await db.query<SequentieRij>(
    `select ${SEQ_KOLOMMEN} from sequences
     where account_id = $1
       and lead_provider_id = $2
       and status in ('lopend', 'geaccepteerd')
     order by aangemaakt_op desc
     limit 1`,
    [accountId, leadProviderId],
  );
  return rijen[0] ? mapSequentie(rijen[0]) : null;
}

async function vindActieveSequentieBijReactie(
  db: Backend,
  invoer: { accountId: string; chatId?: string; leadProviderId?: string | undefined },
): Promise<Sequentie | null> {
  if (invoer.leadProviderId) {
    const bijLead = await vindLopendeSequentieBijLead(db, invoer.accountId, invoer.leadProviderId);
    if (bijLead) return bijLead;
  }
  if (invoer.chatId) {
    // Chat-id staat soms in de message-payload van een stap-2/3 actie; zoeken
    // via actions zodat we de sequentie-koppeling via chatId kunnen vinden
    // als provider-id ontbreekt.
    const rijen = await db.query<SequentieRij>(
      `select ${SEQ_KOLOMMEN.split(',').map((k) => `s.${k.trim()}`).join(', ')} from sequences s
       join actions a on a.sequence_id = s.id
       where s.account_id = $1
         and s.status in ('lopend', 'geaccepteerd')
         and a.payload ->> 'chatId' = $2
       order by s.aangemaakt_op desc
       limit 1`,
      [invoer.accountId, invoer.chatId],
    );
    if (rijen[0]) return mapSequentie(rijen[0]);
  }
  return null;
}

// -- tick ------------------------------------------------------------------

export interface SequentieTickContext {
  db: Backend;
  klok: Klok;
  limieten: Limieten;
  werkdagen: WerkdagenKiezer;
}

export interface SequentieTickResultaat {
  verlopen: string[];
  stap2Aangemaakt: string[];
  stap3Aangemaakt: string[];
  afgerond: string[];
  overgeslagenDoorAccount: string[];
}

/**
 * Idempotente sequentie-tick (SPEC §8a.4). Verwerkt in deze volgorde:
 *   1. 21-dagen-verval van invites die nog niet geaccepteerd zijn.
 *   2. Stap 2: maak eerste bericht aan voor sequenties waarvan de wacht om is.
 *   3. Stap 3: maak opvolging aan nadat stap 2 is verstuurd en wacht om is.
 *   4. Afronden: sequenties waarvan stap 3 is verstuurd → status 'gestopt'.
 *
 * Account-pauze (`CREDENTIALS`, `ERROR`, `STOPPED`, afkoeling) laat de tick de
 * sequentie overslaan tot het account weer `OK`/`RECONNECTED` is.
 */
export async function verwerkSequentieTick(
  ctx: SequentieTickContext,
): Promise<SequentieTickResultaat> {
  const nu = ctx.klok.nu();
  const resultaat: SequentieTickResultaat = {
    verlopen: [],
    stap2Aangemaakt: [],
    stap3Aangemaakt: [],
    afgerond: [],
    overgeslagenDoorAccount: [],
  };

  // 1. 21-dagen-verval van 'lopend' sequenties die nog niet geaccepteerd zijn.
  const vervalDagen = ctx.limieten.sequenties.verzoek_vervalt_na_dagen;
  const grens = new Date(nu.getTime() - vervalDagen * 24 * 60 * 60 * 1000);
  const verlopen = await ctx.db.query<{ id: string }>(
    `update sequences
       set status = 'gestopt', stop_reden = $2, volgende_actie_op = null
     where status = 'lopend' and aangemaakt_op <= $1
     returning id`,
    [grens.toISOString(), ctx.limieten.sequenties.stop_redenen.niet_geaccepteerd],
  );
  for (const rij of verlopen) resultaat.verlopen.push(rij.id);

  // 2. Stap 2: 'geaccepteerd', stap=1, volgende_actie_op <= nu.
  const kandStap2 = await ctx.db.query<SequentieRij & { account_tijdzone: string }>(
    `select ${SEQ_KOLOMMEN.split(',').map((k) => `s.${k.trim()}`).join(', ')},
            a.tijdzone as account_tijdzone
     from sequences s
     join accounts a on a.id = s.account_id
     where s.status = 'geaccepteerd'
       and s.stap = 1
       and s.volgende_actie_op <= $1
       and a.status in ('OK', 'RECONNECTED')
       and (a.afkoeling_tot is null or a.afkoeling_tot <= $1)`,
    [nu.toISOString()],
  );
  for (const rij of kandStap2) {
    const sequentie = mapSequentie(rij);
    const nieuweActie = await maakStapActie(ctx.db, sequentie, 2);
    if (nieuweActie) {
      const bereik = ctx.limieten.sequenties.wachttijden_werkdagen.opvolging_na_eerste_bericht;
      const dagen = ctx.werkdagen.kies(bereik);
      const volgend = teltDoorWerkdagen(nu, dagen, rij.account_tijdzone);
      await ctx.db.query(
        `update sequences set stap = 2, volgende_actie_op = $2 where id = $1`,
        [sequentie.id, volgend.toISOString()],
      );
      resultaat.stap2Aangemaakt.push(sequentie.id);
    }
  }

  // 3. Stap 3: stap=2, vorige actie (sequence_stap=2) status='done',
  //    volgende_actie_op <= nu.
  const kandStap3 = await ctx.db.query<SequentieRij>(
    `select ${SEQ_KOLOMMEN.split(',').map((k) => `s.${k.trim()}`).join(', ')} from sequences s
     join accounts a on a.id = s.account_id
     where s.status = 'geaccepteerd'
       and s.stap = 2
       and s.volgende_actie_op <= $1
       and a.status in ('OK', 'RECONNECTED')
       and (a.afkoeling_tot is null or a.afkoeling_tot <= $1)
       and exists (
         select 1 from actions
         where sequence_id = s.id and sequence_stap = 2 and status = 'done'
       )`,
    [nu.toISOString()],
  );
  for (const rij of kandStap3) {
    const sequentie = mapSequentie(rij);
    const nieuweActie = await maakStapActie(ctx.db, sequentie, 3);
    if (nieuweActie) {
      await ctx.db.query(
        `update sequences set stap = 3, volgende_actie_op = null where id = $1`,
        [sequentie.id],
      );
      resultaat.stap3Aangemaakt.push(sequentie.id);
    }
  }

  // 4. Afronden: stap=3 en stap-3-actie 'done' → status 'gestopt' (voltooid).
  const voltooid = await ctx.db.query<{ id: string }>(
    `update sequences
       set status = 'gestopt', stop_reden = $1, volgende_actie_op = null
     where status = 'geaccepteerd'
       and stap = 3
       and exists (
         select 1 from actions
         where sequence_id = sequences.id and sequence_stap = 3 and status = 'done'
       )
     returning id`,
    [ctx.limieten.sequenties.stop_redenen.voltooid],
  );
  for (const rij of voltooid) resultaat.afgerond.push(rij.id);

  return resultaat;
}

/**
 * Maakt de `draft`-actie voor stap 2 of 3 aan. Idempotent: als er al een
 * actie bestaat voor deze (sequence_id, sequence_stap), gebeurt er niets en
 * geven we null terug.
 */
async function maakStapActie(
  db: Backend,
  sequentie: Sequentie,
  stap: 2 | 3,
): Promise<Actie | null> {
  return db.transaction(async (tx) => {
    const bestaand = await tx.query<{ id: string }>(
      `select id from actions where sequence_id = $1 and sequence_stap = $2 limit 1`,
      [sequentie.id, stap],
    );
    if (bestaand[0]) return null;

    const chatId = await vindChatIdVoorSequentie(tx, sequentie);
    const tekst = stap === 2 ? sequentie.tekstBericht : sequentie.tekstOpvolging;

    const actie = await maakActie(tx, {
      accountId: sequentie.accountId,
      type: 'message',
      payload: {
        chatId: chatId ?? `pending:${sequentie.leadProviderId ?? sequentie.leadLinkedinUrl}`,
        tekst,
        ontvanger_naam: sequentie.leadNaam,
        ontvanger_functie: sequentie.leadFunctie,
        ontvanger_bedrijf: sequentie.leadBedrijf,
        ontvanger_url: sequentie.leadLinkedinUrl,
        waarom:
          stap === 2
            ? `Sequentie stap 2 van 3: eerste bericht na acceptatie. ${sequentie.waarom}`
            : `Sequentie stap 3 van 3: opvolging zonder reactie. ${sequentie.waarom}`,
        _skill: 'sequentie',
        sequence_id: sequentie.id,
        sequence_stap: stap,
      },
    });
    await tx.query(
      `update actions set sequence_id = $2, sequence_stap = $3 where id = $1`,
      [actie.id, sequentie.id, stap],
    );
    return actie;
  });
}

/**
 * Een stap-2/3 message vraagt om een `chatId`. De webhook `new_relation`
 * levert die vaak nog niet mee; de skills kunnen hem later meegeven via
 * een update-API, maar v1 vult hem placeholder-wijze zodat de goedkeurder
 * ziet dat hij nog moet worden ingevuld.
 */
async function vindChatIdVoorSequentie(
  db: Backend,
  sequentie: Sequentie,
): Promise<string | null> {
  const rijen = await db.query<{ chat_id: string | null }>(
    `select payload ->> 'chatId' as chat_id
     from actions
     where sequence_id = $1 and sequence_stap < 3
     order by sequence_stap desc
     limit 1`,
    [sequentie.id],
  );
  return rijen[0]?.chat_id ?? null;
}
