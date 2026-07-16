/*
 * Merchant Fee Report generator (Shopify Payments + Afterpay + PayPal)
 * ====================================================================
 * Port of the standalone `final.csv` / `merchant_fees.xlsx` generator, adapted
 * to run inside the backend over in-memory CSV buffers (no disk I/O) and to
 * honour the optional date-range / order-range filters.
 *
 * Method (per spec):
 *   1. Net payments defines the orders, their Order name, day and gateway.
 *   2. For each gateway & day, compute the TOTAL fee from that gateway's own
 *      source report (in AUD), then allocate it across that day's orders
 *      pro-rata by each order's net payment (gross - refunds).
 *   3. Daily allocated fees are forced to reconcile to the source report (a
 *      1-2 cent rounding residual is pushed onto the largest-magnitude row).
 */

import zlib from "node:zlib";
import type {
  FileBuffers,
  GatewayReconciliation,
  ProcessParams,
  RoundingAdjustment,
} from "../types.js";
import { resolveAudRates } from "../lib/fx.js";

const GATEWAYS = ["Shopify Payments", "Afterpay", "PayPal"] as const;
type Gateway = (typeof GATEWAYS)[number];

// FX is fully dynamic: PayPal's own settlement rate (derived from the report's
// currency-conversion rows) is preferred; any remaining foreign fees are
// converted at the ECB historical rate for that transaction date (see lib/fx.ts).
// Nothing is hard-coded, so the pipeline is correct for any period.

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

type CsvRow = Record<string, string>;

function readCsv(buf: Buffer): CsvRow[] {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = parseCsv(text).filter(
    (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""),
  );
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const o: CsvRow = {};
    header.forEach((h, i) => { o[h] = (cols[i] !== undefined ? cols[i] : "").trim(); });
    return o;
  });
}

const money = (v: string | number | undefined | null): number => {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Normalise assorted date strings to YYYY-MM-DD.
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
function toISO(s: string): string {
  if (!s) return "";
  s = s.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) {
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})$/))) {
    return `20${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}`;
  }
  return s;
}

const orderNum = (name: string): number | null => {
  const mm = String(name || "").match(/(\d+)/);
  return mm ? parseInt(mm[1], 10) : null;
};

function gatewayOf(raw: string): Gateway | null {
  const g = (raw || "").toLowerCase();
  if (g.includes("afterpay")) return "Afterpay";
  if (g.includes("paypal")) return "PayPal";
  if (g.includes("shopify")) return "Shopify Payments";
  return null;
}

interface OrderRow {
  iso: string;
  gateway: Gateway;
  OrderID: string;
  weight: number;
  gross: number;
  refunded: number;
  netAmt: number;
  ex?: number;
  gst?: number;
}
interface Pool { ex: number; gst: number; }

// ---------------------------------------------------------------------------
// Pro-rata allocator with penny reconciliation.
// Daily sum of rounded ex / gst is forced to equal round2(pool.ex/gst).
// ---------------------------------------------------------------------------
function allocate(orders: OrderRow[], pool: Pool) {
  const targetEx = round2(pool.ex);
  const targetGst = round2(pool.gst);
  let denom = orders.reduce((s, o) => s + o.weight, 0);
  let weights = orders.map((o) => o.weight);
  if (Math.abs(denom) < 0.005) { // refund-dominated day -> fall back to absolute weights
    weights = orders.map((o) => Math.abs(o.weight) || 1);
    denom = weights.reduce((s, w) => s + w, 0);
  }
  orders.forEach((o, i) => {
    o.ex = round2(targetEx * (weights[i] / denom));
    o.gst = round2(targetGst * (weights[i] / denom));
  });
  // push rounding residual onto the largest-magnitude weight
  let big = 0;
  orders.forEach((_, i) => { if (Math.abs(weights[i]) > Math.abs(weights[big])) big = i; });
  const adj = { ex: 0, gst: 0 };
  if (orders.length) {
    const diffEx = round2(targetEx - orders.reduce((s, o) => s + (o.ex ?? 0), 0));
    const diffGst = round2(targetGst - orders.reduce((s, o) => s + (o.gst ?? 0), 0));
    orders[big].ex = round2((orders[big].ex ?? 0) + diffEx);
    orders[big].gst = round2((orders[big].gst ?? 0) + diffGst);
    adj.ex = diffEx; adj.gst = diffGst;
  }
  return { targetEx, targetGst, adj, adjOrder: orders.length ? orders[big].OrderID : null };
}

