import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startSequentie } from '../sequences/motor.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  goedkeur,
  goedkeurBatch,
  herapproveOnzeker,
  lijstDrafts,
  lijstOnzeker,
  markeerOnzekerAlsDone,
  wijsAf,
} from './dienst.ts';

const HIER = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HIER, '..');

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let accountId: string;
const NU = new Date('2026-10-06T10:00:00Z');
const klok = vasteKlok(NU);

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
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Markaas', slug: 'markaas-admin' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'uni-rub');
});

function ontvangerVelden(
  overschrijf: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ontvanger_naam: 'Nina Jansen',
    ontvanger_functie: 'Marketing manager',
    ontvanger_bedrijf: 'Acme NV',
    ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
    waarom: 'Afkomstig uit zoekactie X-123.',
    ...overschrijf,
  };
}

async function maakDraft(type: 'invite' | 'message' | 'inmail', payload: Record<string, unknown>) {
  return await maakActie(db, {
    accountId,
    type,
    payload: { ...ontvangerVelden(), ...payload },
  });
}

describe('lijstDrafts', () => {
  it('toont draft invites met ontvanger (naam/functie/bedrijf/url), waarom, skill, tekenMax en resterend budget', async () => {
    await maakDraft('invite', {
      providerId: 'ACo-abc',
      message: 'Hoi, zullen we even bellen?',
      _skill: 'leadworker',
    });
    const drafts = await lijstDrafts(db, { limieten, klok });
    assert.equal(drafts.length, 1);
    const d = drafts[0]!;
    assert.equal(d.type, 'invite');
    assert.equal(d.ontvanger.naam, 'Nina Jansen');
    assert.equal(d.ontvanger.functie, 'Marketing manager');
    assert.equal(d.ontvanger.bedrijf, 'Acme NV');
    assert.equal(d.ontvanger.url, 'https://www.linkedin.com/in/nina-jansen/');
    assert.equal(d.ontvanger.technischeId, 'ACo-abc');
    assert.match(d.tekst, /Hoi, zullen we even bellen/);
    assert.match(d.waarom, /zoekactie X-123/);
    assert.equal(d.tekenMax, 300);
    assert.equal(d.aangemaaktDoorSkill, 'leadworker');
    assert.equal(d.clientNaam, 'Markaas');
    assert.equal(d.eigenaarNaam, 'Rubert');
    assert.ok(d.budget.dag, 'invite heeft een dagbudget');
    assert.equal(d.budget.dag!.norm, 10); // salesnav_core 20/dag × opbouwFactor 0.5
    assert.equal(d.budget.dag!.resterend, 10);
  });

  it('toont tekenMax 8000 voor message en 2000 voor inmail', async () => {
    await maakDraft('message', { chatId: 'C-1', tekst: 'Hoi' });
    await maakDraft('inmail', { attendeesIds: ['ACo-a'], tekst: 'Hoi', onderwerp: 'Vraag' });
    const drafts = await lijstDrafts(db, { limieten, klok });
    const msg = drafts.find((d) => d.type === 'message')!;
    const im = drafts.find((d) => d.type === 'inmail')!;
    assert.equal(msg.tekenMax, 8000);
    assert.equal(im.tekenMax, 2000);
  });

  it('toont "onbekend" als geen skill in de payload staat', async () => {
    await maakDraft('message', { chatId: 'C-1', tekst: 'Hoi' });
    const drafts = await lijstDrafts(db, { limieten, klok });
    assert.equal(drafts[0]?.aangemaaktDoorSkill, 'onbekend');
  });

  it('toont geen search of profile in de drafts-lijst', async () => {
    await maakActie(db, {
      accountId,
      type: 'profile',
      payload: { identifier: 'x' },
      directApproved: true,
    });
    const drafts = await lijstDrafts(db, { limieten, klok });
    assert.equal(drafts.length, 0);
  });

  it('toont sequentie-herkomst bij een draft die uit start_sequence komt', async () => {
    const seq = await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sv',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead uit zoekactie',
      },
      teksten: {
        invite: 'Hoi Sven',
        bericht: 'Dank Sven',
        opvolging: 'Reminder Sven',
      },
    });
    const drafts = await lijstDrafts(db, { limieten, klok });
    const d = drafts.find((x) => x.actieId === seq.invite.id)!;
    assert.ok(d.sequentie, 'draft uit een sequentie heeft een sequentie-blok');
    assert.equal(d.sequentie!.sequentieId, seq.sequentie.id);
    assert.equal(d.sequentie!.stap, 1);
    assert.equal(d.sequentie!.totaalStappen, 3);
    assert.ok(d.sequentie!.gestartOp instanceof Date);
  });

  it('filtert op accountId wanneer meegegeven', async () => {
    await maakDraft('invite', { providerId: 'ACo-abc' });
    const andere = await maakClient(db, { naam: 'A2', slug: 'a2' });
    const andereAcc = await registreerAccount(db, {
      clientId: andere.id,
      eigenaarNaam: 'Ander',
      abonnement: 'free',
    });
    await maakActie(db, {
      accountId: andereAcc.id,
      type: 'invite',
      payload: { providerId: 'B' },
    });
    const d1 = await lijstDrafts(db, { limieten, klok, accountId });
    assert.equal(d1.length, 1);
    const d2 = await lijstDrafts(db, { limieten, klok });
    assert.equal(d2.length, 2);
  });
});

