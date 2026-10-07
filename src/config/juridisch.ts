import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versies van voorwaarden en verwerkersovereenkomst (SPEC §14.2, §14.5) en de
 * geldigheid van koppeluitnodigingen. Bron: `config/juridisch.json`. Een lege
 * `url` betekent: geen link tonen, MARKaaS stuurt het document zelf mee.
 */

export interface JuridischDocument {
  versie: string;
  url: string;
}

export interface Juridisch {
  voorwaarden: JuridischDocument;
  verwerkersovereenkomst: JuridischDocument;
  koppeluitnodiging_geldig_dagen: number;
}

const HIER = dirname(fileURLToPath(import.meta.url));
const STANDAARD_PAD = join(HIER, '..', '..', 'config', 'juridisch.json');

export async function laadJuridisch(pad: string = STANDAARD_PAD): Promise<Juridisch> {
  const inhoud = await readFile(pad, 'utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(inhoud);
  } catch (err) {
    throw new Error(
      `config/juridisch.json kan niet gelezen worden als JSON (${(err as Error).message}).`,
    );
  }
  return juridischUitObject(obj);
}

export function juridischUitObject(obj: unknown): Juridisch {
  if (!isRecord(obj)) throw new Error('Juridische configuratie moet een object zijn.');
  const dagen = obj['koppeluitnodiging_geldig_dagen'];
  if (typeof dagen !== 'number' || !Number.isInteger(dagen) || dagen <= 0) {
    throw new Error(
      `Veld "koppeluitnodiging_geldig_dagen" moet een positief geheel getal zijn (gaf ${JSON.stringify(dagen)}).`,
    );
  }
  return {
    voorwaarden: parseDocument(obj, 'voorwaarden'),
    verwerkersovereenkomst: parseDocument(obj, 'verwerkersovereenkomst'),
    koppeluitnodiging_geldig_dagen: dagen,
  };
}

function parseDocument(obj: Record<string, unknown>, veld: string): JuridischDocument {
  const raw = obj[veld];
  if (!isRecord(raw)) {
    throw new Error(`Veld "${veld}" ontbreekt in config/juridisch.json (verwacht {versie, url}).`);
  }
  const versie = raw['versie'];
  if (typeof versie !== 'string' || versie.trim() === '') {
    throw new Error(`Veld "${veld}.versie" moet een niet-lege tekst zijn.`);
  }
  const url = raw['url'] ?? '';
  if (typeof url !== 'string') {
    throw new Error(`Veld "${veld}.url" moet een tekst zijn (leeg = document wordt meegestuurd).`);
  }
  if (url.trim() !== '') {
    let geparsed: URL;
    try {
      geparsed = new URL(url);
    } catch {
      throw new Error(`Veld "${veld}.url" is geen geldige URL.`);
    }
    if (geparsed.protocol !== 'https:' && geparsed.protocol !== 'http:') {
      throw new Error(`Veld "${veld}.url" moet met https:// beginnen.`);
    }
  }
  return { versie: versie.trim(), url: url.trim() };
}

function isRecord(waarde: unknown): waarde is Record<string, unknown> {
  return typeof waarde === 'object' && waarde !== null && !Array.isArray(waarde);
}
