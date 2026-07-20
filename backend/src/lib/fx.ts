/**
 * Dynamic historical FX rates from the **Reserve Bank of Australia** (RBA),
 * statistical table F11.1 "Exchange Rates – Daily". Free, no API key, published
 * every business day and keyed by date — so the pipeline works for ANY period
 * with nothing hard-coded.
 *
 * The table quotes rates as **foreign units per 1 AUD** (columns headed
 * `A$1=USD`, `A$1=EUR`, …), matching `toAUD(amount) = amount / rate`.
 *
 * The whole CSV (a few hundred KB, ~2 years of daily rows) is fetched once and
 * parsed into memory. Lookups fall back to the nearest prior business day for
 * weekends / public holidays. Coverage starts 2023-01-03; dates before that (or
 * currencies the RBA doesn't publish) resolve to null and are excluded upstream.
 */

const RBA_CSV_URL = "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv";
const MAX_BACKFILL_DAYS = 7; // how far back to search for a business-day rate

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

interface RbaTable {
  isos: string[]; // ascending ISO dates that have a data row
  rows: Map<string, Record<string, number>>; // iso -> { USD: rate, EUR: rate, ... }
}

// "03-Jan-2023" -> "2023-01-03"; returns null if not a recognised date cell.
function rbaDateToISO(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

function parseRbaCsv(text: string): RbaTable {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  // Map each column index to a currency code, from the "Title" row's `A$1=XXX`.
  const curByCol: Record<number, string> = {};
  const titleLine = lines.find((l) => l.startsWith("Title,"));
  if (titleLine) {
    titleLine.split(",").forEach((cell, i) => {
      const m = cell.trim().match(/^A\$1=([A-Za-z]{3})$/);
      if (m) curByCol[i] = m[1].toUpperCase();
    });
  }

  const rows = new Map<string, Record<string, number>>();
  const isos: string[] = [];
  for (const line of lines) {
    const cols = line.split(",");
    const iso = rbaDateToISO(cols[0] ?? "");
    if (!iso) continue;
    const rec: Record<string, number> = {};
    for (const [idxStr, cur] of Object.entries(curByCol)) {
      const raw = cols[Number(idxStr)];
      const v = raw != null && raw.trim() !== "" ? parseFloat(raw) : NaN;
      if (Number.isFinite(v)) rec[cur] = v;
    }
    rows.set(iso, rec);
    isos.push(iso);
  }
  isos.sort();
  return { isos, rows };
}

let tablePromise: Promise<RbaTable | null> | null = null;
async function getTable(): Promise<RbaTable | null> {
  if (!tablePromise) {
    tablePromise = (async () => {
      try {
        const res = await fetch(RBA_CSV_URL, {
          headers: { "User-Agent": "saint-merchant-backend/1.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseRbaCsv(await res.text());
      } catch {
        return null; // network / parse failure -> callers treat rates as unavailable
      }
    })();
  }
  return tablePromise;
}

/** Largest ISO in `isos` that is <= target (binary search). */
function floorIndex(isos: string[], target: string): number {
  let lo = 0, hi = isos.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (isos[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function lookup(table: RbaTable, iso: string, cur: string): number | null {
  // Start at the latest published day <= iso, then walk back to the nearest
  // prior day that actually has a rate for this currency (weekends/holidays),
  // giving up once we're more than MAX_BACKFILL_DAYS calendar days away.
  for (let idx = floorIndex(table.isos, iso); idx >= 0; idx--) {
    const day = table.isos[idx];
    if (daysBetween(day, iso) > MAX_BACKFILL_DAYS) break;
    const v = table.rows.get(day)?.[cur];
    if (typeof v === "number") return v;
  }
  return null;
}

/**
 * Resolve all needed (date, currency) rates. `byDate` maps an ISO day to the set
 * of currencies needed that day. Returns a map keyed `${iso}|${CUR}` whose value
 * is the RBA rate (foreign per AUD) or null when unavailable.
 */
export async function resolveAudRates(
  byDate: Map<string, Set<string>>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (byDate.size === 0) return out;

  const table = await getTable();
  for (const [iso, currencies] of byDate) {
    for (const c of currencies) {
      out.set(`${iso}|${c}`, table ? lookup(table, iso, c.toUpperCase()) : null);
    }
  }
  return out;
}
