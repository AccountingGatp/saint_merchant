import type {
  FileBuffers,
  PipelineResult,
  ProcessParams,
  ValidationError,
} from "../types.js";
import { validate } from "./validate.js";
import { combine } from "./combine.js";

/**
 * Runs the full processing pipeline over in-memory file buffers, honouring the
 * optional date-range / order-range filters. Returns a ValidationError (Step 1)
 * or the final result with the combined merchant workbook.
 *
 * The reconciliation logic lives in `combine.ts` (a port of the standalone
 * `merchant_fees.xlsx` generator): Net payments defines the orders; each
 * gateway's daily fee pool is sourced from its own report (AUD) and allocated
 * pro-rata across that day's orders, forced to tie per day.
 */
export async function runPipeline(
  files: FileBuffers,
  params: ProcessParams,
): Promise<PipelineResult | ValidationError> {
  // Step 1 — Validate.
  const validationError = validate(files);
  if (validationError) return validationError;

  // Steps 2-9 — Build orders, source daily fee pools, allocate, reconcile, and
  // render the 4-sheet workbook.
  const result = await combine(files, params);

  const name = `Merchant_fees_${result.monthLabel}.xlsx`;
  return {
    ok: true,
    monthLabel: result.monthLabel,
    params,
    summary: result.summary,
    reconciliation: result.reconciliation,
    reconciled: result.reconciled,
    adjustments: result.adjustments,
    fxWarnings: result.fxWarnings.length > 0 ? result.fxWarnings : undefined,
    file: { name, base64: result.xlsx.toString("base64") },
  };
}
