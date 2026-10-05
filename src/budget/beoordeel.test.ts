import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Abonnement } from '../register/accounts.ts';

import { beoordeel, type Beoordeling, type BeoordelingsInvoer } from './beoordeel.ts';
import { laadLimieten, type ActieType, type Limieten } from './limits.ts';

type Geblokkeerd = Exclude<Beoordeling, { status: 'toegestaan' }>;

function geblokkeerd(uitslag: Beoordeling): Geblokkeerd {
  if (uitslag.status === 'toegestaan') {
    throw new Error('Verwachtte wachtrij of weigering, kreeg toegestaan.');
  }
  return uitslag;
}

const limietenPromise = laadLimieten();

interface Overrides {
  status?: BeoordelingsInvoer['account']['status'];
  abonnement?: Abonnement;
  opbouwFactor?: number;
  afkoelingTot?: Date | null;
  tijdzone?: string;
  openstaandeVerzoeken?: number;
  actieType?: ActieType;
  goedgekeurd?: boolean;
  nu?: Date;
  gebruikDag?: number;
  gebruikWeek?: number;
  gebruikMaand?: number;
  laatsteActieOp?: Date | null;
  minPauzeSeconden?: number;
  typeDagStop?: boolean;
  wekenSindsStart?: number;
  acceptatieVerhouding?: number;
}

async function invoerVoor(over: Overrides = {}): Promise<BeoordelingsInvoer> {
  const l: Limieten = await limietenPromise;
  // Standaard: salesnav_core account dinsdag 2026-10-06 12:00 Europe/Amsterdam (= 10:00 UTC).
  return {
    account: {
      status: over.status ?? 'OK',
      abonnement: over.abonnement ?? 'salesnav_core',
      opbouwFactor: over.opbouwFactor ?? 1.0,
      afkoelingTot: over.afkoelingTot ?? null,
      tijdzone: over.tijdzone ?? 'Europe/Amsterdam',
      openstaandeVerzoeken: over.openstaandeVerzoeken ?? 0,
    },
    actieType: over.actieType ?? 'invite',
    goedgekeurd: over.goedgekeurd ?? true,
    nu: over.nu ?? new Date('2026-10-06T10:00:00Z'),
    gebruikDag: over.gebruikDag ?? 0,
    gebruikWeek: over.gebruikWeek ?? 0,
    gebruikMaand: over.gebruikMaand ?? 0,
    laatsteActieOp: over.laatsteActieOp ?? null,
    minPauzeSeconden: over.minPauzeSeconden ?? 120,
    typeDagStop: over.typeDagStop ?? false,
    wekenSindsStart: over.wekenSindsStart ?? 10,
    acceptatieVerhouding: over.acceptatieVerhouding ?? 0.4,
    limieten: l,
  };
}

