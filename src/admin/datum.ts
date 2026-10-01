/**
 * Datumweergave voor de goedkeuringspagina (SPEC §12). Altijd
 * `Europe/Amsterdam` en in Nederlands kort formaat: "1 okt, 13:07".
 *
 * Node's `Intl.DateTimeFormat('nl-NL', { month: 'short' })` levert
 * standaard "okt." met een punt; die strippen we zodat het formaat compact
 * en consistent blijft. Tijd staat in 24-uursnotatie (`hourCycle: 'h23'`)
 * zodat 00:00 niet als "24:00" verschijnt.
 */

const AMSTERDAM = 'Europe/Amsterdam';

const DATUM_FORMATTER = new Intl.DateTimeFormat('nl-NL', {
  timeZone: AMSTERDAM,
  day: 'numeric',
  month: 'short',
});

const TIJD_FORMATTER = new Intl.DateTimeFormat('nl-NL', {
  timeZone: AMSTERDAM,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatteerAmsterdam(d: Date): string {
  const datum = DATUM_FORMATTER.format(d).replace(/\.$/, '');
  const tijd = TIJD_FORMATTER.format(d);
  return `${datum}, ${tijd}`;
}
