import { allocateDaily, type AllocOrder } from "../lib/allocate.js";
import { parseCsv, pick } from "../lib/csv.js";
import { parseDate } from "../lib/date.js";
import { fetchAudRates, rateFor } from "../lib/fx.js";
import { fromCents, parseAmount, toCents } from "../lib/money.js";
import type {
  GatewayReconciliation,
  Order,
  PaypalFeeDetail,
  ProcessParams,
  RoundingAdjustment,
} from "../types.js";
import { buildReconciliation } from "./reconcile.js";

/**
 * Step 7 — PayPal fees, converted to AUD and allocated to Shopify Order names.
 *
 * PayPal fees are charged in each transaction's own currency, so every
 * fee-bearing row is converted to AUD at its date's rate (Frankfurter / ECB),
 * summed per day, then allocated across the Net-Payments PayPal orders pro-rata
 * by gross−refund. PayPal merchant fees are GST-exempt. Order gross is recorded
 * in AUD (OriginalCurrency = AUD), per the chosen currency handling.
 */
export async function processPaypalFees(
  activityBuf: Buffer,
  paypalOrders: Order[],
  params: ProcessParams,
): Promise<{
  details: PaypalFeeDetail[];
  reconciliation: GatewayReconciliation;
  adjustments: RoundingAdjustment[];
  fxFailedCurrencies: string[];
}> {
  const { rows } = parseCsv(activityBuf);

  // Collect fee-bearing rows with their date + currency.
  const feeRows = rows
    .map((row) => {
      const fee = parseAmount(pick(row, ["fee", "fees"]));
      if (fee === 0) return null;
      const iso = parseDate(pick(row, ["date"]));
      return {
        iso,
        currency: (pick(row, ["currency"]) || "AUD").toUpperCase(),
        feeCost: -fee, // report deducts fees as negative; flip to positive cost
      };
    })
    .filter((r): r is { iso: string | null; currency: string; feeCost: number } => !!r)
    .filter((r) => {
      if (!r.iso) return true;
      if (params.dateStart && r.iso < params.dateStart) return false;
      if (params.dateEnd && r.iso > params.dateEnd) return false;
      return true;
    });

  // Fetch AUD rates across the date range for every non-AUD currency.
  const currencies = [...new Set(feeRows.map((r) => r.currency))];
  const isoDates = feeRows.map((r) => r.iso).filter((d): d is string => !!d).sort();
  const table =
    isoDates.length > 0
      ? await fetchAudRates(currencies, isoDates[0], isoDates[isoDates.length - 1])
      : { byCurrency: {}, failed: currencies.filter((c) => c !== "AUD") };

  // Daily AUD fee pool (by PayPal transaction date).
  const sourceDaily = new Map<string, number>();
  const fxFailed = new Set<string>();
  for (const r of feeRows) {
    const rate = rateFor(table, r.currency, r.iso);
    if (rate == null) {
      fxFailed.add(r.currency);
      continue;
    }
    const day = r.iso ?? "";
    sourceDaily.set(day, (sourceDaily.get(day) ?? 0) + toCents(r.feeCost * rate));
  }

  // Allocate the daily AUD fee pool to PayPal orders (weight = gross − refund).
  const allocOrders: AllocOrder[] = paypalOrders.map((o) => ({
    orderId: o.orderId,
    dayKey: o.date ?? "",
    weightCents: o.netCents,
  }));
  const dailyTotals = new Map<string, Record<string, number>>();
  for (const [d, cents] of sourceDaily) dailyTotals.set(d, { fee: cents });

  const alloc = allocateDaily(allocOrders, dailyTotals, ["fee"]);

  const allocatedDaily = new Map<string, number>();
  const details: PaypalFeeDetail[] = paypalOrders.map((o) => {
    const fee = alloc.perOrder.get(o.orderId)?.fee ?? 0;
    const date = o.date ?? "";
    allocatedDaily.set(date, (allocatedDaily.get(date) ?? 0) + fee);
    return {
      Date: date,
      OrderID: o.orderId,
      OriginalCurrency: "AUD",
      GrossOriginalCurrency: fromCents(o.netCents),
      GrossAmountAUD: fromCents(o.netCents),
      FeeAmountAUD: fromCents(fee),
      NetAmountAUD: fromCents(o.netCents - fee),
      Type: o.netCents < 0 ? "Refund" : "Sale",
    };
  });

  const reconciliation = buildReconciliation(
    "PayPal",
    sourceDaily,
    allocatedDaily,
    alloc.unallocated.map((u) => ({ date: u.date, cents: u.components.fee ?? 0 })),
  );
  const adjustments: RoundingAdjustment[] = alloc.adjustments.map((a) => ({
    gateway: "PayPal",
    ...a,
  }));

  return {
    details,
    reconciliation,
    adjustments,
    fxFailedCurrencies: [...fxFailed],
  };
}
