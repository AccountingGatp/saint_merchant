# Saint Merchant — Backend

In-memory processing pipeline that reconciles merchant fees across **Shopify
Payments, PayPal, and Afterpay** from 5 uploaded CSV reports and generates a
single 4-sheet Excel workbook (Combined Summary + per-gateway fee sheets).

> **No storage, anywhere.** Uploaded files are held only as in-memory buffers
> (`multer.memoryStorage`), processed, and discarded when the request ends.
> Generated `.xlsx` files are returned as base64 in the JSON response — nothing
> is written to disk.

## Run

```bash
npm install
npm start        # http://localhost:4000  (PORT env var to override)
npm run typecheck
```

## Uploads

`POST /api/process` accepts **either**:

1. **Multipart** — the 5 CSV fields by key (`shopify-net-payments`,
   `shopify-total-sales`, `shopify-payment-transactions`, `paypal-activity`,
   `afterpay-settlement`). Simple; used locally / for small files.
2. **JSON** `{ "files": { "<key>": "<url>" } }` — file **URLs**. The browser
   uploads the CSVs to object storage (**Backblaze B2**) and sends only the URLs;
   the server fetches each URL server-side and processes. This keeps the request
   tiny, so hosts with a request-body cap (e.g. Vercel's 4.5 MB) don't 413 on the
   ~14 MB transactions file.

### Direct-to-B2 upload flow (mode 2)

Backblaze B2 is S3-compatible; the server uses the AWS S3 SDK to mint short-lived
presigned URLs so the file bodies never pass through the (capped) function:

1. `POST /api/uploads` with `{ "keys": ["shopify-net-payments", …] }` →
   `{ "ok": true, "uploads": { "<key>": { "uploadUrl": "<presigned PUT>", "fileUrl": "<presigned GET>" } } }`.
2. The browser `PUT`s each CSV straight to its `uploadUrl` (`Content-Type: text/csv`).
3. The browser calls `POST /api/process` with `{ "files": { "<key>": "<fileUrl>" } }`.
   The server fetches each object, processes, and **deletes the input objects**
   from B2 afterward (nothing is retained).

**Required env vars** (set locally in `backend/.env`, and in the Vercel project):

```
B2_ENDPOINT=https://s3.<region>.backblazeb2.com
B2_REGION=<region>            # e.g. us-east-005
B2_BUCKET=<bucket-name>
B2_KEY_ID=<application-key-id>
B2_APP_KEY=<application-key>
B2_URL_EXPIRY=600             # presigned-URL lifetime, seconds (optional)
```

`GET /health` reports `"b2": true` once these are set. **The bucket must have a
CORS rule** allowing `PUT`/`GET` from the frontend origin with the `content-type`
header — otherwise the browser's direct upload is blocked by CORS (server-side
`curl` is unaffected, so test in the actual browser).

Optional `dateStart`/`dateEnd`/`orderStart`/`orderEnd` may accompany either mode.
The response returns the workbook as `file.base64`.

> On Vercel serverless, note the function **duration** limit (10 s Hobby / 60 s
> Pro): the 14 MB parse + FX calls run ~5–8 s. If you hit a timeout, use Pro
> (`vercel.json` `functions.maxDuration: 60`) or host the Express app on a
> persistent platform (Render/Railway/Fly).

## API

### `POST /api/process` — `multipart/form-data`

Send the 5 files under these field names:

| Field name                      | Report                              |
| ------------------------------- | ----------------------------------- |
| `shopify-net-payments`          | Shopify Net Payments by Order.csv   |
| `shopify-total-sales`           | Shopify Total Sales by Order.csv    |
| `shopify-payment-transactions`  | Shopify Payment Transactions.csv    |
| `paypal-activity`               | PayPal Activity Report.csv          |
| `afterpay-settlement`           | Afterpay Settlement Report.csv      |

**Validation failure (`400`)** — matches the spec message format:

```json
{
  "ok": false,
  "stage": "validation",
  "message": "Missing file:\nShopify Payment Transactions.csv\n\nPlease upload all 5 required files.",
  "missingFiles": ["Shopify Payment Transactions.csv"],
  "columnErrors": []
}
```

**Success (`200`)** — returns a **single merchant workbook** with four sheets
(`Output`, `Shopify`, `Afterpay`, `PayPal`), each order-level:

```json
{
  "ok": true,
  "monthLabel": "Jun2026",
  "summary": {
    "shopifyFees": 15660.20,
    "afterpayFees": 200.04,
    "paypalFees": 3129.58,
    "orderCounts": { "shopify": 4962, "paypal": 835, "afterpay": 258 }
  },
  "reconciliation": [
    { "gateway": "Shopify Payments", "reconciled": true, "sourceTotal": 15660.20, "allocatedTotal": 15660.20, "difference": 0, "dailyMismatches": [], "unallocated": [] }
  ],
  "reconciled": true,
  "adjustments": [ { "gateway": "PayPal", "date": "2026-06-24", "orderId": "#158152", "cents": 1 } ],
  "file": { "name": "Merchant_fees_Jun2026.xlsx", "base64": "UEsDB…" }
}
```

