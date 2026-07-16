import { hasColumn, parseCsv } from "../lib/csv.js";
import {
  FIELD_KEYS,
  FILE_NAMES,
  type FieldKey,
  type FileBuffers,
  type ValidationError,
} from "../types.js";

/** Required column groups per file — each group must match at least one header. */
const COLUMN_REQUIREMENTS: Record<FieldKey, { name: string; aliases: string[] }[]> = {
  "shopify-net-payments": [
    { name: "Day / Date", aliases: ["day", "date"] },
    { name: "Order name", aliases: ["ordername", "order", "orderid", "name"] },
    { name: "Payment gateway", aliases: ["paymentgateway", "gateway"] },
    { name: "Gross payments", aliases: ["grosspayments", "grosspayment", "gross"] },
  ],
  "shopify-total-sales": [
    { name: "Order name", aliases: ["ordername", "order", "orderid", "name"] },
  ],
  "shopify-payment-transactions": [
    { name: "Date", aliases: ["transactiondate", "date", "day", "payoutdate", "createdat"] },
    { name: "Fee", aliases: ["fee", "fees"] },
  ],
  "paypal-activity": [
    { name: "Date", aliases: ["date"] },
    { name: "Gross", aliases: ["gross"] },
    { name: "Fee", aliases: ["fee"] },
    { name: "Currency", aliases: ["currency"] },
  ],
  "afterpay-settlement": [
    {
      name: "Settlement Date",
      aliases: ["isosettlementdate", "settlementdate", "date", "paymentdate"],
    },
    {
      name: "Merchant Fee",
      aliases: [
        "merchantfeeincltax", "merchantfeeinclgst",
        "merchantfeeexcltax", "merchantfeeexclgst",
        "merchantfee", "fee",
      ],
    },
  ],
};

/**
 * Step 1 — Validate uploaded files: presence, CSV format, required columns.
 * Returns a ValidationError to stop the pipeline, or null when everything is valid.
 */
export function validate(files: FileBuffers): ValidationError | null {
  const missingFiles: string[] = [];
  const columnErrors: { file: string; missing: string[] }[] = [];

  for (const key of FIELD_KEYS) {
    const buf = files[key];
    if (!buf || buf.length === 0) {
      missingFiles.push(FILE_NAMES[key]);
      continue;
    }

    const { headers, rows } = parseCsv(buf);
    if (headers.length === 0 || rows.length === 0) {
      columnErrors.push({ file: FILE_NAMES[key], missing: ["Valid CSV rows"] });
      continue;
    }

    const missing = COLUMN_REQUIREMENTS[key]
      .filter((req) => !hasColumn(headers, req.aliases))
      .map((req) => req.name);
    if (missing.length > 0) columnErrors.push({ file: FILE_NAMES[key], missing });
  }

  if (missingFiles.length === 0 && columnErrors.length === 0) return null;

  let message: string;
  if (missingFiles.length > 0) {
    message =
      `Missing file:\n${missingFiles.join("\n")}\n\nPlease upload all 5 required files.`;
  } else {
    const parts = columnErrors.map(
      (e) => `${e.file}: missing ${e.missing.join(", ")}`,
    );
    message = `Invalid file format:\n${parts.join("\n")}`;
  }

  return { ok: false, stage: "validation", message, missingFiles, columnErrors };
}
