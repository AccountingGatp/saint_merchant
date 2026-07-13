import { fromCents, toCents } from "../lib/money.js";
import { monthLabel } from "../lib/date.js";
import type {
  FileBuffers,
  PipelineResult,
  ProcessParams,
  ValidationError,
} from "../types.js";
import { validate } from "./validate.js";
import { buildOrders } from "./orders.js";
import { processShopifyFees } from "./shopifyFees.js";
import { processAfterpayFees } from "./afterpayFees.js";
import { processPaypalFees } from "./paypalFees.js";
import { generateMerchantWorkbook } from "./excel.js";

/** Most common order month, used for output filenames (e.g. "Nov2025"). */
function dominantMonth(dates: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) {
    if (!d) continue;
    const ym = d.slice(0, 7);
    counts.set(ym, (counts.get(ym) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [ym, c] of counts) {
    if (c > bestCount) {
      best = ym;
      bestCount = c;
    }
  }
  return monthLabel(best ? `${best}-01` : null);
}

const sumField = <T extends object>(rows: T[], key: string): number =>
  fromCents(
    rows.reduce(
      (acc, r) => acc + toCents(Number((r as Record<string, unknown>)[key] ?? 0)),
      0,
    ),
  );

/**
 * Runs the full processing pipeline over in-memory file buffers, honouring the
 * optional date-range / order-range filters. Returns a ValidationError (Step 1)
 * or the final result with three fee-detail workbooks.
 */
export async function runPipeline(
  files: FileBuffers,
  params: ProcessParams,
): Promise<PipelineResult | ValidationError> {
  // Step 1 — Validate.
  const validationError = validate(files);
  if (validationError) return validationError;

  // Steps 2-4 — Normalize, build master orders, filter, split by gateway.
  const { orders, split } = buildOrders(files["shopify-net-payments"]!, params);

  // Steps 5-7 — Process fees per gateway.
  const shopify = processShopifyFees(
    files["shopify-payment-transactions"]!,
    split.shopifyOrders,
  );
  const afterpay = processAfterpayFees(
    files["afterpay-settlement"]!,
    split.afterpayOrders,
    params,
  );
  const paypal = await processPaypalFees(
    files["paypal-activity"]!,
    split.paypalOrders,
    params,
  );

  // Step 8 — Generate the single merchant workbook (in memory, 4 sheets:
  // Output pivot + Afterpay / PayPal / Shopify detail).
  const label = dominantMonth(orders.map((o) => o.date));
  const file = await generateMerchantWorkbook(
    label,
    shopify.details,
    afterpay.details,
    paypal.details,
  );

  // Step 9 — Reconcile.
  const reconciliation = [
    shopify.reconciliation,
    afterpay.reconciliation,
    paypal.reconciliation,
  ];
  const reconciled = reconciliation.every((r) => r.reconciled);
  const adjustments = [...afterpay.adjustments, ...paypal.adjustments];

  // Step 10 — Return result.
  return {
    ok: true,
    monthLabel: label,
    params,
    summary: {
      shopifyFees: sumField(shopify.details, "FeeInclGST"),
      afterpayFees: sumField(afterpay.details, "MerchantFeeInclGST"),
      paypalFees: sumField(paypal.details, "FeeAmountAUD"),
      orderCounts: {
        shopify: split.shopifyOrders.length,
        paypal: split.paypalOrders.length,
        afterpay: split.afterpayOrders.length,
      },
    },
    reconciliation,
    reconciled,
    adjustments,
    fxWarnings:
      paypal.fxFailedCurrencies.length > 0 ? paypal.fxFailedCurrencies : undefined,
    file,
  };
}
