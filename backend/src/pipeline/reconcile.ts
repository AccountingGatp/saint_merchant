import { fromCents } from "../lib/money.js";
import type { GatewayReconciliation } from "../types.js";

/**
 * Step 9 — Build a per-gateway reconciliation by comparing the source report's
 * daily fee totals against the allocated (generated) daily totals. Because
 * allocation uses exact largest-remainder rounding, matched days tie to the
 * cent; days whose source fees had no in-range order are surfaced separately.
 */
export function buildReconciliation(
  gateway: string,
  sourceDailyCents: Map<string, number>,
  allocatedDailyCents: Map<string, number>,
  unallocatedCents: { date: string; cents: number }[] = [],
): GatewayReconciliation {
  const days = new Set([
    ...sourceDailyCents.keys(),
    ...allocatedDailyCents.keys(),
  ]);

  const dailyMismatches: { date: string; expected: number; allocated: number }[] = [];
  let sourceTotal = 0;
  let allocatedTotal = 0;

  for (const d of [...days].sort()) {
    const s = sourceDailyCents.get(d) ?? 0;
    const a = allocatedDailyCents.get(d) ?? 0;
    sourceTotal += s;
    allocatedTotal += a;
    if (s !== a) {
      dailyMismatches.push({ date: d, expected: fromCents(s), allocated: fromCents(a) });
    }
  }

  const unallocated = unallocatedCents
    .filter((u) => u.cents !== 0)
    .map((u) => ({ date: u.date, amount: fromCents(u.cents) }));

  const diff = allocatedTotal - sourceTotal;
  return {
    gateway,
    reconciled: dailyMismatches.length === 0 && unallocated.length === 0,
    sourceTotal: fromCents(sourceTotal),
    allocatedTotal: fromCents(allocatedTotal),
    difference: fromCents(diff),
    dailyMismatches,
    unallocated,
  };
}
