import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vindActie } from '../queue/acties.ts';
import { vastePauze } from '../queue/pauze.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { McpToolInvoerFout, voerTool, type McpToolsDeps } from './tools.ts';
import { McpSynchroonFout } from './synchroon.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
let clientSlug: string;
let deps: McpToolsDeps;

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const client = await maakClient(db, { naam: 'Markaas Test', slug: 'markaas-test' });
  clientSlug = client.slug;
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'unipile-rubert');

  // vasteKlok: dinsdag 6 oktober 2026 10:00 UTC (12:00 Europe/Amsterdam, werkuur).
  deps = {
    db,
    unipile,
    limieten,
    klok: vasteKlok(new Date('2026-10-06T10:00:00Z')),
    pauzeKiezer: vastePauze(120),
  };
});

describe('voerTool: onbekende naam', () => {
  it('werpt NL-foutmelding met de bekende tool-lijst', async () => {
    await assert.rejects(
      () => voerTool(deps, 'secret_tool', {}),
      (err: Error) => {
        assert.match(err.message, /Onbekende tool "secret_tool"/);
        assert.match(err.message, /list_accounts/);
        return err instanceof McpToolInvoerFout;
      },
    );
  });
});

describe('list_accounts', () => {
  it('geeft accounts per klant, inclusief slug en opbouw-factor', async () => {
    const resultaat = (await voerTool(deps, 'list_accounts', {})) as {
      accounts: Array<Record<string, unknown>>;
    };
    assert.equal(resultaat.accounts.length, 1);
    assert.equal(resultaat.accounts[0]!['accountId'], accountId);
    assert.equal(resultaat.accounts[0]!['clientSlug'], clientSlug);
    assert.equal(resultaat.accounts[0]!['status'], 'OK');
    assert.equal(resultaat.accounts[0]!['opbouwFactor'], 0.5);
    assert.equal(resultaat.accounts[0]!['unipileGekoppeld'], true);
  });

  it('filtert op clientSlug wanneer meegegeven', async () => {
    const andere = await maakClient(db, { naam: 'Andere', slug: 'andere' });
    await registreerAccount(db, {
      clientId: andere.id,
      eigenaarNaam: 'Iemand',
      abonnement: 'free',
    });
    const resultaat = (await voerTool(deps, 'list_accounts', { clientSlug: clientSlug })) as {
      accounts: Array<Record<string, unknown>>;
    };
    assert.equal(resultaat.accounts.length, 1);
    assert.equal(resultaat.accounts[0]!['clientSlug'], clientSlug);
  });
});

describe('account_health', () => {
  it('geeft status, statusSinds en opbouwFactor', async () => {
    const resultaat = (await voerTool(deps, 'account_health', { accountId })) as Record<
      string,
      unknown
    >;
    assert.equal(resultaat['accountId'], accountId);
    assert.equal(resultaat['status'], 'OK');
    assert.equal(resultaat['opbouwFactor'], 0.5);
    assert.ok(Array.isArray(resultaat['recenteEvents']));
  });

  it('werpt NL-fout bij onbekend account', async () => {
    await assert.rejects(
      () => voerTool(deps, 'account_health', { accountId: '00000000-0000-0000-0000-000000000000' }),
      /Onbekend account/,
    );
  });

  it('eist een accountId', async () => {
    await assert.rejects(
      () => voerTool(deps, 'account_health', {}),
      /"accountId" is verplicht/,
    );
  });
});

