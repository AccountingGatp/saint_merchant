import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { runPipeline } from "./pipeline/index.js";
import { FIELD_KEYS, type FieldKey, type FileBuffers, type ProcessParams } from "./types.js";
import { B2_ENABLED, deleteByUrls, newUploadPrefix, presignUpload } from "./lib/b2.js";

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.use(cors());
// URL-mode requests are tiny JSON payloads (a handful of file URLs).
app.use(express.json({ limit: "1mb" }));

/**
 * multer memoryStorage keeps uploaded files as in-memory Buffers. Nothing is
 * ever written to disk. Used for direct multipart uploads (local dev / small
 * files). For large uploads on hosts with request-body caps, the browser
 * uploads to object storage (e.g. Backblaze B2) and sends the URLs instead.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: FIELD_KEYS.length },
});
const uploadFields = upload.fields(FIELD_KEYS.map((name) => ({ name, maxCount: 1 })));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "saint-merchant-backend", b2: B2_ENABLED });
});

/**
 * Presign endpoint. The browser POSTs the file keys it wants to upload and gets
 * back, per key, a presigned PUT URL (upload the CSV straight to Backblaze B2)
 * and a presigned GET URL (which it echoes back in `/api/process`). This keeps
 * the large file bodies off the Vercel function, avoiding the 4.5 MB / HTTP 413
 * request-body cap.
 */
app.post("/api/uploads", async (req, res) => {
  try {
    if (!B2_ENABLED) {
      return res
        .status(503)
        .json({ ok: false, message: "Object storage is not configured on the server." });
    }
    const body = (req.body ?? {}) as { keys?: unknown };
    const requested = Array.isArray(body.keys) ? (body.keys as unknown[]) : FIELD_KEYS;
    const keys = requested.filter(
      (k): k is FieldKey => typeof k === "string" && (FIELD_KEYS as string[]).includes(k),
    );

    const prefix = newUploadPrefix();
    const uploads: Record<string, { uploadUrl: string; fileUrl: string }> = {};
    await Promise.all(
      keys.map(async (key) => {
        const { uploadUrl, fileUrl } = await presignUpload(prefix, key);
        uploads[key] = { uploadUrl, fileUrl };
      }),
    );

    return res.json({ ok: true, uploads });
  } catch (err) {
    console.error("Presign error:", err);
    return res
      .status(500)
      .json({ ok: false, message: err instanceof Error ? err.message : "Presign failed." });
  }
});

/**
 * Resolve the 5 input buffers from either:
 *  - JSON `{ files: { "<key>": "<url>" } }` — file URLs (e.g. Backblaze B2); the
 *    server fetches each one, or
 *  - multipart form fields — one CSV per gateway key.
 */
async function collectBuffers(req: express.Request): Promise<FileBuffers> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const buffers: FileBuffers = {};

  const urlMap = body.files as Record<string, string> | undefined;
  if (urlMap && typeof urlMap === "object") {
    await Promise.all(
      FIELD_KEYS.map(async (key) => {
        const url = urlMap[key];
        if (typeof url !== "string" || !url) return;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Failed to fetch ${key} (HTTP ${r.status})`);
        buffers[key] = Buffer.from(await r.arrayBuffer());
      }),
    );
    return buffers;
  }

  const filesByField = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  for (const key of FIELD_KEYS) {
    const file = filesByField[key]?.[0];
    if (file) buffers[key] = file.buffer;
  }
  return buffers;
}

app.post("/api/process", uploadFields, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const urlMap = body.files as Record<string, string> | undefined;
  const inputUrls =
    urlMap && typeof urlMap === "object"
      ? Object.values(urlMap).filter((v): v is string => typeof v === "string" && !!v)
      : [];
  try {
    const buffers = await collectBuffers(req);

    const params: ProcessParams = {
      dateStart: clean(body.dateStart),
      dateEnd: clean(body.dateEnd),
      orderStart: clean(body.orderStart),
      orderEnd: clean(body.orderEnd),
    };

    const result = await runPipeline(buffers, params);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    console.error("Pipeline error:", err);
    return res.status(500).json({
      ok: false,
      stage: "processing",
      message: err instanceof Error ? err.message : "Unexpected processing error.",
    });
  } finally {
    // The app retains nothing — drop the uploaded input objects from B2.
    if (inputUrls.length > 0) {
      deleteByUrls(inputUrls).catch((e) => console.warn("B2 cleanup failed:", e));
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`saint-merchant-backend listening on http://localhost:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n✖ Port ${PORT} is already in use — another server instance is still running.\n` +
        `  Fix it one of these ways:\n` +
        `    • Windows (PowerShell): Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `    • Or start on a different port:  $env:PORT=4001; npm run dev\n`,
    );
    process.exit(1);
  }
  throw err;
});