// ---------------------------------------------------------------------------
// Minimal dependency-free XLSX writer (multi-sheet, numbers + inline strings).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const comp = zlib.deflateRawSync(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

type Cell = string | number;
const xmlEsc = (s: Cell): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] as string));
function colLetter(n: number): string {
  let s = ""; n++;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}
function sheetXml(rows: Cell[][]): string {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  rows.forEach((row, r) => {
    out.push(`<row r="${r + 1}">`);
    row.forEach((cell, c) => {
      const ref = colLetter(c) + (r + 1);
      if (typeof cell === "number" && Number.isFinite(cell)) {
        out.push(`<c r="${ref}"><v>${cell}</v></c>`);
      } else {
        out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell)}</t></is></c>`);
      }
    });
    out.push("</row>");
  });
  out.push("</sheetData></worksheet>");
  return out.join("");
}
function buildXlsx(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    "</Types>"].join("");
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    "</Relationships>";
  const files = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows), "utf8") })),
  ];
  return zip(files);
}

// ---------------------------------------------------------------------------
// Build daily fee pools (AUD) per gateway from the source reports.
// ---------------------------------------------------------------------------
function shopifyPools(buf: Buffer, days: Set<string>): Record<string, Pool> {
  const rows = readCsv(buf);
  const pools: Record<string, Pool> = {};
  const feeTypes = new Set(["charge", "refund", "chargeback", "chargeback won"]);
  for (const r of rows) {
    const iso = toISO(r["Transaction Date"]);
    if (!days.has(iso)) continue;
    if (!feeTypes.has((r["Type"] || "").toLowerCase())) continue;
    // Fee/GST are already in AUD; per spec, summed at face value (no FX).
    const feeIncl = money(r["Fee"]);
    const gst = money(r["GST"]);
    (pools[iso] || (pools[iso] = { ex: 0, gst: 0 }));
    pools[iso].ex += feeIncl - gst;
    pools[iso].gst += gst;
  }
  return pools;
}

function afterpayPools(buf: Buffer, days: Set<string>): Record<string, Pool> {
  const rows = readCsv(buf);
  const pools: Record<string, Pool> = {};
  for (const r of rows) {
    const iso = toISO(r["ISO Settlement Date"] || r["Settlement Date"]);
    if (!days.has(iso)) continue;
    const ex = money(r["Merchant Fee excl Tax"]);
    const gst = money(r["Merchant Fee Tax"]);
    (pools[iso] || (pools[iso] = { ex: 0, gst: 0 }));
    pools[iso].ex += ex;
    pools[iso].gst += gst;
  }
  return pools;
}

// Derive PayPal's own effective FX (AUD per 1 unit of foreign currency) from the
// report's "General Currency Conversion" rows (matched foreign-out / AUD-in
// pairs sharing a Reference Txn ID). Low-volume currencies fall back to RBA.
const MIN_CONV_VOLUME = 1000;
function paypalFxRates(rows: CsvRow[]) {
  const agg: Record<string, { foreign: number; aud: number }> = {};
  const pairs: Record<string, CsvRow[]> = {};
  for (const r of rows) {
    if ((r["Type"] || "").toLowerCase() !== "general currency conversion") continue;
    const ref = r["Reference Txn ID"] || r["Transaction ID"];
    (pairs[ref] || (pairs[ref] = [])).push(r);
  }
  for (const ref of Object.keys(pairs)) {
    const p = pairs[ref];
    const aud = p.find((x) => (x["Currency"] || "") === "AUD");
    const fx = p.find((x) => (x["Currency"] || "") !== "AUD");
    if (!aud || !fx) continue;
    const c = fx["Currency"].toUpperCase();
    const a = agg[c] || (agg[c] = { foreign: 0, aud: 0 });
    a.foreign += Math.abs(money(fx["Gross"]));
    a.aud += Math.abs(money(aud["Gross"]));
  }
  const rates: Record<string, number> = { AUD: 1 };
  const reliable: Record<string, boolean> = { AUD: true };
  for (const c of Object.keys(agg)) {
    rates[c] = agg[c].aud / agg[c].foreign;
    reliable[c] = agg[c].foreign >= MIN_CONV_VOLUME;
  }
  return { rates, reliable };
}

// sales + refunds + withdrawal/payout fees (the full PayPal cost pool).
const PAYPAL_FEE_TYPES = new Set(["pre-approved payment bill user payment",
  "payment refund", "general payment", "user initiated withdrawal"]);

async function paypalPools(
  buf: Buffer,
  days: Set<string>,
  fxWarnings: Set<string>,
): Promise<Record<string, Pool>> {
  const rows = readCsv(buf);
  const { rates: ppRate, reliable } = paypalFxRates(rows);

  // Which fee rows count toward the pool.
  const feeRows = rows.filter((r) => {
    const iso = toISO(r["Date"]);
    return days.has(iso)
      && (r["Status"] || "").toLowerCase() === "completed"
      && PAYPAL_FEE_TYPES.has((r["Type"] || "").toLowerCase());
  });

  // Pass 1 — collect (date, currency) pairs that need an ECB rate (i.e. not AUD
  // and not reliably derivable from PayPal's own conversion rows).
  const needed = new Map<string, Set<string>>();
  for (const r of feeRows) {
    const c = (r["Currency"] || "AUD").toUpperCase();
    if (c === "AUD" || (ppRate[c] != null && reliable[c])) continue;
    const iso = toISO(r["Date"]);
    (needed.get(iso) || needed.set(iso, new Set()).get(iso)!).add(c);
  }
  const ecb = await resolveAudRates(needed); // `${iso}|${CUR}` -> foreign per AUD | null

  const ppToAud = (amount: number, cur: string, iso: string): number => {
    const c = (cur || "AUD").toUpperCase();
    if (c === "AUD") return amount;
    if (ppRate[c] != null && reliable[c]) return amount * ppRate[c]; // PayPal's own rate
    const rate = ecb.get(`${iso}|${c}`); // ECB historical rate for that day
    if (rate == null) { fxWarnings.add(c); return 0; } // unavailable -> excluded from AUD
    return amount / rate;
  };

  // Pass 2 — build the daily pools.
  const pools: Record<string, Pool> = {};
  for (const r of feeRows) {
    const iso = toISO(r["Date"]);
    const feeAud = ppToAud(money(r["Fee"]), r["Currency"], iso); // fees are negative in report
    (pools[iso] || (pools[iso] = { ex: 0, gst: 0 }));
    pools[iso].ex += -feeAud; // PayPal fees are GST-exempt -> all in ex-GST bucket
    pools[iso].gst += 0;
  }
  return pools;
}

// ---------------------------------------------------------------------------
// Result of a combine run.
// ---------------------------------------------------------------------------
export interface CombineResult {
  xlsx: Buffer;
  monthLabel: string;
  summary: {
    shopifyFees: number;
    afterpayFees: number;
    paypalFees: number;
    orderCounts: { shopify: number; paypal: number; afterpay: number };
  };
  reconciliation: GatewayReconciliation[];
  reconciled: boolean;
  adjustments: RoundingAdjustment[];
  fxWarnings: string[];
  days: string[];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dominantMonthLabel(isoDates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of isoDates) {
    const ym = d.slice(0, 7);
    if (ym) counts.set(ym, (counts.get(ym) ?? 0) + 1);
  }
  let best: string | null = null, bestCount = 0;
  for (const [ym, c] of counts) if (c > bestCount) { best = ym; bestCount = c; }
  if (best) {
    const [y, m] = best.split("-");
    return `${MONTH_NAMES[+m - 1]}${y}`;
  }
  const now = new Date();
  return `${MONTH_NAMES[now.getMonth()]}${now.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Combine — the ported `main()`, returning data instead of writing files.
// ---------------------------------------------------------------------------
export async function combine(files: FileBuffers, params: ProcessParams): Promise<CombineResult> {
  const orderMin = params.orderStart ? orderNum(params.orderStart) : null;
  const orderMax = params.orderEnd ? orderNum(params.orderEnd) : null;
  const inRange = (name: string): boolean => {
    if (orderMin == null && orderMax == null) return true;
    const n = orderNum(name);
    if (n == null) return false;
    if (orderMin != null && n < orderMin) return false;
    if (orderMax != null && n > orderMax) return false;
    return true;
  };
  const inDate = (iso: string): boolean => {
    if (params.dateStart && (!iso || iso < params.dateStart)) return false;
    if (params.dateEnd && (!iso || iso > params.dateEnd)) return false;
    return true;
  };

  // 1. Net payments = source of truth. Build per-gateway/day order lists.
  const net = readCsv(files["shopify-net-payments"]!);
  const days = new Set<string>();
  const orders: OrderRow[] = [];
  for (const r of net) {
    const gateway = gatewayOf(r["Payment gateway"]);
    if (!gateway) continue;
    const name = r["Order name"];
    if (!inRange(name)) continue;
    const iso = toISO(r["Day"]);
    if (!inDate(iso)) continue;
    const gross = money(r["Gross payments"]);
    const refunded = money(r["Refunded payments"]); // negative
    const netAmt = money(r["Net payments"]);         // gross + refunded
    days.add(iso);
    orders.push({ iso, gateway, OrderID: name, weight: netAmt, gross, refunded, netAmt });
  }

  // 2. Daily fee pools per gateway (AUD). PayPal may fetch historical FX rates.
  const fxWarn = new Set<string>();
  const pools: Record<Gateway, Record<string, Pool>> = {
    "Shopify Payments": shopifyPools(files["shopify-payment-transactions"]!, days),
    "Afterpay": afterpayPools(files["afterpay-settlement"]!, days),
    "PayPal": await paypalPools(files["paypal-activity"]!, days, fxWarn),
  };

  // 3. Allocate each day's pool across that day's orders, per gateway.
  const adjustments: RoundingAdjustment[] = [];
  for (const gateway of GATEWAYS) {
    const byDay: Record<string, OrderRow[]> = {};
    orders.filter((o) => o.gateway === gateway).forEach((o) => (byDay[o.iso] || (byDay[o.iso] = [])).push(o));
    for (const iso of Object.keys(byDay)) {
      const pool = pools[gateway][iso] || { ex: 0, gst: 0 };
      const res = allocate(byDay[iso], pool);
      if (Math.abs(res.adj.ex) >= 0.005 || Math.abs(res.adj.gst) >= 0.005) {
        adjustments.push({
          gateway,
          date: iso,
          orderId: res.adjOrder ?? "",
          cents: Math.round((res.adj.ex + res.adj.gst) * 100),
        });
      }
    }
  }

  // 4. Emit per-gateway workbook rows + running totals.
  orders.sort((a, b) => a.iso.localeCompare(b.iso) || a.gateway.localeCompare(b.gateway)
    || ((orderNum(a.OrderID) ?? 0) - (orderNum(b.OrderID) ?? 0)));

  interface Totals { gross: number; ex: number; gst: number; incl: number; net: number; n: number; }
  const totals: Record<Gateway, Totals> = {
    "Shopify Payments": { gross: 0, ex: 0, gst: 0, incl: 0, net: 0, n: 0 },
    "Afterpay": { gross: 0, ex: 0, gst: 0, incl: 0, net: 0, n: 0 },
    "PayPal": { gross: 0, ex: 0, gst: 0, incl: 0, net: 0, n: 0 },
  };
  const sheetRows: Record<Gateway, Cell[][]> = {
    "Shopify Payments": [], "Afterpay": [], "PayPal": [],
  };
  interface Agg { n: number; gross: number; ex: number; gst: number; incl: number; net: number; }
  const summary: Record<string, Partial<Record<Gateway, Agg>>> = {};
  const bump = (iso: string, gw: Gateway, gross: number, ex: number, gst: number, incl: number, net: number) => {
    const d = summary[iso] || (summary[iso] = {});
    const a = d[gw] || (d[gw] = { n: 0, gross: 0, ex: 0, gst: 0, incl: 0, net: 0 });
    a.n++; a.gross += gross; a.ex += ex; a.gst += gst; a.incl += incl; a.net += net;
  };

  for (const o of orders) {
    const ex = round2(o.ex ?? 0);
    const gst = round2(o.gst ?? 0);
    const incl = round2(ex + gst);
    const gross = round2(o.netAmt);
    const netAud = round2(gross - incl);
    const type = o.netAmt < 0 ? "Refund" : "Sale";
    const t = totals[o.gateway];
    t.gross += gross; t.ex += ex; t.gst += gst; t.incl += incl; t.net += netAud; t.n++;
    bump(o.iso, o.gateway, gross, ex, gst, incl, netAud);

    if (o.gateway === "Shopify Payments") {
      sheetRows["Shopify Payments"].push([o.iso, o.OrderID, gross, ex, gst, incl, netAud]);
    } else if (o.gateway === "Afterpay") {
      sheetRows["Afterpay"].push([o.iso, o.OrderID, gross, ex, gst, incl, netAud]);
    } else {
      // PayPal fees are GST-exempt -> FeeAmountAUD = incl. Gross basis is Net payments (AUD).
      sheetRows["PayPal"].push([o.iso, o.OrderID, "AUD", gross, gross, incl, netAud, type]);
    }
  }

  // 4b. Combined summary (sheet 1): stacked date-wise pivot blocks.
  const isoDays = Object.keys(summary).sort();
  const mdY = (iso: string): string => { const [y, m, d] = iso.split("-"); return `${+m}/${+d}/${y}`; };

  function block(
    title: string,
    gw: Gateway,
    header: Cell[],
    metricsFor: (a: Agg) => Cell[],
  ): Cell[][] {
    const rows: Cell[][] = [];
    if (title) rows.push([title]);
    rows.push(header);
    const tot: Agg = { n: 0, gross: 0, ex: 0, gst: 0, incl: 0, net: 0 };
    for (const iso of isoDays) {
      const a = summary[iso][gw];
      if (!a) continue;
      rows.push([mdY(iso), ...metricsFor(a)]);
      (["n", "gross", "ex", "gst", "incl", "net"] as (keyof Agg)[]).forEach((k) => { tot[k] += a[k]; });
    }
    rows.push(["Grand Total", ...metricsFor({
      n: tot.n, gross: round2(tot.gross), ex: round2(tot.ex),
      gst: round2(tot.gst), incl: round2(tot.incl), net: round2(tot.net),
    })]);
    rows.push([]); // spacer
    return rows;
  }

  const summaryRows: Cell[][] = [
    ...block("Afterpay", "Afterpay",
      ["Row Labels", "Count of OrderID", "Sum of GrossAmountAUD", "Sum of MerchantFeeExclGST",
        "Sum of MerchantFeeGST", "Sum of MerchantFeeInclGST", "Sum of NetAmountAUD"],
      (a) => [a.n, round2(a.gross), round2(a.ex), round2(a.gst), round2(a.incl), round2(a.net)]),
    ...block("Paypal", "PayPal",
      ["Row Labels", "Count of OrderID", "Sum of GrossOriginalCurrency", "Sum of GrossAmountAUD",
        "Sum of FeeAmountAUD", "Sum of NetAmountAUD"],
      (a) => [a.n, round2(a.gross), round2(a.gross), round2(a.incl), round2(a.net)]),
    ...block("Shopify Payments", "Shopify Payments",
      ["Row Labels", "Count of OrderID", "Sum of GrossAmountAUD", "Sum of FeeExGST",
        "Sum of GSTOnFee", "Sum of FeeInclGST", "Sum of NetAmountAUD"],
      (a) => [a.n, round2(a.gross), round2(a.ex), round2(a.gst), round2(a.incl), round2(a.net)]),
  ];

  const xlsx = buildXlsx([
    { name: "Combined Summary", rows: summaryRows },
    { name: "Shopify Fees", rows: [["Date", "OrderID", "GrossAmountAUD", "FeeExGST", "GSTOnFee", "FeeInclGST", "NetAmountAUD"], ...sheetRows["Shopify Payments"]] },
    { name: "Afterpay Fees", rows: [["Date", "OrderID", "GrossAmountAUD", "MerchantFeeExclGST", "MerchantFeeGST", "MerchantFeeInclGST", "NetAmountAUD"], ...sheetRows["Afterpay"]] },
    { name: "PayPal Fees", rows: [["Date", "OrderID", "OriginalCurrency", "GrossOriginalCurrency", "GrossAmountAUD", "FeeAmountAUD", "NetAmountAUD", "Type"], ...sheetRows["PayPal"]] },
  ]);

  // 5. Reconciliation per gateway: allocated vs full source pool; report any
  // source-pool days that had no matching orders (fees dropped -> unallocated).
  const reconciliation: GatewayReconciliation[] = GATEWAYS.map((g) => {
    const pool = pools[g];
    const orderDays = new Set(orders.filter((o) => o.gateway === g).map((o) => o.iso));
    let sourceEx = 0, sourceGst = 0;
    const unallocated: { date: string; amount: number }[] = [];
    for (const iso of Object.keys(pool)) {
      sourceEx += pool[iso].ex;
      sourceGst += pool[iso].gst;
      if (!orderDays.has(iso)) {
        const amount = round2(pool[iso].ex + pool[iso].gst);
        if (Math.abs(amount) >= 0.005) unallocated.push({ date: iso, amount });
      }
    }
    const sourceTotal = round2(sourceEx + sourceGst);
    const allocatedTotal = round2(totals[g].incl);
    const difference = round2(allocatedTotal - sourceTotal);
    return {
      gateway: g,
      reconciled: Math.abs(difference) < 0.005,
      sourceTotal,
      allocatedTotal,
      difference,
      dailyMismatches: [], // per-day allocation always ties to the pool
      unallocated,
    };
  });
  const reconciled = reconciliation.every((r) => r.reconciled);

  return {
    xlsx,
    monthLabel: dominantMonthLabel(orders.map((o) => o.iso)),
    summary: {
      shopifyFees: round2(totals["Shopify Payments"].incl),
      afterpayFees: round2(totals["Afterpay"].incl),
      paypalFees: round2(totals["PayPal"].incl),
      orderCounts: {
        shopify: totals["Shopify Payments"].n,
        paypal: totals["PayPal"].n,
        afterpay: totals["Afterpay"].n,
      },
    },
    reconciliation,
    reconciled,
    adjustments,
    fxWarnings: [...fxWarn],
    days: [...days].sort(),
  };
}
