import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vindActie, zetActieStatus } from '../queue/acties.ts';
import {
  markeerAccountGekoppeld,
  registreerAccount,
  werkAccountStatusBij,
} from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  startSequentie,
  stopSequentieNaAfwijzing,
  verwerkAcceptatie,
  verwerkReactie,
  verwerkSequentieTick,
  vindSequentie,
} from './motor.ts';
import { vasteWerkdagen } from './wachttijd.ts';

let db: Backend;
let close: () => Promise<void>;
let accountId: string;
let limieten: Limieten;

before(async () => {
  const op = await verseDatabaseMetMigraties();
  db = op.db;
  close = op.close;
  limieten = await laadLimieten();
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from accounts');
  await db.query('delete from clients');

  const klant = await maakClient(db, { naam: 'Test', slug: 't' });
  const account = await registreerAccount(db, {
    clientId: klant.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'uni-rubert');
});

function basisLead(overschrijf: Partial<Record<string, string>> = {}) {
  return {
    providerId: 'ACo-nina',
    naam: 'Nina Jansen',
    functie: 'Marketing manager',
    bedrijf: 'Acme NV',
    linkedinUrl: 'https://www.linkedin.com/in/nina-jansen/',
    waarom: 'Lead uit zoekactie "logistiek marketing" (score 0.82).',
    ...overschrijf,
  };
}

function basisTeksten() {
  return {
    invite: 'Hoi Nina, zullen we even sparren?',
    bericht: 'Dag Nina, dank voor de connectie!',
    opvolging: 'Nog even een korte herinnering — ben benieuwd!',
  };
}

describe('startSequentie', () => {
  it('maakt een sequentie met stap=0, status=lopend en een draft-invite als enige actie', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    assert.equal(uit.sequentie.stap, 0);
    assert.equal(uit.sequentie.status, 'lopend');
    assert.equal(uit.sequentie.leadNaam, 'Nina Jansen');

    const actie = await vindActie(db, uit.invite!.id);
    assert.equal(actie?.type, 'invite');
    assert.equal(actie?.status, 'draft', 'invite hoort als draft te starten');
    assert.equal(actie?.goedgekeurdDoor, null);
    assert.equal(actie?.goedgekeurdOp, null);

    const payload = actie?.payload as Record<string, unknown>;
    assert.equal(payload['providerId'], 'ACo-nina');
    assert.equal(payload['ontvanger_naam'], 'Nina Jansen');
    assert.equal(payload['sequence_id'], uit.sequentie.id);
    assert.equal(payload['sequence_stap'], 1);
  });

  it('weigert een tweede sequentie voor dezelfde lead op hetzelfde account', async () => {
    await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    await assert.rejects(
      () =>
        startSequentie(db, {
          accountId,
          lead: basisLead(),
          teksten: basisTeksten(),
        }),
      /Er loopt al een sequentie/,
    );
  });

  it('weigert opnieuw starten nadat de lead reageerde', async () => {
    const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
    await db.query(`update sequences set status = 'reactie' where id = $1`, [uit.sequentie.id]);
    await assert.rejects(
      () => startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() }),
      /al een sequentie/,
    );
  });

  it('weigert opnieuw starten na "verzoek niet geaccepteerd" of "voltooid"', async () => {
    const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
    await db.query(
      `update sequences set status = 'gestopt', stop_reden = 'verzoek niet geaccepteerd' where id = $1`,
      [uit.sequentie.id],
    );
    await assert.rejects(
      () => startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() }),
      /al een sequentie/,
    );
  });

  it('staat opnieuw starten toe na afwijzing, maar niet een derde parallel', async () => {
    const eerste = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
    await zetActieStatus(db, eerste.invite!.id, 'rejected', { reden: 'tekst' });
    await stopSequentieNaAfwijzing(db, limieten, { actieId: eerste.invite!.id, reden: 'tekst' });
    await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
    await assert.rejects(
      () => startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() }),
      /Er loopt al een sequentie/,
    );
  });

  describe('opnieuw starten nadat de invite al verstuurd is', () => {
    /** Vorige sequentie: invite done, stap `afgewezenStap` afgewezen, gestopt. */
    async function vorigeSequentie(opties: { stap: number; afgewezenStap: 2 | 3 }) {
      const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
      await zetActieStatus(db, uit.invite!.id, 'done');
      await db.query(
        `update sequences set stap = $2, status = 'gestopt',
           stop_reden = 'afgewezen bij goedkeuring: te lang'
         where id = $1`,
        [uit.sequentie.id, opties.stap],
      );
      await db.query(
        `insert into actions(account_id, type, payload, status, sequence_id, sequence_stap)
         values ($1, 'message', '{"chatId":"C-oud","tekst":"oud"}', 'rejected', $2, $3)`,
        [accountId, uit.sequentie.id, opties.afgewezenStap],
      );
      return uit.sequentie.id;
    }

    it('invite geaccepteerd (stap 2 afgewezen): nieuwe sequentie begint bij stap 2', async () => {
      const vorige = await vorigeSequentie({ stap: 2, afgewezenStap: 2 });
      const uit = await startSequentie(db, {
        accountId,
        lead: basisLead(),
        teksten: { ...basisTeksten(), bericht: 'Dag Nina, verbeterd bericht.' },
      });
      assert.notEqual(uit.sequentie.id, vorige);
      assert.equal(uit.beginStap, 2);
      assert.equal(uit.invite, null);
      assert.equal(uit.sequentie.status, 'geaccepteerd');
      assert.equal(uit.sequentie.stap, 1);
      assert.ok(uit.sequentie.volgendeActieOp instanceof Date);

      const acties = await db.query<{ type: string }>(
        `select type::text as type from actions where sequence_id = $1`,
        [uit.sequentie.id],
      );
      assert.equal(acties.length, 0, 'geen nieuwe invite');

      // De tick maakt stap 2 met de nieuwe tekst en de chat van de vorige sequentie.
      const r = await verwerkSequentieTick({
        db,
        klok: vasteKlok(new Date(Date.now() + 60_000)),
        limieten,
        werkdagen: vasteWerkdagen(5),
      });
      assert.deepEqual(r.stap2Aangemaakt, [uit.sequentie.id]);
      const stap2 = await db.query<{ payload: Record<string, unknown> }>(
        `select payload from actions where sequence_id = $1 and sequence_stap = 2`,
        [uit.sequentie.id],
      );
      assert.equal(stap2[0]?.payload['tekst'], 'Dag Nina, verbeterd bericht.');
      assert.equal(stap2[0]?.payload['chatId'], 'C-oud');
    });

    it('stap 3 afgewezen: nieuwe sequentie begint ook bij stap 2', async () => {
      await vorigeSequentie({ stap: 3, afgewezenStap: 3 });
      const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
      assert.equal(uit.beginStap, 2);
      assert.equal(uit.invite, null);
    });

    it('acceptatie alleen bekend uit een event: ook bij stap 2 beginnen', async () => {
      await vorigeSequentie({ stap: 0, afgewezenStap: 2 });
      await db.query(
        `insert into events(bron, type, extern_id, account_id, payload)
         values ('gateway', 'acceptatie', 'acceptatie:uni-rubert:ACo-nina', $1,
                 '{"attendee_provider_id":"ACo-nina"}')`,
        [accountId],
      );
      const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
      assert.equal(uit.beginStap, 2);
    });

    it('invite verstuurd maar nog niet geaccepteerd: weigert met duidelijke melding', async () => {
      await vorigeSequentie({ stap: 0, afgewezenStap: 2 });
      await assert.rejects(
        () => startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() }),
        /invite.*al verstuurd.*nog niet geaccepteerd/i,
      );
      const aantal = await db.query<{ n: string }>(
        `select count(*)::text as n from sequences where account_id = $1`,
        [accountId],
      );
      assert.equal(aantal[0]?.n, '1', 'geen nieuwe sequentie aangemaakt');
    });

    it('stap 1 afgewezen (invite nooit verstuurd): begint gewoon bij stap 1', async () => {
      const eerste = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
      await zetActieStatus(db, eerste.invite!.id, 'rejected', { reden: 'tekst' });
      await stopSequentieNaAfwijzing(db, limieten, { actieId: eerste.invite!.id, reden: 'tekst' });
      const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
      assert.equal(uit.beginStap, 1);
      assert.equal(uit.invite?.status, 'draft');
      assert.equal(uit.sequentie.status, 'lopend');
    });
  });

  it('de database staat geen twee actieve sequenties voor dezelfde lead toe', async () => {
    const uit = await startSequentie(db, { accountId, lead: basisLead(), teksten: basisTeksten() });
    await assert.rejects(
      () =>
        db.query(
          `insert into sequences(account_id, lead_linkedin_url, status) values ($1, $2, 'geaccepteerd')`,
          [accountId, uit.sequentie.leadLinkedinUrl],
        ),
      /duplicate|unique/i,
    );
  });

  it('weigert als een lead-veld of een tekst ontbreekt', async () => {
    await assert.rejects(
      () =>
        startSequentie(db, {
          accountId,
          lead: basisLead({ naam: '' }),
          teksten: basisTeksten(),
        }),
      /lead\.naam/,
    );
    await assert.rejects(
      () =>
        startSequentie(db, {
          accountId,
          lead: basisLead(),
          teksten: { ...basisTeksten(), opvolging: '  ' },
        }),
      /teksten\.opvolging/,
    );
  });
});

