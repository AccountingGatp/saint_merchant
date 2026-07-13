export type FieldKey =
  | "shopify-net-payments"
  | "shopify-total-sales"
  | "shopify-payment-transactions"
  | "paypal-activity"
  | "afterpay-settlement";

export const FIELD_KEYS: FieldKey[] = [
  "shopify-net-payments",
  "shopify-total-sales",
  "shopify-payment-transactions",
  "paypal-activity",
  "afterpay-settlement",
];

/** Human display names used in validation messages (Step 1). */
export const FILE_NAMES: Record<FieldKey, string> = {
  "shopify-net-payments": "Shopify Net Payments by Order.csv",
  "shopify-total-sales": "Shopify Total Sales by Order.csv",
  "shopify-payment-transactions": "Shopify Payment Transactions.csv",
  "paypal-activity": "PayPal Activity Report.csv",
  "afterpay-settlement": "Afterpay Settlement Report.csv",
};

/** Uploaded file buffers, held in memory only. */
export type FileBuffers = Partial<Record<FieldKey, Buffer>>;

/** Optional date-range / order-range filters supplied with the request. */
export interface ProcessParams {
  dateStart: string | null; // ISO yyyy-mm-dd (inclusive)
  dateEnd: string | null; // ISO yyyy-mm-dd (inclusive)
  orderStart: string | null; // Shopify order name, e.g. "#10053"
  orderEnd: string | null; // Shopify order name, e.g. "#10342"
}

export interface Order {
  orderId: string; // Shopify Order name, e.g. "#10053"
  orderNumber: number | null;
  date: string | null; // order day (ISO)
  gateway: string;
  grossAmount: number;
  refund: number;
  netPayment: number; // gross − refund
  grossCents: number;
  netCents: number;
}

export interface GatewaySplit {
  shopifyOrders: Order[];
  paypalOrders: Order[];
  afterpayOrders: Order[];
}

export interface ShopifyFeeDetail {
  Date: string;
  OrderID: string;
  GrossAmountAUD: number;
  FeeExGST: number;
  GSTOnFee: number;
  FeeInclGST: number;
  NetAmountAUD: number;
}

export interface AfterpayFeeDetail {
  Date: string;
  OrderID: string;
  GrossAmountAUD: number;
  MerchantFeeExclGST: number;
  MerchantFeeGST: number;
  MerchantFeeInclGST: number;
  NetAmountAUD: number;
}

/** PayPal detail — order-level, all AUD (fees are GST-exempt). */
export interface PaypalFeeDetail {
  Date: string;
  OrderID: string;
  OriginalCurrency: string;
  GrossOriginalCurrency: number;
  GrossAmountAUD: number;
  FeeAmountAUD: number;
  NetAmountAUD: number;
  Type: string;
}

export interface RoundingAdjustment {
  gateway: string;
  date: string;
  orderId: string;
  cents: number;
}

export interface GatewayReconciliation {
  gateway: string;
  reconciled: boolean;
  sourceTotal: number;
  allocatedTotal: number;
  difference: number;
  /** Per-day rows where allocated fees could not match the source total. */
  dailyMismatches: { date: string; expected: number; allocated: number }[];
  /** Source fee days that had no matching orders (spread into the pool instead). */
  unallocated: { date: string; amount: number }[];
}

export interface ValidationError {
  ok: false;
  stage: "validation";
  message: string;
  missingFiles: string[];
  columnErrors: { file: string; missing: string[] }[];
}

export interface GeneratedFile {
  name: string;
  base64: string;
}

export interface PipelineResult {
  ok: true;
  monthLabel: string;
  params: ProcessParams;
  summary: {
    shopifyFees: number;
    afterpayFees: number;
    paypalFees: number; // AUD
    orderCounts: { shopify: number; paypal: number; afterpay: number };
  };
  reconciliation: GatewayReconciliation[];
  reconciled: boolean;
  adjustments: RoundingAdjustment[];
  /** Currencies whose FX rate could not be fetched (AUD amounts affected). */
  fxWarnings?: string[];
  /** Single merchant workbook with Output / Shopify / Afterpay / PayPal sheets. */
  file: GeneratedFile;
}