Decode `file.base64` to bytes and save as the `.xlsx`. Sheets:
- **Combined Summary** — stacked date-wise pivot blocks (Afterpay, PayPal,
  Shopify Payments), each with per-day rows and a Grand Total.
- **Shopify Fees / Afterpay Fees / PayPal Fees** — the per-gateway order-level
  fee sheets.

The backend also accepts optional `dateStart`/`dateEnd` (ISO `yyyy-mm-dd`,
inclusive) and `orderStart`/`orderEnd` (Shopify order names, e.g. `#10053`) to
filter by date/order range. The UI sends `dateStart`/`dateEnd` from its
date-range selector; a range scopes both the orders **and** each gateway's daily
fee pool (only order-days in range are sourced).

### `GET /health`

`{ "ok": true, "service": "saint-merchant-backend", "b2": true }`

## Pipeline (`src/pipeline/`)

The reconciliation is a port of the standalone `merchant_fees.xlsx` generator,
living in `combine.ts` (self-contained: CSV parse, pro-rata allocator, and a
dependency-free XLSX writer). `index.ts` validates, calls `combine`, and maps
the result into the JSON response.

| Step | Where | What it does |
| ---- | ---- | ------------ |
| 1 — Validate | `validate.ts` (+ `lib/csv.ts`) | File presence, CSV format, required columns |
| 2 — Orders | `combine.ts` | Build `orders[]` from Net Payments (source of truth), apply **date/order-range filters**, key each order by day + gateway |
| 3 — Daily fee pools | `combine.ts` | Per gateway/day, total the fee from that gateway's own source report (AUD) |
| 4 — Allocate | `combine.ts` | Distribute each day's pool across that day's orders pro-rata by net payment (gross−refund), forced to tie per day |
| 5 — Workbook | `combine.ts` | Build the 4-sheet workbook (Combined Summary + 3 gateway sheets) in memory |
| 6 — Reconcile + result | `combine.ts` / `index.ts` | Per-gateway allocated-vs-source totals, unallocated days, ±1¢ adjustments, summary |

### How each gateway's fees are sourced

All three gateways use the **same daily-pool + pro-rata** method: Net Payments
defines which orders exist (their Order name, day, and gateway); each gateway's
own report gives the day's total fee, which is allocated across that day's orders.

- **Shopify Payments** — daily pool from Payment Transactions (`charge` / `refund`
  / `chargeback` rows), summing `Fee`/`GST` at face value (already AUD, no FX).
- **Afterpay** — daily pool from the settlement report's `Merchant Fee excl Tax`
  / `Merchant Fee Tax`, keyed by `ISO Settlement Date`. (The Afterpay Merchant
  Order ID is a token that never matches Shopify order names, hence allocation.)
- **PayPal** — daily pool from sales + refunds + withdrawal fees, converted to
  AUD using **PayPal's own settlement rate** derived from the report's
  "General Currency Conversion" pairs (foreign-out / AUD-in). Any remaining
  foreign fees are converted at the **RBA historical rate for that transaction
  date** (`lib/fx.ts`, RBA table F11.1 daily CSV — free, no key). Only currencies
  the RBA doesn't publish are excluded and surfaced in `fxWarnings`. PayPal fees
  are GST-exempt (all in the ex-GST bucket).

### Rounding / reconciliation

Money is rounded to cents (`round2`). The pro-rata allocator forces each day's
rounded fees to sum EXACTLY to the source day total by pushing the ±1-2¢ residual
onto the largest-magnitude order; those placements are reported in `adjustments`
(gateway/date/orderId/cents). Source fee days with no matching in-range order are
reported per gateway in `reconciliation[].unallocated` — this is how a
**file-period mismatch** surfaces (e.g. an Afterpay settlement whose settlement
dates fall outside the selected window).

### FX note

FX is fully dynamic — nothing is hard-coded, so the pipeline is correct for any
period. PayPal's own per-transaction settlement rate (from the report's
conversion rows) is preferred; anything else is converted at the **RBA** rate for
that transaction date (table F11.1, `A$1=XXX` columns = foreign per AUD). The
daily CSV is fetched once and parsed in memory, with nearest-prior-business-day
fallback for weekends/holidays. If the RBA service is unreachable, a currency is
not published, or the date predates the file's coverage (starts 2023-01-03),
those fees are excluded from AUD and listed in `fxWarnings`.

> Requires outbound network access from the server to `www.rba.gov.au`. On Vercel
> this works by default; the CSV is fetched at most once per warm function
> instance.

### Column matching

`validate.ts` matches headers by normalized aliases; `combine.ts` reads the exact
report headers (e.g. `Net payments`, `Transaction Date`, `ISO Settlement Date`).