describe('get_budget', () => {
  it('geeft dag- en weekbudget per actietype en maandbudget voor InMail', async () => {
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      budget: Record<string, { dag?: { norm: number; resterend: number }; maand?: { norm: number } }>;
      opbouwFactor: number;
      openstaandMaximum: number;
    };
    assert.equal(resultaat.opbouwFactor, 0.5);
    assert.equal(resultaat.openstaandMaximum, 500);
    assert.equal(resultaat.budget['invite']!.dag!.norm, 10); // 20 × 0.5
    assert.equal(resultaat.budget['invite']!.dag!.resterend, 10);
    assert.equal(resultaat.budget['inmail']!.maand!.norm, 50);
  });

  it('bug: search-dagnorm is 1 tijdens opbouw (salesnav_core, factor 0.5), niet 0', async () => {
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      budget: Record<string, { dag?: { norm: number; resterend: number } }>;
    };
    assert.equal(resultaat.budget['search']!.dag!.norm, 1);
    assert.equal(resultaat.budget['search']!.dag!.resterend, 1);
  });

  it('opbouwfactor geldt niet voor InMail: salesnav_core met factor 0.5 → 50/maand', async () => {
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      opbouwFactor: number;
      budget: Record<string, { maand?: { norm: number; resterend: number } }>;
    };
    assert.equal(resultaat.opbouwFactor, 0.5);
    assert.equal(resultaat.budget['inmail']!.maand!.norm, 50);
    assert.equal(resultaat.budget['inmail']!.maand!.resterend, 50);
  });

  it('buiten afkoeling: afkoelingTot is null en er is geen reden', async () => {
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as Record<string, unknown>;
    assert.equal(resultaat['afkoelingTot'], null);
    assert.equal(resultaat['reden'], undefined);
  });

  it('tijdens afkoeling: alle normen en resterend 0, met afkoelingTot en NL-reden', async () => {
    // Vaste klok staat op 2026-10-06T10:00Z; afkoeling loopt tot de volgende dag.
    await db.query(`update accounts set afkoeling_tot = $2 where id = $1`, [
      accountId,
      '2026-10-07T10:00:00.000Z',
    ]);
    type Teller = { gebruikt: number; norm: number; resterend: number };
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      afkoelingTot: string | null;
      reden?: string;
      budget: Record<string, { dag?: Teller; week?: Teller | null; maand?: Teller }>;
    };
    assert.equal(resultaat.afkoelingTot, '2026-10-07T10:00:00.000Z');
    assert.match(resultaat.reden ?? '', /afkoeling/i);
    // Reden in de tijdzone van het account (Europe/Amsterdam: 10:00Z = 12:00), niet ISO.
    assert.match(resultaat.reden ?? '', /7 okt 2026 12:00/);
    assert.doesNotMatch(resultaat.reden ?? '', /2026-10-07T/);
    for (const type of ['invite', 'message', 'profile', 'search']) {
      assert.equal(resultaat.budget[type]!.dag!.norm, 0, `${type} dag-norm`);
      assert.equal(resultaat.budget[type]!.dag!.resterend, 0, `${type} dag-resterend`);
      const week = resultaat.budget[type]!.week;
      if (week) {
        assert.equal(week.norm, 0, `${type} week-norm`);
        assert.equal(week.resterend, 0, `${type} week-resterend`);
      }
    }
    assert.equal(resultaat.budget['inmail']!.maand!.norm, 0);
    assert.equal(resultaat.budget['inmail']!.maand!.resterend, 0);
  });

  it('afkoelingsreden gebruikt de tijdzone van het account; afkoelingTot blijft ISO', async () => {
    await db.query(`update accounts set afkoeling_tot = $2, tijdzone = $3 where id = $1`, [
      accountId,
      '2026-10-07T10:00:00.000Z',
      'America/New_York',
    ]);
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      afkoelingTot: string | null;
      reden?: string;
    };
    assert.equal(resultaat.afkoelingTot, '2026-10-07T10:00:00.000Z');
    assert.match(resultaat.reden ?? '', /7 okt 2026 06:00/);
  });

  it('na afloop van de afkoeling gelden de normale normen weer', async () => {
    await db.query(`update accounts set afkoeling_tot = $2 where id = $1`, [
      accountId,
      '2026-10-06T09:00:00.000Z',
    ]);
    const resultaat = (await voerTool(deps, 'get_budget', { accountId })) as {
      afkoelingTot: string | null;
      budget: Record<string, { dag?: { norm: number } }>;
    };
    assert.equal(resultaat.afkoelingTot, null);
    assert.equal(resultaat.budget['invite']!.dag!.norm, 10);
  });
});

