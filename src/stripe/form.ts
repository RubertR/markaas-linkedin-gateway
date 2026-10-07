/**
 * Form-encoding zoals de Stripe-API die verwacht
 * (`application/x-www-form-urlencoded` met geneste sleutels):
 * `{ line_items: [{ price: 'p', quantity: 2 }] }` →
 * `line_items[0][price]=p&line_items[0][quantity]=2`.
 * `undefined` en `null` worden weggelaten.
 */

export type FormWaarde =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormWaarde[]
  | { [sleutel: string]: FormWaarde };

export function stripeForm(velden: Record<string, FormWaarde>): string {
  const paren: Array<[string, string]> = [];
  const voegToe = (sleutel: string, waarde: FormWaarde): void => {
    if (waarde === undefined || waarde === null) return;
    if (Array.isArray(waarde)) {
      waarde.forEach((w, i) => voegToe(`${sleutel}[${i}]`, w));
    } else if (typeof waarde === 'object') {
      for (const [k, w] of Object.entries(waarde)) voegToe(`${sleutel}[${k}]`, w);
    } else {
      paren.push([sleutel, String(waarde)]);
    }
  };
  for (const [k, w] of Object.entries(velden)) voegToe(k, w);
  return new URLSearchParams(paren).toString();
}
