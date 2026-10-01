import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { maakWachtwoordHash, verifieerWachtwoord } from './wachtwoord.ts';

describe('maakWachtwoordHash', () => {
  it('produceert twee verschillende hashes voor hetzelfde wachtwoord (zout per keer)', async () => {
    const a = await maakWachtwoordHash('geheimpje123');
    const b = await maakWachtwoordHash('geheimpje123');
    assert.notEqual(a, b);
    assert.match(a, /^scrypt\$/);
  });

  it('weigert te korte wachtwoorden', async () => {
    await assert.rejects(() => maakWachtwoordHash('kort'), /minstens 8/);
  });
});

describe('verifieerWachtwoord', () => {
  it('accepteert het juiste wachtwoord', async () => {
    const hash = await maakWachtwoordHash('geheimpje123');
    assert.equal(await verifieerWachtwoord(hash, 'geheimpje123'), true);
  });

  it('weigert een afwijkend wachtwoord', async () => {
    const hash = await maakWachtwoordHash('geheimpje123');
    assert.equal(await verifieerWachtwoord(hash, 'geheimpje124'), false);
    assert.equal(await verifieerWachtwoord(hash, ''), false);
  });

  it('weigert een misvormde hash zonder te crashen', async () => {
    assert.equal(await verifieerWachtwoord('onzin', 'wat dan ook'), false);
    assert.equal(await verifieerWachtwoord('scrypt$abc', 'wat dan ook'), false);
    assert.equal(await verifieerWachtwoord('bcrypt$1$2$3$4$5', 'x'), false);
  });
});
