/**
 * Injecteerbare klok. Tests gebruiken `vasteKlok` zodat tijdvensters,
 * weekgrenzen en zomer-/wintertijd deterministisch testbaar zijn (SPEC §5
 * controle 5). Productie gebruikt `systeemKlok`.
 */
export interface Klok {
  nu(): Date;
}

export const systeemKlok: Klok = {
  nu: () => new Date(),
};

export function vasteKlok(moment: Date | string | number): Klok {
  const ms =
    typeof moment === 'number'
      ? moment
      : moment instanceof Date
        ? moment.getTime()
        : Date.parse(moment);
  if (Number.isNaN(ms)) {
    throw new Error(`vasteKlok kreeg geen geldig moment: ${String(moment)}`);
  }
  return { nu: () => new Date(ms) };
}