describe('goedkeur', () => {
  it('zet goedgekeurd_door = "rubert" en goedgekeurd_op op nu', async () => {
    const draft = await maakDraft('invite', { providerId: 'ACo-abc' });
    const g = await goedkeur(db, draft.id, { klok });
    assert.equal(g.status, 'approved');
    assert.equal(g.goedgekeurdDoor, 'rubert');
    assert.equal(g.goedgekeurdOp?.toISOString(), NU.toISOString());
  });

  it('werkt de tekst bij voordat ze goedgekeurd wordt', async () => {
    const draft = await maakDraft('invite', { providerId: 'ACo-abc', message: 'oud' });
    await goedkeur(db, draft.id, { klok, nieuweTekst: 'nieuw bericht' });
    const na = await vindActie(db, draft.id);
    assert.equal((na?.payload as { message?: string })?.message, 'nieuw bericht');
    assert.equal(na?.status, 'approved');
  });

  it('weigert tekst aan te passen op een al goedgekeurde actie', async () => {
    const draft = await maakDraft('invite', { providerId: 'A' });
    await goedkeur(db, draft.id, { klok });
    await assert.rejects(
      () => goedkeur(db, draft.id, { klok, nieuweTekst: 'te laat' }),
      /tekst alleen aan te passen op drafts/i,
    );
  });

  it('weigert server-side wanneer nieuwe tekst boven de limiet uitkomt', async () => {
    const draft = await maakDraft('invite', { providerId: 'A', message: 'kort' });
    const teLang = 'x'.repeat(limieten.tekst_max_tekens.invite + 1);
    await assert.rejects(
      () => goedkeur(db, draft.id, { klok, limieten, nieuweTekst: teLang }),
      /maximum voor invite is 300/,
    );
    const na = await vindActie(db, draft.id);
    assert.equal(na?.status, 'draft', 'actie blijft draft bij te lange tekst');
    assert.equal(
      (na?.payload as { message?: string })?.message,
      'kort',
      'tekst mag niet aangepast zijn',
    );
  });

  it('weigert server-side ook wanneer de bestaande tekst al over de limiet is (zonder nieuweTekst)', async () => {
    const teLang = 'x'.repeat(limieten.tekst_max_tekens.invite + 1);
    const draft = await maakDraft('invite', { providerId: 'A', message: teLang });
    await assert.rejects(
      () => goedkeur(db, draft.id, { klok, limieten }),
      /maximum voor invite is 300/,
    );
    const na = await vindActie(db, draft.id);
    assert.equal(na?.status, 'draft');
  });

  it('aan de rand (exact de limiet) is wel toegestaan', async () => {
    const opDeRand = 'x'.repeat(limieten.tekst_max_tekens.invite);
    const draft = await maakDraft('invite', { providerId: 'A' });
    const g = await goedkeur(db, draft.id, { klok, limieten, nieuweTekst: opDeRand });
    assert.equal(g.status, 'approved');
  });
});

