import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { intakeUitObject, laadIntake } from './intake.ts';

function geldig(): Record<string, unknown> {
  return {
    versie: '1',
    rondes: [
      {
        id: 'propositie',
        titel: 'Propositie',
        uitleg: 'Uitleg',
        vragen: [
          { id: 'wat', type: 'tekst', label: 'Wat?', verplicht: true },
          { id: 'kern', type: 'keuzes', label: 'Kern?', opties: ['A', 'B'], anders: true },
        ],
      },
    ],
  };
}

describe('config/intake.json', () => {
  it('de meegeleverde configuratie is geldig, met vijf rondes en unieke vraag-id', async () => {
    const intake = await laadIntake();
    assert.equal(intake.versie, '1');
    assert.deepEqual(
      intake.rondes.map((r) => r.id),
      ['propositie', 'doelgroep', 'signalen', 'afzender', 'bewijs'],
    );
    const ids = intake.rondes.flatMap((r) => r.vragen.map((v) => v.id));
    assert.equal(new Set(ids).size, ids.length);
    const claims = intake.rondes.flatMap((r) => r.vragen).find((v) => v.type === 'claims');
    assert.ok(claims, 'er is een claimvraag (bewijs met vinkje)');
  });

  it('accepteert een minimale geldige intake', () => {
    const i = intakeUitObject(geldig());
    assert.equal(i.rondes[0]!.vragen[1]!.anders, true);
    assert.equal(i.rondes[0]!.vragen[0]!.verplicht, true);
    assert.equal(i.rondes[0]!.vragen[1]!.verplicht, false);
  });

  it('weigert dubbele vraag-id, onbekend type en keuzevragen zonder opties (NL-melding)', () => {
    const dubbel = geldig();
    (dubbel['rondes'] as any)[0].vragen[1].id = 'wat';
    assert.throws(() => intakeUitObject(dubbel), /dubbel/i);

    const type = geldig();
    (type['rondes'] as any)[0].vragen[0].type = 'schuifje';
    assert.throws(() => intakeUitObject(type), /type/);

    const leeg = geldig();
    (leeg['rondes'] as any)[0].vragen[1].opties = [];
    assert.throws(() => intakeUitObject(leeg), /opties/);
  });

  it('weigert id met hoofdletters of tekens buiten a-z, 0-9 en _', () => {
    const fout = geldig();
    (fout['rondes'] as any)[0].id = 'Pro-positie';
    assert.throws(() => intakeUitObject(fout), /id/);
  });

  it('weigert een lege versie en een intake zonder rondes', () => {
    assert.throws(() => intakeUitObject({ ...geldig(), versie: '' }), /versie/);
    assert.throws(() => intakeUitObject({ versie: '1', rondes: [] }), /rondes/);
  });
});
