import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { systeemKlok, vasteKlok } from './klok.ts';

describe('systeemKlok', () => {
  it('geeft bij elke aanroep het huidige moment terug', () => {
    const voor = Date.now();
    const nu = systeemKlok.nu().getTime();
    const na = Date.now();
    assert.ok(nu >= voor && nu <= na, 'nu() moet tussen voor en na liggen');
  });
});

describe('vasteKlok', () => {
  it('geeft steeds hetzelfde moment terug', () => {
    const klok = vasteKlok('2026-10-01T10:00:00Z');
    const eerst = klok.nu();
    const tweedeKeer = klok.nu();
    assert.equal(eerst.toISOString(), '2026-10-01T10:00:00.000Z');
    assert.equal(tweedeKeer.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  it('aanvaardt zowel string, Date als number als invoer', () => {
    const a = vasteKlok('2026-10-01T10:00:00Z');
    const b = vasteKlok(new Date('2026-10-01T10:00:00Z'));
    const c = vasteKlok(Date.parse('2026-10-01T10:00:00Z'));
    assert.equal(a.nu().toISOString(), b.nu().toISOString());
    assert.equal(a.nu().toISOString(), c.nu().toISOString());
  });

  it('geeft bij elke aanroep een nieuwe Date-instantie zodat mutaties geen leksporen laten', () => {
    const klok = vasteKlok('2026-10-01T10:00:00Z');
    const eerste = klok.nu();
    eerste.setFullYear(1999);
    assert.equal(klok.nu().getUTCFullYear(), 2026);
  });
});
