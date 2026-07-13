/** Money helpers. All internal math is done in integer cents to avoid float drift. */

export const toCents = (n: number): number => Math.round(n * 100);
export const fromCents = (c: number): number => Math.round(c) / 100;

/** Parse a currency-ish string ("$1,234.50", "(12.00)", "-3.5") into a number. */
export function parseAmount(raw: unknown): number {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  let negative = false;
  // Accounting parentheses => negative
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.includes("-")) negative = true;
  s = s.replace(/[^0-9.]/g, "");
  if (s === "" || s === ".") return 0;
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}