describe('verwerkAcceptatie (new_relation)', () => {
  it('zet status op geaccepteerd en plant volgende_actie_op in', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });

    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z')); // ma
    const gevolg = await verwerkAcceptatie(
      db,
      limieten,
      klok,
      vasteWerkdagen(2),
      {
        accountId,
        leadProviderId: 'ACo-nina',
        accountTijdzone: 'Europe/Amsterdam',
      },
    );

    assert.equal(gevolg.gewijzigd, true);
    assert.equal(gevolg.nieuweStatus, 'geaccepteerd');

    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'geaccepteerd');
    assert.equal(seq?.stap, 1);
    assert.ok(seq?.volgendeActieOp instanceof Date);
    // 2 werkdagen na ma 2026-10-05 = wo 2026-10-07.
    assert.ok(
      seq!.volgendeActieOp!.toISOString().startsWith('2026-10-07'),
      `verwacht 2026-10-07, kreeg ${seq!.volgendeActieOp!.toISOString()}`,
    );
  });

  it('is idempotent: een tweede new_relation voor dezelfde sequentie wijzigt niets', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z'));
    await verwerkAcceptatie(db, limieten, klok, vasteWerkdagen(2), {
      accountId,
      leadProviderId: 'ACo-nina',
      accountTijdzone: 'Europe/Amsterdam',
    });
    const seqNa1 = await vindSequentie(db, uit.sequentie.id);
    const tweede = await verwerkAcceptatie(db, limieten, klok, vasteWerkdagen(3), {
      accountId,
      leadProviderId: 'ACo-nina',
      accountTijdzone: 'Europe/Amsterdam',
    });
    assert.equal(tweede.gewijzigd, false);
    const seqNa2 = await vindSequentie(db, uit.sequentie.id);
    assert.deepEqual(seqNa2?.volgendeActieOp, seqNa1?.volgendeActieOp);
  });

  it('doet niets als er geen sequentie voor deze lead is', async () => {
    const gevolg = await verwerkAcceptatie(db, limieten, vasteKlok(new Date()), vasteWerkdagen(1), {
      accountId,
      leadProviderId: 'ACo-onbekend',
      accountTijdzone: 'Europe/Amsterdam',
    });
    assert.equal(gevolg.gewijzigd, false);
    assert.equal(gevolg.sequentieId, null);
  });
});