describe('goedkeurBatch', () => {
  it('keurt alle geselecteerde acties in één keer goed', async () => {
    const a = await maakDraft('invite', { providerId: 'A' });
    const b = await maakDraft('invite', { providerId: 'B' });
    const r = await goedkeurBatch(db, [a.id, b.id], { klok });
    assert.deepEqual(r.goedgekeurd.sort(), [a.id, b.id].sort());
    assert.equal(r.overgeslagen.length, 0);
    const na = await vindActie(db, a.id);
    assert.equal(na?.goedgekeurdDoor, 'rubert');
  });

  it('slaat kapotte ids over en gaat door', async () => {
    const a = await maakDraft('invite', { providerId: 'A' });
    const r = await goedkeurBatch(db, [a.id, '00000000-0000-0000-0000-000000000000'], { klok });
    assert.deepEqual(r.goedgekeurd, [a.id]);
    assert.equal(r.overgeslagen.length, 1);
  });
});

describe('wijsAf', () => {
  it('zet een draft op rejected met reden', async () => {
    const d = await maakDraft('message', { chatId: 'C-1', tekst: 'oud' });
    const r = await wijsAf(db, d.id, 'niet relevant', { limieten });
    assert.equal(r.status, 'rejected');
    assert.equal(r.reden, 'niet relevant');
  });

  it('vereist een niet-lege reden', async () => {
    const d = await maakDraft('invite', { providerId: 'A' });
    await assert.rejects(() => wijsAf(db, d.id, '   ', { limieten }), /verplicht/i);
  });

  it('weigert afwijzen van een al afgeronde actie', async () => {
    const d = await maakDraft('invite', { providerId: 'A' });
    await goedkeur(db, d.id, { klok });
    await db.query(`update actions set status = 'done'::action_status where id = $1`, [d.id]);
    await assert.rejects(() => wijsAf(db, d.id, 'reden', { limieten }), /status "done"/);
  });
});

