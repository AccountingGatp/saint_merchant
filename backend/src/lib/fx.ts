/**
 * Historical FX via Frankfurter (https://frankfurter.dev) — daily ECB reference
 * rates. One time-series request per currency converts every transaction at the
 * rate for its own date (nearest prior business day for weekends/holidays).
 */

const FRANKFURTER = "https://api.frankfurter.dev/v1";

interface CurrencyRates {
  /** ascending ISO dates that have a rate */
  dates: string[];
  /** ISO date -> units of AUD per 1 unit of the currency */
  rates: Record<string, number>;
}

export interface RateTable {
  byCurrency: Record<string, CurrencyRates>;
  /** currencies whose rates could not be fetched */
  failed: string[];
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch AUD conversion rates for each currency over [startDate, endDate]. */
export async function fetchAudRates(
  currencies: string[],
  startDate: string,
  endDate: string,
): Promise<RateTable> {
  const byCurrency: Record<string, CurrencyRates> = {};
  const failed: string[] = [];

  const targets = [...new Set(currencies)].filter((c) => c && c !== "AUD");

  await Promise.all(
    targets.map(async (cur) => {
      try {
        const url = `${FRANKFURTER}/${startDate}..${endDate}?base=${cur}&symbols=AUD`;
        const data = await fetchJson(url);
        const rates: Record<string, number> = {};
        for (const [date, obj] of Object.entries<any>(data?.rates ?? {})) {
          const r = obj?.AUD;
          if (typeof r === "number") rates[date] = r;
        }
        const dates = Object.keys(rates).sort();
        if (dates.length === 0) throw new Error("no rates returned");
        byCurrency[cur] = { dates, rates };
      } catch {
        failed.push(cur);
      }
    }),
  );

  return { byCurrency, failed };
}

/**
 * AUD per 1 unit of `currency` on `isoDate`. Returns 1 for AUD, null if the
 * currency's rates are unavailable. Uses the exact date, else the nearest prior
 * available date, else the earliest available.
 */
export function rateFor(
  table: RateTable,
  currency: string,
  isoDate: string | null,
): number | null {
  if (currency === "AUD") return 1;
  const entry = table.byCurrency[currency];
  if (!entry || entry.dates.length === 0) return null;
  if (isoDate && entry.rates[isoDate] != null) return entry.rates[isoDate];

  if (isoDate) {
    for (let i = entry.dates.length - 1; i >= 0; i--) {
      if (entry.dates[i] <= isoDate) return entry.rates[entry.dates[i]];
    }
  }
  // Before the available range (or no date) -> earliest known rate.
  return entry.rates[entry.dates[0]];
}