describe('verwerkReactie (message_received)', () => {
  it('zet status op reactie en wijst openstaande drafts af', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });

    const gevolg = await verwerkReactie(db, limieten, {
      accountId,
      leadProviderId: 'ACo-nina',
    });
    assert.equal(gevolg.gewijzigd, true);
    assert.equal(gevolg.nieuweStatus, 'reactie');

    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'reactie');
    assert.equal(seq?.stopReden, 'lead heeft gereageerd');

    const invite = await vindActie(db, uit.invite!.id);
    assert.equal(invite?.status, 'rejected');
    assert.match(invite?.reden ?? '', /gereageerd/);
  });

  it('maakt geen nieuwe acties aan nadat de sequentie op reactie staat', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    await verwerkReactie(db, limieten, { accountId, leadProviderId: 'ACo-nina' });

    const voor = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from actions where sequence_id = $1`,
      [uit.sequentie.id],
    );
    const voorAantal = Number(voor[0]?.aantal ?? '0');

    // Nu een tick draaien — mag niets toevoegen.
    const klok = vasteKlok(new Date('2026-11-01T10:00:00Z'));
    await verwerkSequentieTick({
      db,
      klok,
      limieten,
      werkdagen: vasteWerkdagen(1),
    });

    const na = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from actions where sequence_id = $1`,
      [uit.sequentie.id],
    );
    assert.equal(Number(na[0]?.aantal), voorAantal);
  });
});