function volledigeInvitePayload(overschrijf: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'ACo-abc',
    message: 'Hoi Nina, zullen we even sparren?',
    ontvanger_naam: 'Nina Jansen',
    ontvanger_functie: 'Marketing manager',
    ontvanger_bedrijf: 'Acme NV',
    ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
    waarom: 'Afkomstig uit zoekopdracht "logistiek marketing manager" (zie actie X-123).',
    ...overschrijf,
  };
}

describe('queue_action', () => {
  it('maakt een invite-actie als "draft" en noemt de goedkeuringspagina', async () => {
    const resultaat = (await voerTool(deps, 'queue_action', {
      accountId,
      type: 'invite',
      payload: volledigeInvitePayload(),
    })) as { actieId: string; status: string; bericht: string };

    assert.equal(resultaat.status, 'draft');
    assert.match(resultaat.bericht, /goedkeuringspagina/i);
    const actie = await vindActie(db, resultaat.actieId);
    assert.equal(actie?.status, 'draft');
    assert.equal(actie?.goedgekeurdDoor, null);
    assert.equal(actie?.goedgekeurdOp, null);
    // Nieuwe velden belanden in de payload zodat de admin UI ze kan tonen.
    const payload = actie?.payload as Record<string, unknown>;
    assert.equal(payload['ontvanger_naam'], 'Nina Jansen');
    assert.equal(payload['ontvanger_functie'], 'Marketing manager');
    assert.equal(payload['ontvanger_bedrijf'], 'Acme NV');
    assert.equal(payload['ontvanger_url'], 'https://www.linkedin.com/in/nina-jansen/');
    assert.match(payload['waarom'] as string, /zoekopdracht/);
  });

  it('weigert search of profile — die horen bij search_people/get_profile', async () => {
    await assert.rejects(
      () =>
        voerTool(deps, 'queue_action', {
          accountId,
          type: 'profile',
          payload: { identifier: 'rubert' },
        }),
      /Alleen invite, message en inmail/,
    );
  });

  it('weigert een poging om via de payload te doen alsof iets goedgekeurd is', async () => {
    await assert.rejects(
      () =>
        voerTool(deps, 'queue_action', {
          accountId,
          type: 'invite',
          payload: volledigeInvitePayload({ goedgekeurd_door: 'nep@niemand.nl' }),
        }),
      /niet toegestaan via de MCP/,
    );
  });

  it('weigert een "approved"-vlag op root-niveau', async () => {
    await assert.rejects(
      () =>
        voerTool(deps, 'queue_action', {
          accountId,
          type: 'invite',
          payload: volledigeInvitePayload(),
          approved: true,
        } as unknown as Record<string, unknown>),
      /niet toegestaan via de MCP/,
    );
  });

  it('werpt een NL-fout bij een ongeldige geplandOp', async () => {
    await assert.rejects(
      () =>
        voerTool(deps, 'queue_action', {
          accountId,
          type: 'invite',
          payload: volledigeInvitePayload(),
          geplandOp: 'morgen',
        }),
      /geldige ISO-8601/,
    );
  });

  for (const veld of [
    'ontvanger_naam',
    'ontvanger_functie',
    'ontvanger_bedrijf',
    'ontvanger_url',
    'waarom',
  ] as const) {
    it(`werpt NL-fout wanneer verplicht veld "${veld}" ontbreekt`, async () => {
      const payload = volledigeInvitePayload();
      delete (payload as Record<string, unknown>)[veld];
      await assert.rejects(
        () =>
          voerTool(deps, 'queue_action', { accountId, type: 'invite', payload }),
        (err: Error) => {
          assert.match(err.message, new RegExp(`"${veld}"`));
          assert.match(err.message, /verplicht/i);
          return true;
        },
      );
      // Geen actie aangemaakt bij een validatiefout.
      const rijen = await db.query<{ aantal: number | string }>(
        `select count(*)::int as aantal from actions where account_id = $1`,
        [accountId],
      );
      assert.equal(Number(rijen[0]?.aantal), 0);
    });
  }

  it('werpt NL-fout wanneer ontvanger_url geen LinkedIn-url is', async () => {
    await assert.rejects(
      () =>
        voerTool(deps, 'queue_action', {
          accountId,
          type: 'invite',
          payload: volledigeInvitePayload({ ontvanger_url: 'https://acme.nl/nina' }),
        }),
      /linkedin\.com/i,
    );
  });

  it('verwerkt message-type met alle verplichte velden', async () => {
    const resultaat = (await voerTool(deps, 'queue_action', {
      accountId,
      type: 'message',
      payload: {
        chatId: 'C-leo',
        tekst: 'Dag Leo, dank voor de connectie.',
        ontvanger_naam: 'Leo Bakker',
        ontvanger_functie: 'Head of Growth',
        ontvanger_bedrijf: 'Finbase',
        ontvanger_url: 'https://www.linkedin.com/in/leo-bakker/',
        waarom: 'Opvolgbericht na nieuwe connectie (sequentie S-42, stap 2).',
      },
    })) as { actieId: string };
    const actie = await vindActie(db, resultaat.actieId);
    assert.equal(actie?.type, 'message');
    assert.equal(actie?.status, 'draft');
    assert.equal(
      (actie?.payload as Record<string, unknown>)['ontvanger_naam'],
      'Leo Bakker',
    );
  });
});

