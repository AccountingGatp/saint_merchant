import { allocateDaily, type AllocOrder } from "../lib/allocate.js";
import { parseCsv, pick } from "../lib/csv.js";
import { parseDate } from "../lib/date.js";
import { fromCents, parseAmount, toCents } from "../lib/money.js";
import type {
  AfterpayFeeDetail,
  GatewayReconciliation,
  Order,
  ProcessParams,
  RoundingAdjustment,
} from "../types.js";
import { buildReconciliation } from "./reconcile.js";

/**
 * Step 6 — Afterpay fees, allocated to Shopify Order names.
 *
 * The settlement report's Merchant Order ID is an Afterpay token that never
 * matches Shopify order numbers, so its per-day merchant fees are allocated
 * across the Net-Payments Afterpay orders pro-rata by each order's gross−refund.
 * Settlement fees are bucketed by the settlement row's ORDER date so the daily
 * buckets align with the Shopify order days.
 */
export function processAfterpayFees(
  settlementBuf: Buffer,
  afterpayOrders: Order[],
  params: ProcessParams,
): {
  details: AfterpayFeeDetail[];
  reconciliation: GatewayReconciliation;
  adjustments: RoundingAdjustment[];
} {
  const { rows } = parseCsv(settlementBuf);

  // Daily settlement fee totals (by order date): gst + incl cents (signed).
  const daily = new Map<string, { gst: number; incl: number }>();
  const sourceDaily = new Map<string, number>(); // incl cents, for reconciliation

  for (const row of rows) {
    const feeExcl = parseAmount(
      pick(row, ["merchantfeeexcltax", "merchantfeeexclgst", "feeexcltax"]),
    );
    const feeTax = parseAmount(
      pick(row, ["merchantfeetax", "merchantfeegst", "feetax", "tax"]),
    );
    let feeIncl = parseAmount(
      pick(row, ["merchantfeeincltax", "merchantfeeinclgst", "feeincltax", "merchantfee"]),
    );
    if (feeIncl === 0 && (feeExcl !== 0 || feeTax !== 0)) feeIncl = feeExcl + feeTax;
    if (feeIncl === 0 && feeTax === 0) continue;

    const date =
      parseDate(pick(row, ["orderdateandtime", "isoorderdateandtime", "settlementdate", "isosettlementdate", "date"]));
    if (!date) continue;
    if (params.dateStart && date < params.dateStart) continue;
    if (params.dateEnd && date > params.dateEnd) continue;

    const gst = feeTax !== 0 ? feeTax : feeIncl - feeExcl;
    const bucket = daily.get(date) ?? { gst: 0, incl: 0 };
    bucket.gst += toCents(gst);
    bucket.incl += toCents(feeIncl);
    daily.set(date, bucket);
    sourceDaily.set(date, (sourceDaily.get(date) ?? 0) + toCents(feeIncl));
  }

  // Allocate to Afterpay orders (weight = gross − refund).
  const allocOrders: AllocOrder[] = afterpayOrders.map((o) => ({
    orderId: o.orderId,
    dayKey: o.date ?? "",
    weightCents: o.netCents,
  }));
  const dailyTotals = new Map<string, Record<string, number>>();
  for (const [d, v] of daily) dailyTotals.set(d, { gst: v.gst, incl: v.incl });

  const alloc = allocateDaily(allocOrders, dailyTotals, ["gst", "incl"]);

  const allocatedDaily = new Map<string, number>();
  const details: AfterpayFeeDetail[] = afterpayOrders.map((o) => {
    const a = alloc.perOrder.get(o.orderId) ?? { gst: 0, incl: 0 };
    const incl = a.incl;
    const gst = a.gst;
    const date = o.date ?? "";
    allocatedDaily.set(date, (allocatedDaily.get(date) ?? 0) + incl);
    return {
      Date: date,
      OrderID: o.orderId,
      GrossAmountAUD: fromCents(o.netCents),
      MerchantFeeExclGST: fromCents(incl - gst),
      MerchantFeeGST: fromCents(gst),
      MerchantFeeInclGST: fromCents(incl),
      NetAmountAUD: fromCents(o.netCents - incl),
    };
  });

  const reconciliation = buildReconciliation(
    "Afterpay",
    sourceDaily,
    allocatedDaily,
    alloc.unallocated.map((u) => ({ date: u.date, cents: u.components.incl ?? 0 })),
  );
  const adjustments: RoundingAdjustment[] = alloc.adjustments.map((a) => ({
    gateway: "Afterpay",
    ...a,
  }));

  return { details, reconciliation, adjustments };
}