describe('beoordeel — controle 1: account gezond', () => {
  it('OK slaagt door naar volgende controles', async () => {
    const invoer = await invoerVoor({ actieType: 'search' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'toegestaan');
  });

  it('CREDENTIALS → weigering met NL-reden over sessie', async () => {
    const invoer = await invoerVoor({ status: 'CREDENTIALS' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'weigering');
    assert.equal(uitslag.controle, 'account_gezond');
    assert.match(uitslag.reden!, /sessie|koppelen|credentials/i);
  });

  it('ERROR → weigering', async () => {
    const invoer = await invoerVoor({ status: 'ERROR' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'weigering');
    assert.equal(uitslag.controle, 'account_gezond');
    assert.match(uitslag.reden!, /ERROR|fout/i);
  });

  it('STOPPED → weigering', async () => {
    const invoer = await invoerVoor({ status: 'STOPPED' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'weigering');
    assert.equal(uitslag.controle, 'account_gezond');
    assert.match(uitslag.reden!, /gestopt/i);
  });

  it('CONNECTING → wachtrij (tijdelijk)', async () => {
    const invoer = await invoerVoor({ status: 'CONNECTING' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'account_gezond');
    assert.match(uitslag.reden!, /koppel|CONNECTING|verbind/i);
  });
});

describe('beoordeel — controle 2: goedgekeurd', () => {
  it('invite zonder goedkeuring → weigering', async () => {
    const invoer = await invoerVoor({ actieType: 'invite', goedgekeurd: false });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'weigering');
    assert.equal(uitslag.controle, 'goedgekeurd');
    assert.match(uitslag.reden!, /goedkeuring/i);
  });

  it('message zonder goedkeuring → weigering', async () => {
    const invoer = await invoerVoor({ actieType: 'message', goedgekeurd: false });
    assert.equal(beoordeel(invoer).status, 'weigering');
  });

  it('inmail zonder goedkeuring → weigering', async () => {
    const invoer = await invoerVoor({ actieType: 'inmail', goedgekeurd: false });
    assert.equal(beoordeel(invoer).status, 'weigering');
  });

  it('search slaat goedkeuring-check over', async () => {
    const invoer = await invoerVoor({ actieType: 'search', goedgekeurd: false });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('profile slaat goedkeuring-check over', async () => {
    const invoer = await invoerVoor({ actieType: 'profile', goedgekeurd: false });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });
});

describe('beoordeel — controle 3: dagbudget', () => {
  it('onder de grens → doorgaan', async () => {
    // salesnav_core.invite.dag = 20, opbouw 1.0 → norm 20.
    const invoer = await invoerVoor({ gebruikDag: 10 });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('op de grens → wachtrij', async () => {
    const invoer = await invoerVoor({ gebruikDag: 20 });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'dagbudget');
    assert.match(uitslag.reden!, /dag(norm|budget)/i);
  });

  it('nieuw account (opbouw 0.5) halveert de norm (20 → 10)', async () => {
    const invoer = await invoerVoor({ opbouwFactor: 0.5, gebruikDag: 10 });
    assert.equal(beoordeel(invoer).status, 'wachtrij');
  });

  it('bug: search tijdens opbouw (salesnav_core, factor 0.5) — dagnorm 1 blijft 1, niet 0', async () => {
    const invoer = await invoerVoor({ actieType: 'search', opbouwFactor: 0.5, gebruikDag: 0 });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('search tijdens opbouw: tweede run op dezelfde dag → wachtrij (norm 1)', async () => {
    const invoer = await invoerVoor({ actieType: 'search', opbouwFactor: 0.5, gebruikDag: 1 });
    const uitslag = geblokkeerd(beoordeel(invoer));
    assert.equal(uitslag.controle, 'dagbudget');
    assert.match(uitslag.reden!, /1\/1/);
  });

  it('opbouwfactor geldt niet voor InMail: salesnav_core met factor 0.5 houdt 50/maand', async () => {
    const basis = { actieType: 'inmail' as const, opbouwFactor: 0.5 };
    assert.equal(beoordeel(await invoerVoor({ ...basis, gebruikMaand: 49 })).status, 'toegestaan');
    const vol = geblokkeerd(beoordeel(await invoerVoor({ ...basis, gebruikMaand: 50 })));
    assert.equal(vol.controle, 'dagbudget');
    assert.match(vol.reden!, /50\/50/);
  });

  it('search tijdens afkoeling blijft geblokkeerd, ook met de ondergrens van 1', async () => {
    const invoer = await invoerVoor({
      actieType: 'search',
      opbouwFactor: 0.5,
      afkoelingTot: new Date('2026-10-07T10:00:00Z'),
    });
    const uitslag = geblokkeerd(beoordeel(invoer));
    assert.equal(uitslag.controle, 'afkoeling');
  });

  it('typeDagStop (Unipile usage ≥ 75%) → wachtrij voor dit actietype vandaag', async () => {
    const invoer = await invoerVoor({ gebruikDag: 0, typeDagStop: true });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'dagbudget');
    assert.match(uitslag.reden!, /Unipile|75\s*%|afremmen/i);
  });

  it('invite: openstaande_verzoeken >= 500 → wachtrij, geen weigering', async () => {
    const invoer = await invoerVoor({ actieType: 'invite', openstaandeVerzoeken: 500 });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'dagbudget');
    assert.match(uitslag.reden!, /openstaand|500/i);
  });

  it('message/profile raken de openstaand-grens niet', async () => {
    const invoerMessage = await invoerVoor({ actieType: 'message', openstaandeVerzoeken: 500 });
    assert.equal(beoordeel(invoerMessage).status, 'toegestaan');
    const invoerProfile = await invoerVoor({ actieType: 'profile', openstaandeVerzoeken: 500 });
    assert.equal(beoordeel(invoerProfile).status, 'toegestaan');
  });

  it('inmail → maandbudget wordt op dag-stap gecontroleerd', async () => {
    // premium_career.inmail.maand = 5 → bij 5 verbruik ja: wachtrij.
    const invoer = await invoerVoor({
      actieType: 'inmail',
      abonnement: 'premium_career',
      gebruikMaand: 5,
    });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.match(uitslag.reden!, /maand|InMail/i);
  });

  it('inmail op free (maand = 0) → wachtrij met reden over abonnement', async () => {
    const invoer = await invoerVoor({ actieType: 'inmail', abonnement: 'free' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.match(uitslag.reden!, /abonnement|InMail|maand/i);
  });
});

describe('beoordeel — controle 4: weekbudget', () => {
  it('onder de weeknorm → doorgaan', async () => {
    // salesnav_core.invite.week = 100 (met bonus 150 na 4 weken).
    const invoer = await invoerVoor({ gebruikWeek: 50 });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('op de weeknorm (zonder bonus-weken) → wachtrij', async () => {
    const invoer = await invoerVoor({ gebruikWeek: 100, wekenSindsStart: 2 });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'weekbudget');
  });

  it('met bonus (4+ weken, acceptatie ≥ 30%) mag de weeknorm 150 zijn', async () => {
    const invoer = await invoerVoor({
      gebruikWeek: 140,
      wekenSindsStart: 4,
      acceptatieVerhouding: 0.4,
    });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('bonus geldt niet als acceptatie onder drempel ligt', async () => {
    const invoer = await invoerVoor({
      gebruikWeek: 110,
      wekenSindsStart: 4,
      acceptatieVerhouding: 0.1,
    });
    assert.equal(beoordeel(invoer).status, 'wachtrij');
  });
});

describe('beoordeel — controle 5: tijdvenster', () => {
  it('buiten werkuren (07:00 lokaal) → wachtrij', async () => {
    // 2026-10-06 (dinsdag) 05:00 UTC = 07:00 CEST → 07:00 lokaal.
    const invoer = await invoerVoor({ nu: new Date('2026-10-06T05:00:00Z') });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'tijdvenster');
    assert.match(uitslag.reden!, /werkuren|08:30|17:30/i);
  });

  it('08:29 lokaal → wachtrij', async () => {
    // Zomer: UTC = lokaal - 2. 06:29 UTC op 2026-10-06 = 08:29 CEST.
    const invoer = await invoerVoor({ nu: new Date('2026-10-06T06:29:00Z') });
    assert.equal(beoordeel(invoer).status, 'wachtrij');
  });

  it('17:31 lokaal → wachtrij', async () => {
    // 15:31 UTC op 2026-10-06 (zomertijd) = 17:31 CEST.
    const invoer = await invoerVoor({ nu: new Date('2026-10-06T15:31:00Z') });
    assert.equal(beoordeel(invoer).status, 'wachtrij');
  });

  it('zaterdag → wachtrij (geen werkdag)', async () => {
    // 2026-10-10 is zaterdag, 10:00 UTC = 12:00 lokaal.
    const invoer = await invoerVoor({ nu: new Date('2026-10-10T10:00:00Z') });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'tijdvenster');
    assert.match(uitslag.reden!, /werkdag|weekend/i);
  });

  it('zomer-/wintertijdovergang: maandag 26 oktober 09:00 lokaal (= 08:00 UTC) is binnen', async () => {
    const invoer = await invoerVoor({ nu: new Date('2026-10-26T08:00:00Z') });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });

  it('25 oktober (zondag) is geen werkdag — ook rond de klokomslag', async () => {
    const invoer = await invoerVoor({ nu: new Date('2026-10-25T10:00:00Z') });
    assert.equal(beoordeel(invoer).status, 'wachtrij');
  });

  it('binnen minPauzeSeconden sinds laatste actie → wachtrij', async () => {
    const nu = new Date('2026-10-06T10:00:00Z');
    const invoer = await invoerVoor({
      nu,
      laatsteActieOp: new Date(nu.getTime() - 60_000),
      minPauzeSeconden: 120,
    });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'tijdvenster');
    assert.match(uitslag.reden!, /pauze|minuten|minPauze/i);
  });

  it('na minPauze → mag door', async () => {
    const nu = new Date('2026-10-06T10:00:00Z');
    const invoer = await invoerVoor({
      nu,
      laatsteActieOp: new Date(nu.getTime() - 180_000),
      minPauzeSeconden: 120,
    });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });
});

describe('beoordeel — controle 6: afkoeling', () => {
  it('tijdens afkoeling → wachtrij', async () => {
    const nu = new Date('2026-10-06T10:00:00Z');
    const invoer = await invoerVoor({
      nu,
      afkoelingTot: new Date('2026-10-07T10:00:00Z'),
    });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.controle, 'afkoeling');
    assert.match(uitslag.reden!, /afkoeling|48 uur|pauze/i);
  });

  it('na afkoeling → mag door', async () => {
    const nu = new Date('2026-10-06T10:00:00Z');
    const invoer = await invoerVoor({
      nu,
      afkoelingTot: new Date('2026-10-06T09:00:00Z'),
    });
    assert.equal(beoordeel(invoer).status, 'toegestaan');
  });
});

describe('beoordeel — volgorde van controles', () => {
  it('account_gezond komt vóór goedgekeurd (CREDENTIALS zonder goedkeuring → account_gezond-reden)', async () => {
    const invoer = await invoerVoor({ status: 'CREDENTIALS', goedgekeurd: false });
    assert.equal(geblokkeerd(beoordeel(invoer)).controle, 'account_gezond');
  });

  it('goedgekeurd komt vóór dagbudget', async () => {
    const invoer = await invoerVoor({ goedgekeurd: false, gebruikDag: 999 });
    assert.equal(geblokkeerd(beoordeel(invoer)).controle, 'goedgekeurd');
  });

  it('dagbudget komt vóór weekbudget', async () => {
    const invoer = await invoerVoor({ gebruikDag: 20, gebruikWeek: 999 });
    assert.equal(geblokkeerd(beoordeel(invoer)).controle, 'dagbudget');
  });

  it('weekbudget komt vóór tijdvenster', async () => {
    // Weekbudget vol maar binnen tijdvenster → weekbudget wordt gemeld.
    const invoer = await invoerVoor({
      gebruikWeek: 100,
      wekenSindsStart: 1,
      nu: new Date('2026-10-10T10:00:00Z'), // zaterdag
    });
    assert.equal(geblokkeerd(beoordeel(invoer)).controle, 'weekbudget');
  });

  it('tijdvenster komt vóór afkoeling', async () => {
    const invoer = await invoerVoor({
      nu: new Date('2026-10-10T10:00:00Z'), // zaterdag
      afkoelingTot: new Date('2026-10-10T20:00:00Z'),
    });
    assert.equal(geblokkeerd(beoordeel(invoer)).controle, 'tijdvenster');
  });
});

describe('beoordeel — Nederlandse redenen en tijdelijk/structureel', () => {
  it('weigeringen zijn structureel (hernieuwde aanbieding helpt niet)', async () => {
    const invoer = await invoerVoor({ status: 'STOPPED' });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'weigering');
    assert.equal(uitslag.structureel, true);
  });

  it('wachtrij-items zijn tijdelijk (opnieuw proberen heeft zin)', async () => {
    const invoer = await invoerVoor({ gebruikDag: 20 });
    const uitslag = beoordeel(invoer);
    assert.equal(uitslag.status, 'wachtrij');
    assert.equal(uitslag.structureel, false);
  });

  it('alle redenen zijn Nederlandse zinnen (zonder leveranciersjargon)', async () => {
    const varianten: Overrides[] = [
      { status: 'CREDENTIALS' },
      { status: 'ERROR' },
      { status: 'STOPPED' },
      { status: 'CONNECTING' },
      { goedgekeurd: false },
      { gebruikDag: 20 },
      { gebruikWeek: 100, wekenSindsStart: 1 },
      { nu: new Date('2026-10-10T10:00:00Z') }, // zaterdag
      { afkoelingTot: new Date('2026-10-07T10:00:00Z') },
      { openstaandeVerzoeken: 500 },
      { typeDagStop: true },
      { actieType: 'inmail', abonnement: 'premium_business', gebruikMaand: 15 },
    ];
    for (const over of varianten) {
      const invoer = await invoerVoor(over);
      const uitslag = geblokkeerd(beoordeel(invoer));
      assert.ok(uitslag.reden, `reden ontbreekt voor ${JSON.stringify(over)}`);
      assert.ok(
        /[a-zàáâäéèêëíìïóòôöúùûü]/i.test(uitslag.reden),
        `reden is geen tekst: ${uitslag.reden}`,
      );
    }
  });
});
