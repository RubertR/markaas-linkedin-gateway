import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

/** Versie uit package.json; één keer gelezen bij het starten. */
export function leesVersie(pad: string = PACKAGE_JSON): string {
  const pkg = JSON.parse(readFileSync(pad, 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : 'onbekend';
}