describe('wijsAf van een sequentie-stap', () => {
  const LEAD = {
    providerId: 'ACo-nina',
    naam: 'Nina Jansen',
    functie: 'Marketing manager',
    bedrijf: 'Acme NV',
    linkedinUrl: 'https://www.linkedin.com/in/nina-jansen/',
    waarom: 'Lead uit zoekactie.',
  };
  const TEKSTEN = { invite: 'Hoi Nina', bericht: 'Dank voor de connectie', opvolging: 'Reminder' };

  async function sequentie(id: string) {
    const rijen = await db.query<{
      status: string;
      stop_reden: string | null;
      volgende_actie_op: unknown;
    }>(
      `select status::text as status, stop_reden, volgende_actie_op from sequences where id = $1`,
      [id],
    );
    return rijen[0];
  }

  it('stap 1 afwijzen stopt de sequentie met de reden', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    await wijsAf(db, uit.invite.id, 'toon te formeel', { limieten });
    const seq = await sequentie(uit.sequentie.id);
    assert.equal(seq?.status, 'gestopt');
    assert.equal(seq?.stop_reden, 'afgewezen bij goedkeuring: toon te formeel');
    assert.equal(seq?.volgende_actie_op, null);
  });

  it('stap 2 afwijzen stopt een geaccepteerde sequentie', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    await db.query(`update actions set status = 'done' where id = $1`, [uit.invite.id]);
    await db.query(
      `update sequences set status = 'geaccepteerd', stap = 2, volgende_actie_op = now() where id = $1`,
      [uit.sequentie.id],
    );
    const stap2 = await maakActie(db, {
      accountId,
      type: 'message',
      payload: { ...ontvangerVelden(), chatId: 'C-1', tekst: 'Dank voor de connectie' },
    });
    await db.query(
      `update actions set sequence_id = $2, sequence_stap = 2 where id = $1`,
      [stap2.id, uit.sequentie.id],
    );

    await wijsAf(db, stap2.id, 'te lang', { limieten });
    const seq = await sequentie(uit.sequentie.id);
    assert.equal(seq?.status, 'gestopt');
    assert.equal(seq?.stop_reden, 'afgewezen bij goedkeuring: te lang');
    assert.equal(seq?.volgende_actie_op, null);
    // De al verstuurde invite blijft wat hij was.
    assert.equal((await vindActie(db, uit.invite.id))?.status, 'done');
  });

  it('wijst andere openstaande stappen van dezelfde sequentie mee af', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    const extra = await maakActie(db, {
      accountId,
      type: 'message',
      payload: { ...ontvangerVelden(), chatId: 'C-1', tekst: 'x' },
    });
    await db.query(
      `update actions set sequence_id = $2, sequence_stap = 2 where id = $1`,
      [extra.id, uit.sequentie.id],
    );
    await wijsAf(db, uit.invite.id, 'andere invalshoek', { limieten });
    const na = await vindActie(db, extra.id);
    assert.equal(na?.status, 'rejected');
    assert.equal(na?.reden, 'afgewezen bij goedkeuring: andere invalshoek');
  });

  it('na afwijzen kan een nieuwe sequentie voor dezelfde lead starten', async () => {
    const eerste = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    await wijsAf(db, eerste.invite.id, 'tekst verbeteren', { limieten });

    const tweede = await startSequentie(db, {
      accountId,
      lead: LEAD,
      teksten: { ...TEKSTEN, invite: 'Hoi Nina, verbeterde tekst' },
    });
    assert.notEqual(tweede.sequentie.id, eerste.sequentie.id);
    assert.equal(tweede.sequentie.status, 'lopend');
    assert.equal(tweede.invite.status, 'draft');
    assert.equal(tweede.invite.payload['message'], 'Hoi Nina, verbeterde tekst');
    assert.equal((await sequentie(eerste.sequentie.id))?.status, 'gestopt');
  });

  it('na stap-2-afwijzing kan ook opnieuw gestart worden', async () => {
    const eerste = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    await db.query(`update actions set status = 'done' where id = $1`, [eerste.invite.id]);
    await db.query(
      `update sequences set status = 'geaccepteerd', stap = 2 where id = $1`,
      [eerste.sequentie.id],
    );
    const stap2 = await maakActie(db, {
      accountId,
      type: 'message',
      payload: { ...ontvangerVelden(), chatId: 'C-1', tekst: 'x' },
    });
    await db.query(
      `update actions set sequence_id = $2, sequence_stap = 2 where id = $1`,
      [stap2.id, eerste.sequentie.id],
    );
    await wijsAf(db, stap2.id, 'te lang', { limieten });
    const tweede = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    assert.equal(tweede.sequentie.status, 'lopend');
  });

  it('actie zonder sequentie: geen sequentie geraakt', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD, teksten: TEKSTEN });
    const los = await maakDraft('message', { chatId: 'C-9', tekst: 'los' });
    await wijsAf(db, los.id, 'niet nodig', { limieten });
    assert.equal((await sequentie(uit.sequentie.id))?.status, 'lopend');
  });
});

describe('markeerOnzekerAlsDone / herapproveOnzeker', () => {
  async function maakOnzekerActie() {
    const d = await maakDraft('invite', { providerId: 'A' });
    await db.query(
      `update actions set status = 'onzeker'::action_status, reden = 'time-out' where id = $1`,
      [d.id],
    );
    return d;
  }

  it('zet een onzeker-actie handmatig op done met uitgevoerd_op', async () => {
    const d = await maakOnzekerActie();
    const r = await markeerOnzekerAlsDone(db, d.id, klok);
    assert.equal(r.status, 'done');
    assert.equal(r.uitgevoerdOp?.toISOString(), NU.toISOString());
  });

  it('weigert done te zetten als de status niet onzeker is', async () => {
    const d = await maakDraft('invite', { providerId: 'A' });
    await assert.rejects(() => markeerOnzekerAlsDone(db, d.id, klok), /niet 'onzeker'/);
  });

  it('zet een onzeker-actie opnieuw op approved via herapproveOnzeker (met rubert als goedkeurder)', async () => {
    const d = await maakOnzekerActie();
    const r = await herapproveOnzeker(db, d.id, klok);
    assert.equal(r.status, 'approved');
    assert.equal(r.goedgekeurdDoor, 'rubert');
    assert.equal(r.goedgekeurdOp?.toISOString(), NU.toISOString());
  });
});

