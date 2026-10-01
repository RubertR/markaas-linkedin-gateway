import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vasteKlok, type Klok } from '../budget/klok.ts';
import { laadLimieten, type Tijdvenster } from '../budget/limits.ts';
import { stilleLogger } from '../log/logger.ts';

import { startPlannerLus, type Timers, type TickUitkomst } from './lus.ts';
import { zaadRandom } from './pauze.ts';

/** Handmatige timers: tests bepalen zelf wanneer een geplande tick afgaat. */
function nepTimers() {
  const gepland: { fn: () => void; ms: number; gewist: boolean }[] = [];
  const timers: Timers = {
    zet(fn, ms) {
      const item = { fn, ms, gewist: false };
      gepland.push(item);
      return item;
    },
    wis(h) {
      (h as { gewist: boolean }).gewist = true;
    },
  };
  return { gepland, timers };
}

async function laatAfgaan(item: { fn: () => void }): Promise<void> {
  item.fn();
  // Laat de async tick en de .finally-keten uitlopen.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// Donderdag 1 okt 2026, 10:00 in Amsterdam (binnen werktijd).
const DONDERDAG_10U = vasteKlok('2026-10-01T08:00:00Z');
// Zaterdag 3 okt 2026, 10:00 in Amsterdam (buiten werkdagen).
const ZATERDAG_10U = vasteKlok('2026-10-03T08:00:00Z');
// Donderdag 1 okt 2026, 20:00 in Amsterdam (na werktijd).
const DONDERDAG_20U = vasteKlok('2026-10-01T18:00:00Z');

let tijdvenster: Tijdvenster;

before(async () => {
  tijdvenster = (await laadLimieten()).tijdvenster;
});

function maak(opties: {
  ingeschakeld: boolean;
  klok?: Klok;
  tick?: () => Promise<TickUitkomst>;
}) {
  const { gepland, timers } = nepTimers();
  let ticks = 0;
  const lus = startPlannerLus({
    ingeschakeld: opties.ingeschakeld,
    tick:
      opties.tick ??
      (async () => {
        ticks++;
        return { gatewayGestopt: false };
      }),
    tijdvenster,
    tijdzone: 'Europe/Amsterdam',
    klok: opties.klok ?? DONDERDAG_10U,
    pauzeKiezer: zaadRandom(42),
    logger: stilleLogger,
    timers,
  });
  return { lus, gepland, ticks: () => ticks };
}

describe('startPlannerLus', () => {
  it('start niet zonder PLANNER_ENABLED=true: geen timer, geen tick', async () => {
    const { lus, gepland, ticks } = maak({ ingeschakeld: false });
    assert.equal(lus.actief, false);
    assert.equal(gepland.length, 0);
    assert.equal(ticks(), 0);
    await lus.stop();
  });

  it('plant de eerste tick op een willekeurig moment binnen de pauzegrenzen', async () => {
    const { lus, gepland } = maak({ ingeschakeld: true });
    assert.equal(lus.actief, true);
    assert.equal(gepland.length, 1);
    const { min, max } = tijdvenster.pauze_tussen_acties_minuten;
    const ms = gepland[0]!.ms;
    assert.ok(ms >= min * 60_000 && ms <= max * 60_000, `wachttijd ${ms} ms buiten grenzen`);
    await lus.stop();
  });

  it('tickt binnen werktijd en plant daarna opnieuw met een andere wachttijd', async () => {
    const { lus, gepland, ticks } = maak({ ingeschakeld: true });
    await laatAfgaan(gepland[0]!);
    assert.equal(ticks(), 1);
    assert.equal(gepland.length, 2);
    await laatAfgaan(gepland[1]!);
    assert.equal(ticks(), 2);
    const wachttijden = new Set(gepland.map((g) => g.ms));
    assert.ok(wachttijden.size > 1, 'wachttijden zijn niet willekeurig');
    await lus.stop();
  });

  it('slaat de tick over in het weekend en na werktijd, maar blijft plannen', async () => {
    for (const klok of [ZATERDAG_10U, DONDERDAG_20U]) {
      const { lus, gepland, ticks } = maak({ ingeschakeld: true, klok });
      await laatAfgaan(gepland[0]!);
      assert.equal(ticks(), 0);
      assert.equal(gepland.length, 2);
      await lus.stop();
    }
  });

  it('stopt helemaal als de tick meldt dat de gateway-sleutel geweigerd is', async () => {
    const { lus, gepland } = maak({
      ingeschakeld: true,
      tick: async () => ({ gatewayGestopt: true }),
    });
    await laatAfgaan(gepland[0]!);
    assert.equal(lus.actief, false);
    assert.equal(gepland.length, 1);
  });

  it('blijft lopen na een fout in de tick', async () => {
    const { lus, gepland } = maak({
      ingeschakeld: true,
      tick: async () => {
        throw new Error('database even weg');
      },
    });
    await laatAfgaan(gepland[0]!);
    assert.equal(lus.actief, true);
    assert.equal(gepland.length, 2);
    await lus.stop();
  });

  it('stop() wist de geplande timer', async () => {
    const { lus, gepland } = maak({ ingeschakeld: true });
    await lus.stop();
    assert.equal(gepland[0]!.gewist, true);
    assert.equal(lus.actief, false);
  });
});
