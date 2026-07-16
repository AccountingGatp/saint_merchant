/**
 * Dynamic historical FX rates via the Frankfurter API (European Central Bank
 * reference rates). Free, no API key, and keyed by the actual transaction date,
 * so the pipeline works for ANY period — nothing is hard-coded.
 *
 * Convention: rates are returned as **foreign units per 1 AUD** (base = AUD),
 * matching `toAUD(amount) = amount / rate`.
 *
 * Weekends/holidays: Frankfurter returns the most recent prior working-day rate
 * automatically. Historical rates are immutable, so results are cached process-
 * wide by `date|currency` (safe across warm serverless invocations).
 */

const FRANKFURTER = "https://api.frankfurter.dev/v1";

// `${iso}|${CUR}` -> rate (foreign per AUD), or null if unavailable.
const rateCache = new Map<string, number | null>();

interface FrankfurterResponse {
  rates?: Record<string, number>;
}

/** Fetch every currency needed for one date in a single request; fill the cache. */
async function fetchDateRates(iso: string, currencies: string[]): Promise<void> {
  const missing = currencies.filter((c) => !rateCache.has(`${iso}|${c}`));
  if (missing.length === 0) return;

  const url = `${FRANKFURTER}/${iso}?base=AUD&symbols=${missing.join(",")}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as FrankfurterResponse;
    for (const c of missing) {
      const v = data.rates?.[c];
      rateCache.set(`${iso}|${c}`, typeof v === "number" && Number.isFinite(v) ? v : null);
    }
  } catch {
    // Network / unsupported currency / out-of-range date — mark unavailable.
    for (const c of missing) rateCache.set(`${iso}|${c}`, null);
  }
}

/**
 * Resolve all needed (date, currency) rates. `byDate` maps an ISO day to the set
 * of currencies needed that day. Returns a map keyed `${iso}|${CUR}` whose value
 * is the rate (foreign per AUD) or null when it could not be fetched.
 */
export async function resolveAudRates(
  byDate: Map<string, Set<string>>,
): Promise<Map<string, number | null>> {
  await Promise.all(
    [...byDate].map(([iso, currencies]) => fetchDateRates(iso, [...currencies])),
  );
  const out = new Map<string, number | null>();
  for (const [iso, currencies] of byDate) {
    for (const c of currencies) {
      out.set(`${iso}|${c}`, rateCache.get(`${iso}|${c}`) ?? null);
    }
  }
  return out;
}
