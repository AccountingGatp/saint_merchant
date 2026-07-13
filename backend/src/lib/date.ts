/** Flexible date parsing. Normalises many report formats to an ISO `yyyy-mm-dd` day key. */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const normYear = (y: number) => (y < 100 ? 2000 + y : y);

/**
 * Returns a `yyyy-mm-dd` string, or null if unparseable.
 * Ambiguous slash dates (both parts <= 12) are read as DD/MM/YYYY — this is an
 * AUD-based pipeline, so day-first is the sensible default.
 */
export function parseDate(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;

  // ISO: 2025-11-02 / 2025/11/02
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // 02-Nov-2025 / 2 Nov 2025 / 02-Nov
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s]?(\d{2,4})?/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) {
      const year = m[3] ? normYear(+m[3]) : new Date().getFullYear();
      return iso(year, mon, +m[1]);
    }
  }

  // Nov 2, 2025 / November 02 2025
  m = s.match(/^([A-Za-z]{3,})[-\s](\d{1,2}),?[-\s]?(\d{2,4})?/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) {
      const year = m[3] ? normYear(+m[3]) : new Date().getFullYear();
      return iso(year, mon, +m[2]);
    }
  }

  // dd/mm/yyyy or mm/dd/yyyy
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const year = normYear(+m[3]);
    let day: number;
    let month: number;
    if (a > 12) {
      day = a; month = b;
    } else if (b > 12) {
      month = a; day = b;
    } else {
      day = a; month = b; // ambiguous -> day-first (AU)
    }
    return iso(year, month, day);
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return null;
}

/** "2025-11-02" -> "Nov2025". Falls back to current month. */
export function monthLabel(isoDate: string | null): string {
  if (isoDate) {
    const m = isoDate.match(/^(\d{4})-(\d{2})/);
    if (m) return `${MONTH_NAMES[+m[2] - 1]}${m[1]}`;
  }
  const now = new Date();
  return `${MONTH_NAMES[now.getMonth()]}${now.getFullYear()}`;
}
