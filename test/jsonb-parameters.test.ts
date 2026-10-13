import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Bewaakt de oorzaak van de "dubbel gecodeerde" JSON in productie (13 okt 2026).
 *
 * postgres.js vraagt bij een parameter met `$n::jsonb` eerst het type op bij de
 * server (jsonb) en zet de waarde dan zelf nog eens om met `JSON.stringify`.
 * Geven we al een JSON-tekst mee, dan wordt die een jsonb-*string* in plaats van
 * een object, en vinden queries als `payload ->> 'chatId'` niets meer. PGlite in
 * de tests heeft dat gedrag niet, dus de gewone tests merken het niet.
 *
 * Regel: een JSON-parameter altijd als `$n::text::jsonb` schrijven. Dan is het
 * parametertype `text` en parseert Postgres de tekst tot een echt object.
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const WORTEL = join(HIER, '..');

function bronbestanden(map: string): string[] {
  const uit: string[] = [];
  for (const naam of readdirSync(map)) {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) uit.push(...bronbestanden(pad));
    else if (naam.endsWith('.ts') && !naam.endsWith('.test.ts')) uit.push(pad);
  }
  return uit;
}

// `$3::jsonb` of `$${params.length}::jsonb`, maar niet `$3::text::jsonb`.
const FOUT_PATROON = /\$(\d+|\$\{[^}]+\})::jsonb/g;

describe('JSON-parameters in SQL', () => {
  it('gebruikt nergens $n::jsonb (moet $n::text::jsonb zijn)', () => {
    const fouten: string[] = [];
    for (const map of ['src', 'scripts']) {
      for (const pad of bronbestanden(join(WORTEL, map))) {
        const regels = readFileSync(pad, 'utf8').split('\n');
        regels.forEach((regel, i) => {
          if (FOUT_PATROON.test(regel)) fouten.push(`${relative(WORTEL, pad)}:${i + 1}: ${regel.trim()}`);
          FOUT_PATROON.lastIndex = 0;
        });
      }
    }
    assert.deepEqual(fouten, [], `Gebruik $n::text::jsonb:\n${fouten.join('\n')}`);
  });
});
