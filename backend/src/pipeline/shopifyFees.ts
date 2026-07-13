import { parseCsv, pick } from "../lib/csv.js";
import { fromCents, parseAmount, toCents } from "../lib/money.js";
import type { GatewayReconciliation, Order, ShopifyFeeDetail } from "../types.js";
import { buildReconciliation } from "./reconcile.js";

/**
 * Step 5 — Shopify Payments fees, using each order's ACTUAL fee.
 *
 * The Payment Transactions export has an `Order` column with per-transaction
 * `Fee` and `GST`, and spans a wider period than the report window, so we sum
 * Fee/GST per order id and keep only orders present in the (already
 * date/order-range filtered) Shopify Net Payments. Fee ex-GST = Fee − GST.
 */
export function processShopifyFees(
  transactionsBuf: Buffer,
  shopifyOrders: Order[],
): { details: ShopifyFeeDetail[]; reconciliation: GatewayReconciliation } {
  const { rows } = parseCsv(transactionsBuf);
  const orderIds = new Set(shopifyOrders.map((o) => o.orderId));

  const feeByOrder = new Map<string, { feeCents: number; gstCents: number }>();
  for (const row of rows) {
    const orderId = pick(row, ["order", "ordername", "orderid", "name"]).trim();
    if (!orderId || !orderIds.has(orderId)) continue;

    const feeCents = toCents(parseAmount(pick(row, ["fee", "fees"])));
    const gstCents = toCents(parseAmount(pick(row, ["gst", "tax"])));
    if (feeCents === 0 && gstCents === 0) continue;

    const agg = feeByOrder.get(orderId) ?? { feeCents: 0, gstCents: 0 };
    agg.feeCents += feeCents;
    agg.gstCents += gstCents;
    feeByOrder.set(orderId, agg);
  }

  const daily = new Map<string, number>(); // date -> incl fee cents
  const details: ShopifyFeeDetail[] = shopifyOrders.map((o) => {
    const agg = feeByOrder.get(o.orderId) ?? { feeCents: 0, gstCents: 0 };
    const feeIncl = agg.feeCents;
    const gst = agg.gstCents;
    const date = o.date ?? "";
    daily.set(date, (daily.get(date) ?? 0) + feeIncl);
    return {
      Date: date,
      OrderID: o.orderId,
      GrossAmountAUD: fromCents(o.grossCents),
      FeeExGST: fromCents(feeIncl - gst),
      GSTOnFee: fromCents(gst),
      FeeInclGST: fromCents(feeIncl),
      NetAmountAUD: fromCents(o.grossCents - feeIncl),
    };
  });

  // Actual per-order fees, so source == allocated by construction.
  const reconciliation = buildReconciliation("Shopify Payments", daily, daily);
  return { details, reconciliation };
}