describe('verwerkSequentieTick', () => {
  it('verloopt een niet-geaccepteerd verzoek na 21 dagen', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    // Zet aangemaakt_op 22 dagen terug.
    await db.query(
      `update sequences set aangemaakt_op = now() - interval '22 days' where id = $1`,
      [uit.sequentie.id],
    );
    const klok = vasteKlok(new Date());
    const r = await verwerkSequentieTick({
      db,
      klok,
      limieten,
      werkdagen: vasteWerkdagen(1),
    });
    assert.deepEqual(r.verlopen, [uit.sequentie.id]);
    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'gestopt');
    assert.equal(seq?.stopReden, 'verzoek niet geaccepteerd');
  });

  it('maakt stap 2 (bericht) aan als volgende_actie_op bereikt is', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    // Zet handmatig de acceptatie: status geaccepteerd, stap 1, volgende_actie_op = past.
    await db.query(
      `update sequences
         set status = 'geaccepteerd', stap = 1, volgende_actie_op = now() - interval '1 hour'
       where id = $1`,
      [uit.sequentie.id],
    );
    const klok = vasteKlok(new Date());
    const r = await verwerkSequentieTick({
      db,
      klok,
      limieten,
      werkdagen: vasteWerkdagen(6),
    });
    assert.deepEqual(r.stap2Aangemaakt, [uit.sequentie.id]);

    const acties = await db.query<{ sequence_stap: number; status: string; type: string }>(
      `select sequence_stap, status::text as status, type::text as type
       from actions where sequence_id = $1 order by sequence_stap`,
      [uit.sequentie.id],
    );
    assert.equal(acties.length, 2);
    assert.equal(acties[1]!.sequence_stap, 2);
    assert.equal(acties[1]!.type, 'message');
    assert.equal(acties[1]!.status, 'draft');

    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.stap, 2);
    assert.ok(seq?.volgendeActieOp instanceof Date);
  });

  it('is idempotent: twee ticks maken niet twee stap-2-acties', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    await db.query(
      `update sequences
         set status = 'geaccepteerd', stap = 1, volgende_actie_op = now() - interval '1 hour'
       where id = $1`,
      [uit.sequentie.id],
    );
    const klok = vasteKlok(new Date());
    await verwerkSequentieTick({ db, klok, limieten, werkdagen: vasteWerkdagen(6) });
    await verwerkSequentieTick({ db, klok, limieten, werkdagen: vasteWerkdagen(6) });
    const rijen = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from actions where sequence_id = $1 and sequence_stap = 2`,
      [uit.sequentie.id],
    );
    assert.equal(Number(rijen[0]?.aantal), 1);
  });

  it('slaat sequenties over wanneer het account CREDENTIALS heeft', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    await db.query(
      `update sequences
         set status = 'geaccepteerd', stap = 1, volgende_actie_op = now() - interval '1 hour'
       where id = $1`,
      [uit.sequentie.id],
    );
    await werkAccountStatusBij(db, accountId, 'CREDENTIALS');
    const klok = vasteKlok(new Date());
    const r = await verwerkSequentieTick({
      db,
      klok,
      limieten,
      werkdagen: vasteWerkdagen(6),
    });
    assert.deepEqual(r.stap2Aangemaakt, []);
    const rijen = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from actions where sequence_id = $1 and sequence_stap = 2`,
      [uit.sequentie.id],
    );
    assert.equal(Number(rijen[0]?.aantal), 0);
  });

  it('maakt stap 3 (opvolging) aan nadat stap 2 is uitgevoerd en wachttijd om is', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: basisLead(),
      teksten: basisTeksten(),
    });
    await db.query(
      `update sequences
         set status = 'geaccepteerd', stap = 1, volgende_actie_op = now() - interval '1 hour'
       where id = $1`,
      [uit.sequentie.id],
    );
    // Eerste tick maakt stap 2 aan.
    await verwerkSequentieTick({
      db,
      klok: vasteKlok(new Date()),
      limieten,
      werkdagen: vasteWerkdagen(6),
    });
    // Markeer stap 2 als uitgevoerd (done) en zet volgende_actie_op in het verleden.
    const stap2 = await db.query<{ id: string }>(
      `select id from actions where sequence_id = $1 and sequence_stap = 2`,
      [uit.sequentie.id],
    );
    await zetActieStatus(db, stap2[0]!.id, 'done', { uitgevoerdOp: new Date() });
    await db.query(
      `update sequences set volgende_actie_op = now() - interval '1 hour' where id = $1`,
      [uit.sequentie.id],
    );

    const r = await verwerkSequentieTick({
      db,
      klok: vasteKlok(new Date()),
      limieten,
      werkdagen: vasteWerkdagen(6),
    });
    assert.deepEqual(r.stap3Aangemaakt, [uit.sequentie.id]);
    const opvolging = await db.query<{ sequence_stap: number; status: string; type: string }>(
      `select sequence_stap, status::text as status, type::text as type
       from actions where sequence_id = $1 and sequence_stap = 3`,
      [uit.sequentie.id],
    );
    assert.equal(opvolging.length, 1);
    assert.equal(opvolging[0]!.type, 'message');
    assert.equal(opvolging[0]!.status, 'draft');
  });
});