describe('lijstOnzeker', () => {
  it('toont alleen onzeker-acties', async () => {
    const d = await maakDraft('invite', { providerId: 'A', message: 'Hoi' });
    await db.query(
      `update actions set status = 'onzeker'::action_status, reden = 'time-out' where id = $1`,
      [d.id],
    );
    await maakDraft('invite', { providerId: 'B' }); // blijft draft
    const uit = await lijstOnzeker(db);
    assert.equal(uit.length, 1);
    assert.equal(uit[0]?.actieId, d.id);
    assert.equal(uit[0]?.reden, 'time-out');
  });
});

describe('invariant: enige plek waar goedgekeurd_door = rubert gezet wordt', () => {
  it('alleen admin/dienst.ts roept keurActieGoed aan in src-productiecode', async () => {
    const bestanden = await scanTsBestanden(SRC_ROOT);
    const treffers: string[] = [];
    for (const pad of bestanden) {
      if (pad.endsWith('.test.ts')) continue;
      const inhoud = await readFile(pad, 'utf8');
      if (/\bkeurActieGoed\b/.test(inhoud)) {
        treffers.push(relative(SRC_ROOT, pad).split(sep).join('/'));
      }
    }
    treffers.sort();
    assert.deepEqual(treffers, ['admin/dienst.ts', 'queue/acties.ts']);
  });

  it('de letterlijke goedkeurder-waarde "rubert" staat alleen gedefinieerd in admin/dienst.ts (constante GOEDKEURDER_RUBERT)', async () => {
    const dienstPad = join(SRC_ROOT, 'admin', 'dienst.ts');
    const dienst = await readFile(dienstPad, 'utf8');
    assert.match(
      dienst,
      /GOEDKEURDER_RUBERT\s*=\s*['"]rubert['"]/,
      'dienst.ts hoort de constante GOEDKEURDER_RUBERT = "rubert" te definiëren',
    );
    const bestanden = await scanTsBestanden(SRC_ROOT);
    const andereDefinities: string[] = [];
    for (const pad of bestanden) {
      if (pad.endsWith('.test.ts')) continue;
      if (pad === dienstPad) continue;
      const inhoud = await readFile(pad, 'utf8');
      if (/(?:const|let|var)\s+\w+\s*=\s*['"]rubert['"]/.test(inhoud)) {
        andereDefinities.push(relative(SRC_ROOT, pad).split(sep).join('/'));
      }
    }
    assert.deepEqual(
      andereDefinities,
      [],
      'geen enkele andere productie-module mag de constante waarde "rubert" voor goedkeuring definiëren',
    );
  });

  it('geen productie-code buiten queue/acties.ts voert een UPDATE op goedgekeurd_door uit', async () => {
    const bestanden = await scanTsBestanden(SRC_ROOT);
    const treffers: string[] = [];
    for (const pad of bestanden) {
      if (pad.endsWith('.test.ts')) continue;
      const relPad = relative(SRC_ROOT, pad).split(sep).join('/');
      const inhoud = await readFile(pad, 'utf8');
      // Een UPDATE die goedgekeurd_door schrijft: match 'update' en 'goedgekeurd_door ='
      // op dezelfde string. Een enkele SELECT met kolomnaam telt niet.
      if (/update\s+actions[\s\S]{0,400}?goedgekeurd_door\s*=/i.test(inhoud)) {
        treffers.push(relPad);
      }
    }
    assert.deepEqual(treffers, ['queue/acties.ts']);
  });
});

async function scanTsBestanden(root: string): Promise<string[]> {
  const uit: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pad = join(root, entry.name);
    if (entry.isDirectory()) uit.push(...(await scanTsBestanden(pad)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) uit.push(pad);
  }
  return uit;
}