describe('get_profile', () => {
  it('loopt via de budgetmotor en de worker, en levert het Unipile-antwoord terug', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/rubert/, {
      status: 200,
      body: {
        provider_id: 'ACo-abc',
        public_identifier: 'rubert',
        work_experience: [],
      },
    });
    const resultaat = (await voerTool(deps, 'get_profile', {
      accountId,
      identifier: 'rubert',
    })) as { actieId: string; profiel: Record<string, unknown> };

    const actie = await vindActie(db, resultaat.actieId);
    assert.equal(actie?.status, 'done');
    assert.equal(actie?.type, 'profile');
    assert.equal(resultaat.profiel['provider_id'], 'ACo-abc');
    assert.equal(resultaat.profiel['public_identifier'], 'rubert');
  });

  it('geeft een NL-fout bij 429 van Unipile en zet account in afkoeling', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/./, {
      status: 429,
      headers: { 'retry-after': '60' },
      body: { error: 'te veel' },
    });
    await assert.rejects(
      () => voerTool(deps, 'get_profile', { accountId, identifier: 'rubert' }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.match(err.message, /429|afkoeling/i);
        return true;
      },
    );
    const rijen = await db.query<{ afkoeling_tot: Date | string | null }>(
      `select afkoeling_tot from accounts where id = $1`,
      [accountId],
    );
    assert.ok(rijen[0]?.afkoeling_tot, 'account hoort in afkoeling te staan na 429');
  });

  it('geeft een NL-fout wanneer de budgetmotor weigert', async () => {
    await db.query(
      `update accounts set status = 'CREDENTIALS'::account_status where id = $1`,
      [accountId],
    );
    await assert.rejects(
      () => voerTool(deps, 'get_profile', { accountId, identifier: 'rubert' }),
      (err: Error) => {
        assert.match(err.message, /opnieuw koppelen/);
        return true;
      },
    );
  });
});

