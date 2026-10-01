import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AFGESCHERMD, maakLogger } from './logger.ts';

function opvanger() {
  const regels: string[] = [];
  return { regels, schrijf: (r: string) => regels.push(r) };
}

const NU = () => new Date('2026-10-01T08:00:00Z');

describe('maakLogger', () => {
  it('schrijft één JSON-object per regel met tijd, niveau en bericht', () => {
    const { regels, schrijf } = opvanger();
    const log = maakLogger({ niveau: 'info', schrijf, nu: NU });
    log.info('Gateway gestart', { poort: 3000 });
    assert.equal(regels.length, 1);
    const regel = JSON.parse(regels[0]!);
    assert.deepEqual(regel, {
      tijd: '2026-10-01T08:00:00.000Z',
      niveau: 'info',
      bericht: 'Gateway gestart',
      poort: 3000,
    });
  });

  it('laat regels onder het ingestelde niveau weg', () => {
    const { regels, schrijf } = opvanger();
    const log = maakLogger({ niveau: 'warn', schrijf, nu: NU });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    assert.deepEqual(
      regels.map((r) => JSON.parse(r).bericht),
      ['c', 'd'],
    );
  });

  it('schermt velden met een geheim-achtige naam af, ook genest', () => {
    const { regels, schrijf } = opvanger();
    const log = maakLogger({ niveau: 'debug', schrijf, nu: NU });
    log.info('x', {
      apiKey: 'a',
      mcp_token: 'b',
      ADMIN_PASSWORD_HASH: 'c',
      DATABASE_URL: 'd',
      genest: { Authorization: 'Bearer e', webhookSecret: 'f', gewoon: 'zichtbaar' },
    });
    const regel = JSON.parse(regels[0]!);
    assert.equal(regel.apiKey, AFGESCHERMD);
    assert.equal(regel.mcp_token, AFGESCHERMD);
    assert.equal(regel.ADMIN_PASSWORD_HASH, AFGESCHERMD);
    assert.equal(regel.DATABASE_URL, AFGESCHERMD);
    assert.equal(regel.genest.Authorization, AFGESCHERMD);
    assert.equal(regel.genest.webhookSecret, AFGESCHERMD);
    assert.equal(regel.genest.gewoon, 'zichtbaar');
  });

  it('poetst bekende geheime waarden uit berichten en foutteksten', () => {
    const { regels, schrijf } = opvanger();
    const dbUrl = 'postgres://user:supergeheim@db.example:5432/postgres';
    const log = maakLogger({
      niveau: 'debug',
      schrijf,
      nu: NU,
      geheimen: [dbUrl, 'sleutel-123456'],
    });
    log.error(`Verbinding met ${dbUrl} mislukt`, {
      fout: new Error('header X-API-KEY=sleutel-123456 geweigerd'),
      pad: '/x?k=sleutel-123456',
    });
    const tekst = regels[0]!;
    assert.doesNotMatch(tekst, /supergeheim/);
    assert.doesNotMatch(tekst, /sleutel-123456/);
    const regel = JSON.parse(tekst);
    assert.equal(regel.fout.naam, 'Error');
    assert.match(regel.fout.bericht, /\[afgeschermd\]/);
  });
});
