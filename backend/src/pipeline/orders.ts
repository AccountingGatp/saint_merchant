import { parseCsv, pick, type Row } from "../lib/csv.js";
import { parseDate } from "../lib/date.js";
import { parseAmount, toCents } from "../lib/money.js";
import type { GatewaySplit, Order, ProcessParams } from "../types.js";

/** Extract the numeric part of a Shopify order name ("#10053" -> 10053). */
export function orderNumber(name: string): number | null {
  const m = String(name).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function normalizeNetPayment(row: Row): Order | null {
  const orderId = pick(row, ["ordername", "order", "orderid", "name"]).trim();
  if (!orderId) return null;

  const grossAmount = parseAmount(pick(row, ["grosspayments", "grosspayment", "gross"]));
  const refund = parseAmount(
    pick(row, ["refundedpayments", "refundedpayment", "refund", "refunds"]),
  );
  const netPayment = grossAmount + refund; // refunds are already negative in the export

  return {
    orderId,
    orderNumber: orderNumber(orderId),
    date: parseDate(pick(row, ["day", "date"])),
    gateway: pick(row, ["paymentgateway", "gateway"]).trim(),
    grossAmount,
    refund,
    netPayment,
    grossCents: toCents(grossAmount),
    netCents: toCents(netPayment),
  };
}

function inDateRange(order: Order, params: ProcessParams): boolean {
  if (!order.date) return !params.dateStart && !params.dateEnd;
  if (params.dateStart && order.date < params.dateStart) return false;
  if (params.dateEnd && order.date > params.dateEnd) return false;
  return true;
}

function inOrderRange(order: Order, params: ProcessParams): boolean {
  const lo = params.orderStart ? orderNumber(params.orderStart) : null;
  const hi = params.orderEnd ? orderNumber(params.orderEnd) : null;
  if (lo == null && hi == null) return true;
  if (order.orderNumber == null) return false;
  if (lo != null && order.orderNumber < lo) return false;
  if (hi != null && order.orderNumber > hi) return false;
  return true;
}

/**
 * Steps 3 & 4 — Build the master order dataset from Shopify Net Payments (the
 * source of truth for which orders exist and which gateway processed them),
 * apply the date-range / order-range filters, then split by gateway.
 */
export function buildOrders(
  netPaymentsBuf: Buffer,
  params: ProcessParams,
): { orders: Order[]; split: GatewaySplit } {
  const { rows } = parseCsv(netPaymentsBuf);

  // Aggregate multiple Net-Payments rows for the same Order name into one order
  // (an order can have several rows, e.g. capture + adjustment) so its fee is
  // never double-counted downstream.
  const byOrder = new Map<string, Order>();
  for (const row of rows) {
    const order = normalizeNetPayment(row);
    if (!order) continue;
    const existing = byOrder.get(order.orderId);
    if (!existing) {
      byOrder.set(order.orderId, order);
    } else {
      existing.grossAmount += order.grossAmount;
      existing.refund += order.refund;
      existing.netPayment += order.netPayment;
      existing.grossCents += order.grossCents;
      existing.netCents += order.netCents;
      if (!existing.gateway && order.gateway) existing.gateway = order.gateway;
      if (!existing.date && order.date) existing.date = order.date;
    }
  }

  const orders: Order[] = [];
  for (const order of byOrder.values()) {
    if (!inDateRange(order, params)) continue;
    if (!inOrderRange(order, params)) continue;
    orders.push(order);
  }

  const has = (o: Order, needle: string) =>
    o.gateway.toLowerCase().replace(/[^a-z]/g, "").includes(needle);

  const split: GatewaySplit = {
    shopifyOrders: orders.filter((o) => has(o, "shopify")),
    paypalOrders: orders.filter((o) => has(o, "paypal")),
    afterpayOrders: orders.filter((o) => has(o, "afterpay")),
  };

  return { orders, split };
}
