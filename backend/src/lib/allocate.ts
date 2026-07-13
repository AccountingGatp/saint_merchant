/**
 * Pro-rata fee allocation with exact (largest-remainder) rounding.
 *
 * A daily fee total (in cents, per component) is split across that day's orders
 * proportional to each order's weight. Remainders are placed deterministically
 * so the allocated parts sum EXACTLY to the day's total — these placements are
 * reported as `adjustments` (the "1–2 cent rounding fix on a single row").
 *
 * Fees for a day that has no matching orders are left unallocated and reported
 * in `unallocated` (rather than smeared onto unrelated days), so per-day
 * reconciliation stays exact.
 */

export interface AllocOrder {
  orderId: string;
  dayKey: string;
  /** allocation weight in cents (e.g. gross − refunds) */
  weightCents: number;
}

export interface Adjustment {
  date: string;
  orderId: string;
  cents: number;
}

export interface AllocResult {
  /** orderId -> component -> allocated cents */
  perOrder: Map<string, Record<string, number>>;
  adjustments: Adjustment[];
  unallocated: { date: string; components: Record<string, number> }[];
}

function largestRemainder(
  totalCents: number,
  weights: number[],
): { parts: number[]; remainderIdx: number[] } {
  const n = weights.length;
  if (n === 0) return { parts: [], remainderIdx: [] };
  const sign = totalCents < 0 ? -1 : 1;
  const total = Math.abs(Math.round(totalCents));

  const positive = weights.map((w) => Math.max(0, w));
  let sumW = positive.reduce((a, b) => a + b, 0);
  const w = sumW > 0 ? positive : weights.map(() => 1);
  sumW = w.reduce((a, b) => a + b, 0);

  const raw = w.map((x) => (total * x) / sumW);
  const floors = raw.map((r) => Math.floor(r));
  const rem = total - floors.reduce((a, b) => a + b, 0);

  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const remainderIdx: number[] = [];
  for (let k = 0; k < rem; k++) {
    const idx = order[k % n].i;
    floors[idx] += 1;
    remainderIdx.push(idx);
  }
  return { parts: floors.map((c) => c * sign), remainderIdx };
}

export function allocateDaily(
  orders: AllocOrder[],
  dailyTotals: Map<string, Record<string, number>>,
  components: string[],
): AllocResult {
  const perOrder = new Map<string, Record<string, number>>();
  for (const o of orders) {
    perOrder.set(o.orderId, Object.fromEntries(components.map((c) => [c, 0])));
  }

  const byDay = new Map<string, AllocOrder[]>();
  for (const o of orders) {
    const list = byDay.get(o.dayKey);
    if (list) list.push(o);
    else byDay.set(o.dayKey, [o]);
  }

  const adjustments: Adjustment[] = [];
  const unallocated: { date: string; components: Record<string, number> }[] = [];

  // Track adjustments against the last component (treated as the primary total).
  const primary = components[components.length - 1];

  const apply = (dayOrders: AllocOrder[], comps: Record<string, number>, day: string) => {
    const weights = dayOrders.map((o) => o.weightCents);
    for (const comp of components) {
      const { parts, remainderIdx } = largestRemainder(comps[comp] ?? 0, weights);
      dayOrders.forEach((o, i) => {
        perOrder.get(o.orderId)![comp] += parts[i];
      });
      if (comp === primary) {
        for (const i of remainderIdx) {
          adjustments.push({
            date: day,
            orderId: dayOrders[i].orderId,
            cents: (comps[comp] ?? 0) < 0 ? -1 : 1,
          });
        }
      }
    }
  };

  for (const [day, comps] of dailyTotals) {
    const dayOrders = byDay.get(day);
    if (!dayOrders || dayOrders.length === 0) {
      unallocated.push({ date: day, components: comps });
      continue;
    }
    apply(dayOrders, comps, day);
  }

  return { perOrder, adjustments, unallocated };
}
