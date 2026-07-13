import ExcelJS from "exceljs";
import type {
  AfterpayFeeDetail,
  GeneratedFile,
  PaypalFeeDetail,
  ShopifyFeeDetail,
} from "../types.js";

interface ColumnDef {
  header: string;
  key: string;
  money?: boolean;
}

/** Add a per-order detail worksheet (rows + bold TOTAL row) to a workbook. */
function addDetailSheet<T extends object>(
  wb: ExcelJS.Workbook,
  sheetName: string,
  columns: ColumnDef[],
  rows: T[],
): void {
  const asRecord = (r: T) => r as Record<string, unknown>;
  const ws = wb.addWorksheet(sheetName);

  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: Math.max(c.header.length + 2, 14),
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of rows) ws.addRow(row);

  const totals: Record<string, number> = {};
  for (const c of columns) {
    if (!c.money) continue;
    ws.getColumn(c.key).numFmt = "#,##0.00";
    const cents = rows.reduce(
      (sum, r) => sum + Math.round(Number(asRecord(r)[c.key] ?? 0) * 100),
      0,
    );
    totals[c.key] = cents / 100;
  }
  if (rows.length > 0) {
    const totalRow = ws.addRow({ [columns[0].key]: "TOTAL", ...totals });
    totalRow.font = { bold: true };
  }
}

interface SumCol {
  label: string;
  key: string;
}

/**
 * Append one pivot block to the Output sheet: a gateway title, a header row
 * (Row Labels / Count of OrderID / Sum of …), one row per day, then a bold
 * Grand Total row and a spacer.
 */
function addPivotBlock<T extends object>(
  ws: ExcelJS.Worksheet,
  title: string,
  rows: T[],
  sumCols: SumCol[],
): void {
  const asRecord = (r: T) => r as Record<string, unknown>;

  const titleRow = ws.addRow([title]);
  titleRow.font = { bold: true };

  const header = ws.addRow([
    "Row Labels",
    "Count of OrderID",
    ...sumCols.map((c) => `Sum of ${c.label}`),
  ]);
  header.font = { bold: true };

  const byDate = new Map<string, { count: number; sums: number[] }>();
  for (const r of rows) {
    const rec = asRecord(r);
    const d = (rec.Date as string) || "(blank)";
    let g = byDate.get(d);
    if (!g) {
      g = { count: 0, sums: sumCols.map(() => 0) };
      byDate.set(d, g);
    }
    g.count += 1;
    sumCols.forEach((c, i) => {
      g!.sums[i] += Math.round(Number(rec[c.key] ?? 0) * 100);
    });
  }

  const dates = [...byDate.keys()].sort();
  const totals = sumCols.map(() => 0);
  let totalCount = 0;
  for (const d of dates) {
    const g = byDate.get(d)!;
    ws.addRow([d, g.count, ...g.sums.map((c) => c / 100)]);
    totalCount += g.count;
    g.sums.forEach((s, i) => (totals[i] += s));
  }

  const gt = ws.addRow(["Grand Total", totalCount, ...totals.map((c) => c / 100)]);
  gt.font = { bold: true };
  ws.addRow([]);
}

