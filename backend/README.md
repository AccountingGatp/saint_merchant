# Saint Merchant — Backend

In-memory processing pipeline that reconciles merchant fees across **Shopify
Payments, PayPal, and Afterpay** from 5 uploaded CSV reports and generates 3
Excel fee-detail files.

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

Decode `file.base64` to bytes and save as the `.xlsx`.
- **Output** — every order across all gateways in one AUD table + TOTAL row.
- **Shopify / Afterpay / PayPal** — the per-gateway order-level fee sheets.

(The backend also accepts optional `dateStart`/`dateEnd`/`orderStart`/`orderEnd`
form fields to filter by date/order range; the UI does not send them.)

### `GET /health`

`{ "ok": true, "service": "saint-merchant-backend" }`

## Pipeline (`src/pipeline/`)

| Step | File | What it does |
| ---- | ---- | ------------ |
| 1 — Validate | `validate.ts` | File presence, CSV format, required columns |
| 2 — Normalize | `orders.ts` (+ `lib/csv.ts`) | CSV → normalized rows |
| 3–4 — Master orders + split | `orders.ts` | Build `orders[]` from Net Payments (source of truth), aggregate duplicate rows, apply **date/order-range filters**, split by gateway (`shopify_payments` / `paypal` / `Afterpay (New)`) |
| 5 — Shopify fees | `shopifyFees.ts` | Each order's ACTUAL `Fee`/`GST` summed per `Order` from Payment Transactions |
| 6 — Afterpay fees | `afterpayFees.ts` (+ `lib/allocate.ts`) | Daily settlement fees allocated to Shopify order names, pro-rata by gross−refund |
| 7 — PayPal fees | `paypalFees.ts` (+ `lib/fx.ts`, `lib/allocate.ts`) | Fees → AUD via historical FX, daily pool allocated to Shopify order names |
| 8 — Excel | `excel.ts` | Build the single 4-sheet merchant workbook in memory |
| 9 — Reconcile | `reconcile.ts` | Per-gateway daily source-vs-allocated; reports mismatches + unallocated days |
| 10 — Result | `index.ts` | Assemble summary, reconciliation, adjustments, files |

### How each gateway's fees are sourced

- **Shopify** — the Payment Transactions export has a per-order `Order` column
  with actual `Fee`/`GST`, so each order's fee is summed directly (no
  allocation) and scoped to the Net-Payments orders in range.
- **Afterpay** — the settlement Merchant Order ID is an Afterpay token that
  never matches Shopify order numbers, so daily settlement fees are **allocated**
  across the Net-Payments Afterpay orders pro-rata by gross−refund, keyed by the
  settlement row's order date. OrderID is the Shopify order name.
- **PayPal** — fees are charged in each transaction's own currency, so every
  fee-bearing row is **converted to AUD** (Frankfurter / ECB daily rates,
  `lib/fx.ts`, nearest-prior-business-day fallback), the daily AUD fee pool is
  **allocated** across the Net-Payments PayPal orders pro-rata by gross−refund.
  PayPal merchant fees are GST-exempt. Order gross is AUD (OriginalCurrency=AUD).

### Rounding / reconciliation

All money math is in **integer cents** (`lib/money.ts`). Pro-rata allocation
uses **largest-remainder** distribution (`lib/allocate.ts`) so each day's
allocated fees sum EXACTLY to the source day total; the ±1¢ remainder placements
are reported in `adjustments` (gateway/date/orderId). Source fee days that have
no matching in-range order are left unallocated and reported per gateway in
`reconciliation[].unallocated` — this is how a **file-period mismatch** surfaces
(e.g. an Afterpay settlement whose settlement dates fall outside the Net-Payments
window).

### Column matching

Headers are matched by normalized aliases (case/spacing/punctuation-insensitive),
so header variations across report exports are tolerated. See the alias lists in
each pipeline module and `validate.ts`.