describe('search_people', () => {
  it('loopt via de budgetmotor en geeft resultaten terug, ook tijdens opbouw (factor 0.5)', async () => {
    // Zoeknorm 1 run/dag × 0.5 blijft 1 dankzij de ondergrens in geschaaldeNorm.
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: {
        items: [{ id: 'ACo-1', public_identifier: 'persoon-1' }],
        paging: { total_count: 1 },
      },
    });
    const resultaat = (await voerTool(deps, 'search_people', {
      accountId,
      keywords: 'logistiek',
      limit: 10,
    })) as { actieId: string; items?: Array<Record<string, unknown>> };
    assert.ok(resultaat.actieId);
    assert.equal(resultaat.items?.length, 1);
    const actie = await vindActie(db, resultaat.actieId);
    assert.equal(actie?.status, 'done');
    assert.equal(actie?.type, 'search');
  });

  it('zet de tweede run op dezelfde dag in de wachtrij met NL-reden (dagnorm 1 op)', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: { items: [], paging: { total_count: 0 } },
    });
    await voerTool(deps, 'search_people', { accountId, keywords: 'eerste' });
    // De eerste run uitvoeren 10 minuten vóór de vaste klok (12:00 lokaal) zetten:
    // ruim boven de maximale search-pauze van 8 minuten, zodat alleen de dagnorm
    // de tweede run tegenhoudt. Expliciet afgeleid van deps.klok, niet van de
    // wandklok: zo blijft het altijd dezelfde lokale dag, ook rond middernacht.
    const tienMinutenEerder = new Date(deps.klok.nu().getTime() - 10 * 60 * 1000);
    await db.query(
      `update actions set uitgevoerd_op = $2 where account_id = $1 and type = 'search'`,
      [accountId, tienMinutenEerder.toISOString()],
    );
    await assert.rejects(
      () => voerTool(deps, 'search_people', { accountId, keywords: 'tweede' }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.equal((err as McpSynchroonFout).oorzaak, 'wachtrij');
        assert.match(err.message, /Dagnorm/);
        return true;
      },
    );
  });
});

describe('start_sequence', () => {
  function basisArgs(overschrijf: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      accountId,
      lead: {
        providerId: 'ACo-sv',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead uit zoekactie "logistiek" (score 0.82).',
      },
      teksten: {
        invite: 'Hoi Sven, zullen we even sparren?',
        bericht: 'Dag Sven, dank voor de connectie!',
        opvolging: 'Hoi Sven, nog even een korte reminder.',
      },
      ...overschrijf,
    };
  }

  it('maakt een draft-invite aan en geeft het sequentie-id terug', async () => {
    const resultaat = (await voerTool(deps, 'start_sequence', basisArgs())) as {
      sequentieId: string;
      status: string;
      invite: { actieId: string; status: string };
      bericht: string;
    };
    assert.ok(resultaat.sequentieId);
    assert.equal(resultaat.status, 'lopend');
    assert.equal(resultaat.invite.status, 'draft');
    assert.match(resultaat.bericht, /goedkeuringspagina/i);

    const actie = await vindActie(db, resultaat.invite.actieId);
    assert.equal(actie?.type, 'invite');
    assert.equal(actie?.status, 'draft');
    assert.equal(actie?.goedgekeurdDoor, null);
    const payload = actie?.payload as Record<string, unknown>;
    assert.equal(payload['sequence_id'], resultaat.sequentieId);
    assert.equal(payload['sequence_stap'], 1);
  });

  it('weigert een lead-url die geen linkedin.com is', async () => {
    const args = basisArgs();
    const lead = args['lead'] as Record<string, unknown>;
    lead['linkedinUrl'] = 'https://acme.nl/sven';
    await assert.rejects(
      () => voerTool(deps, 'start_sequence', args),
      /linkedin\.com/i,
    );
  });

  it('weigert een tweede sequentie voor dezelfde lead op hetzelfde account', async () => {
    await voerTool(deps, 'start_sequence', basisArgs());
    await assert.rejects(
      () => voerTool(deps, 'start_sequence', basisArgs()),
      /Er loopt al een sequentie/,
    );
  });

  it('na afwijzing van stap 2 begint een nieuwe sequentie bij stap 2, zonder invite', async () => {
    const eerste = (await voerTool(deps, 'start_sequence', basisArgs())) as { sequentieId: string };
    // Vorige sequentie: invite verstuurd, geaccepteerd, stap 2 afgewezen.
    await db.query(
      `update actions set status = 'done' where sequence_id = $1 and sequence_stap = 1`,
      [eerste.sequentieId],
    );
    await db.query(
      `update sequences set status = 'gestopt', stap = 2, stop_reden = 'afgewezen bij goedkeuring: te lang'
       where id = $1`,
      [eerste.sequentieId],
    );
    await db.query(
      `insert into actions(account_id, type, payload, status, sequence_id, sequence_stap)
       values ($1, 'message', '{"chatId":"C-1","tekst":"oud"}', 'rejected', $2, 2)`,
      [accountId, eerste.sequentieId],
    );

    const tweede = (await voerTool(deps, 'start_sequence', basisArgs())) as {
      sequentieId: string;
      status: string;
      beginStap: number;
      invite: unknown;
      bericht: string;
    };
    assert.equal(tweede.status, 'geaccepteerd');
    assert.equal(tweede.beginStap, 2);
    assert.equal(tweede.invite, null);
    assert.match(tweede.bericht, /stap 2/i);
    assert.match(tweede.bericht, /geen nieuwe invite/i);
  });

  it('weigert een invite-tekst boven de maximum-tekenlimiet', async () => {
    const lang = 'x'.repeat(limieten.tekst_max_tekens.invite + 1);
    const args = basisArgs();
    (args['teksten'] as Record<string, unknown>)['invite'] = lang;
    await assert.rejects(
      () => voerTool(deps, 'start_sequence', args),
      /invite.*tekens/,
    );
  });
});

