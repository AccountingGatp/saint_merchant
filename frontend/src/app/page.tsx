"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  FileUploadCard,
  type UploadSlot,
} from "@/components/file-upload-card";

const BACKEND_URL =
  // process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
  "https://saint-merchant-api.vercel.app";

type GatewayRecon = {
  gateway: string;
  reconciled: boolean;
  sourceTotal: number;
  allocatedTotal: number;
  difference: number;
  dailyMismatches: { date: string; expected: number; allocated: number }[];
  unallocated: { date: string; amount: number }[];
};

type GeneratedFile = { name: string; base64?: string; url?: string };

type ProcessResult = {
  ok: true;
  monthLabel: string;
  summary: {
    shopifyFees: number;
    afterpayFees: number;
    paypalFees: number;
    orderCounts: { shopify: number; paypal: number; afterpay: number };
  };
  reconciliation: GatewayRecon[];
  reconciled: boolean;
  adjustments: { gateway: string; date: string; orderId: string; cents: number }[];
  fxWarnings?: string[];
  file: GeneratedFile;
};

const money = (n: number, currency = "AUD") =>
  n.toLocaleString(undefined, { style: "currency", currency });

/** Decode a base64 xlsx and trigger a browser download. Nothing is stored. */
function downloadBase64(name: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Download the result file, from a Blob URL (prod) or inline base64 (local). */
function triggerDownload(file: GeneratedFile) {
  if (file.url) {
    const a = document.createElement("a");
    a.href = file.url;
    a.download = file.name;
    a.click();
  } else if (file.base64) {
    downloadBase64(file.name, file.base64);
  }
}

const SLOTS: UploadSlot[] = [
  {
    id: "shopify-net-payments",
    index: 1,
    label: "Shopify – Net Payments by Order",
    purpose:
      "Main source of orders, Order ID, payment gateway, gross payment",
    expected: "Shopify – Net Payments by Order.csv",
  },
  {
    id: "shopify-total-sales",
    index: 2,
    label: "Shopify – Total Sales by Order",
    purpose: "Sales details (used for validation / reference)",
    expected: "Shopify – Total Sales by Order.csv",
  },
  {
    id: "shopify-payment-transactions",
    index: 3,
    label: "Shopify Payment Transactions",
    purpose: "Shopify Payments fees + GST details",
    expected: "Shopify Payment Transactions.csv",
  },
  {
    id: "paypal-activity",
    index: 4,
    label: "PayPal Activity Report",
    purpose: "PayPal sales, refunds, fees, currency conversion",
    expected: "PayPal Activity Report.csv",
  },
  {
    id: "afterpay-settlement",
    index: 5,
    label: "Afterpay Settlement Report",
    purpose: "Afterpay fees, GST, settlements",
    expected: "Afterpay Settlement Report.csv",
  },
];

export default function Home() {
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);

  const uploadedCount = useMemo(
    () => SLOTS.filter((s) => files[s.id]).length,
    [files],
  );
  const allReady = uploadedCount === SLOTS.length;
  const progress = (uploadedCount / SLOTS.length) * 100;

  const setFile = (id: string, file: File | null) =>
    setFiles((prev) => ({ ...prev, [id]: file }));

  const handleSubmit = async () => {
    if (!allReady) {
      toast.error("Please upload all 5 files before continuing.");
      return;
    }

    setSubmitting(true);
    setResult(null);

    try {
      // 1. Ask the backend for presigned Backblaze B2 URLs (one per file).
      const keys = SLOTS.map((s) => s.id);
      const presignRes = await fetch(`${BACKEND_URL}/api/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      });
      const presign: {
        ok?: boolean;
        message?: string;
        uploads?: Record<string, { uploadUrl: string; fileUrl: string }>;
      } = await presignRes.json();

      if (!presignRes.ok || !presign.ok || !presign.uploads) {
        toast.error(presign.message ?? "Could not start the upload.");
        return;
      }
      const uploads = presign.uploads;

      // 2. Upload each CSV straight to B2 (bypasses Vercel's request-body cap).
      await Promise.all(
        SLOTS.map(async (s) => {
          const f = files[s.id];
          const target = uploads[s.id];
          if (!f || !target) throw new Error(`Missing upload target for ${s.label}`);
          const put = await fetch(target.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "text/csv" },
            body: f,
          });
          if (!put.ok) throw new Error(`Upload failed for ${s.label} (HTTP ${put.status})`);
        }),
      );

      // 3. Send only the (tiny) file URLs to the backend for processing.
      const fileUrls: Record<string, string> = {};
      for (const s of SLOTS) fileUrls[s.id] = uploads[s.id].fileUrl;

      const res = await fetch(`${BACKEND_URL}/api/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: fileUrls }),
      });
      const data: ProcessResult & { message?: string } = await res.json();

      if (!data.ok) {
        toast.error(data?.message ?? "Processing failed.");
        return;
      }

      const processed = data as ProcessResult;
      setResult(processed);
      triggerDownload(processed.file);
      if (processed.reconciled) {
        toast.success(`Reconciled. Downloaded ${processed.file.name}`);
      } else {
        toast.warning(
          `Downloaded ${processed.file.name} — some gateways did not fully reconcile.`,
        );
      }
    } catch {
      toast.error(`Upload/processing failed against ${BACKEND_URL}.`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = () => {
    setFiles({});
    setResult(null);
    toast.info("Cleared all selected files.");
  };

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">
          <span className="text-primary">Saint Merchant</span>{" "}
          <span className="text-muted-foreground font-normal">
            · Reconciliation Upload
          </span>
        </h1>
        <p className="text-xs text-muted-foreground">
          5 reports · Shopify, PayPal &amp; Afterpay · CSV only
        </p>
      </header>

      <div className="mb-3 flex items-center gap-3 rounded-md border bg-card px-3 py-2">
        <span className="whitespace-nowrap text-xs font-medium">
          {uploadedCount}/{SLOTS.length} selected
        </span>
        <Progress value={progress} className="h-1.5 flex-1" />
        <span className="whitespace-nowrap text-xs text-muted-foreground">
          {allReady ? "Ready" : "Incomplete"}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {SLOTS.map((slot) => (
          <FileUploadCard
            key={slot.id}
            slot={slot}
            file={files[slot.id] ?? null}
            onFileChange={(f) => setFile(slot.id, f)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClear}
          disabled={submitting || uploadedCount === 0}
        >
          Clear all
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSubmit}
          disabled={!allReady || submitting}
        >
          {submitting ? "Processing…" : "Upload & reconcile"}
        </Button>
      </div>

      {result && (
        <div className="mt-4 rounded-md border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-medium",
                  result.reconciled
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                )}
              >
                {result.reconciled ? "Reconciled" : "Check mismatches"}
              </span>
              <span className="text-xs text-muted-foreground">
                {result.monthLabel}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => triggerDownload(result.file)}
            >
              Download {result.file.name}
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {result.reconciliation.map((r) => {
              const count = r.gateway.startsWith("Shopify")
                ? result.summary.orderCounts.shopify
                : r.gateway.startsWith("After")
                  ? result.summary.orderCounts.afterpay
                  : result.summary.orderCounts.paypal;
              return (
                <div key={r.gateway} className="rounded-md bg-muted/40 px-2 py-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-medium">{r.gateway}</p>
                    <span
                      className={cn(
                        "text-[10px]",
                        r.reconciled
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-600 dark:text-amber-400",
                      )}
                    >
                      {r.reconciled ? "✓ reconciled" : "⚠ check"}
                    </span>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">
                    {money(r.allocatedTotal)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {count} orders
                  </p>
                  {!r.reconciled && r.unallocated.length > 0 && (
                    <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                      {r.unallocated.length} day(s) unallocated (
                      {money(r.unallocated.reduce((a, u) => a + u.amount, 0))})
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {result.adjustments.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {result.adjustments.length} rounding adjustment(s) of ±1¢ applied
              to make daily totals tie (see console/API for the exact rows).
            </p>
          )}

          {result.fxWarnings && result.fxWarnings.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              FX unavailable for: {result.fxWarnings.join(", ")} — those PayPal
              fees were excluded from AUD.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