/** Build the "Output" pivot sheet: Afterpay, then PayPal, then Shopify. */
function addOutputSheet(
  wb: ExcelJS.Workbook,
  shopify: ShopifyFeeDetail[],
  afterpay: AfterpayFeeDetail[],
  paypal: PaypalFeeDetail[],
): void {
  const ws = wb.addWorksheet("Output");

  addPivotBlock(ws, "Afterpay", afterpay, [
    { label: "GrossAmountAUD", key: "GrossAmountAUD" },
    { label: "MerchantFeeExclGST", key: "MerchantFeeExclGST" },
    { label: "MerchantFeeGST", key: "MerchantFeeGST" },
    { label: "MerchantFeeInclGST", key: "MerchantFeeInclGST" },
    { label: "NetAmountAUD", key: "NetAmountAUD" },
  ]);
  addPivotBlock(ws, "Paypal", paypal, [
    { label: "GrossOriginalCurrency", key: "GrossOriginalCurrency" },
    { label: "GrossAmountAUD", key: "GrossAmountAUD" },
    { label: "FeeAmountAUD", key: "FeeAmountAUD" },
    { label: "NetAmountAUD", key: "NetAmountAUD" },
  ]);
  addPivotBlock(ws, "Shopify", shopify, [
    { label: "GrossAmountAUD", key: "GrossAmountAUD" },
    { label: "FeeExGST", key: "FeeExGST" },
    { label: "GSTOnFee", key: "GSTOnFee" },
    { label: "FeeInclGST", key: "FeeInclGST" },
    { label: "NetAmountAUD", key: "NetAmountAUD" },
  ]);

  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 16;
  ws.getColumn(2).numFmt = "#,##0";
  for (let c = 3; c <= 7; c++) {
    ws.getColumn(c).width = 22;
    ws.getColumn(c).numFmt = "#,##0.00";
  }
}

const SHOPIFY_COLUMNS: ColumnDef[] = [
  { header: "Date", key: "Date" },
  { header: "OrderID", key: "OrderID" },
  { header: "GrossAmountAUD", key: "GrossAmountAUD", money: true },
  { header: "FeeExGST", key: "FeeExGST", money: true },
  { header: "GSTOnFee", key: "GSTOnFee", money: true },
  { header: "FeeInclGST", key: "FeeInclGST", money: true },
  { header: "NetAmountAUD", key: "NetAmountAUD", money: true },
];

const AFTERPAY_COLUMNS: ColumnDef[] = [
  { header: "Date", key: "Date" },
  { header: "OrderID", key: "OrderID" },
  { header: "GrossAmountAUD", key: "GrossAmountAUD", money: true },
  { header: "MerchantFeeExclGST", key: "MerchantFeeExclGST", money: true },
  { header: "MerchantFeeGST", key: "MerchantFeeGST", money: true },
  { header: "MerchantFeeInclGST", key: "MerchantFeeInclGST", money: true },
  { header: "NetAmountAUD", key: "NetAmountAUD", money: true },
];

const PAYPAL_COLUMNS: ColumnDef[] = [
  { header: "Date", key: "Date" },
  { header: "OrderID", key: "OrderID" },
  { header: "OriginalCurrency", key: "OriginalCurrency" },
  { header: "GrossOriginalCurrency", key: "GrossOriginalCurrency", money: true },
  { header: "GrossAmountAUD", key: "GrossAmountAUD", money: true },
  { header: "FeeAmountAUD", key: "FeeAmountAUD", money: true },
  { header: "NetAmountAUD", key: "NetAmountAUD", money: true },
  { header: "Type", key: "Type" },
];

/**
 * Step 8 — Generate the single merchant Excel file (in memory, never written to
 * disk): a pivot-style "Output" summary followed by the Afterpay, PayPal and
 * Shopify per-order detail sheets.
 */
export async function generateMerchantWorkbook(
  monthLabel: string,
  shopify: ShopifyFeeDetail[],
  afterpay: AfterpayFeeDetail[],
  paypal: PaypalFeeDetail[],
): Promise<GeneratedFile> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Saint Merchant";

  addOutputSheet(wb, shopify, afterpay, paypal);
  addDetailSheet(wb, "Afterpay", AFTERPAY_COLUMNS, afterpay);
  addDetailSheet(wb, "PayPal", PAYPAL_COLUMNS, paypal);
  addDetailSheet(wb, "Shopify", SHOPIFY_COLUMNS, shopify);

  const buffer = await wb.xlsx.writeBuffer();
  return {
    name: `Merchant_fees_${monthLabel}.xlsx`,
    base64: Buffer.from(buffer).toString("base64"),
  };
}