describe('get_results', () => {
  it('geeft recente acties en events voor een account', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/./, {
      status: 200,
      body: { provider_id: 'ACo-xyz', public_identifier: 'iemand' },
    });
    await voerTool(deps, 'get_profile', { accountId, identifier: 'iemand' });
    await voerTool(deps, 'queue_action', {
      accountId,
      type: 'invite',
      payload: volledigeInvitePayload({ providerId: 'ACo-xyz' }),
    });
    const res = (await voerTool(deps, 'get_results', { accountId })) as {
      acties: Array<Record<string, unknown>>;
      sequenties: Array<Record<string, unknown>>;
    };
    assert.equal(res.acties.length, 2);
    const draft = res.acties.find((a) => a['status'] === 'draft');
    assert.ok(draft, 'queue_action moet een draft opleveren in get_results');
    assert.equal(draft!['goedgekeurdDoor'], null);
    assert.deepEqual(res.sequenties, []);
  });

  it('toont lopende sequenties met stap, status en laatste gebeurtenis', async () => {
    await voerTool(deps, 'start_sequence', {
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
        opvolging: 'Reminder',
      },
    });
    const res = (await voerTool(deps, 'get_results', { accountId })) as {
      sequenties: Array<Record<string, unknown>>;
      acties: Array<Record<string, unknown>>;
    };
    assert.equal(res.sequenties.length, 1);
    assert.equal(res.sequenties[0]!['stap'], 0);
    assert.equal(res.sequenties[0]!['status'], 'lopend');
    const laatste = res.sequenties[0]!['laatsteGebeurtenis'] as Record<string, unknown>;
    assert.equal(laatste['stap'], 1);
    assert.equal(laatste['type'], 'invite');
    assert.equal(laatste['status'], 'draft');

    const actie = res.acties[0]!;
    assert.ok(actie['sequentieId']);
    assert.equal(actie['sequentieStap'], 1);
    assert.ok(actie['sequentieGestartOp']);
  });
});
