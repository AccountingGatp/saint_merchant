import express from "express";
import cors from "cors";
import multer from "multer";
import { del, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { runPipeline } from "./pipeline/index.js";
import { FIELD_KEYS, type FileBuffers, type ProcessParams } from "./types.js";

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

const PORT = Number(process.env.PORT ?? 4000);
const BLOB_ENABLED = false;
// const BLOB_ENABLED = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const app = express();
app.use(cors());
// Blob-mode requests are tiny JSON payloads (a handful of URLs).
app.use(express.json({ limit: "1mb" }));

/**
 * multer memoryStorage keeps uploaded files as in-memory Buffers (used for
 * local multipart uploads). On Vercel the 4.5 MB request-body cap makes direct
 * multipart uploads of the ~14 MB transactions file impossible, so the browser
 * uploads straight to Vercel Blob and only sends the URLs here.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: FIELD_KEYS.length },
});
const uploadFields = upload.fields(FIELD_KEYS.map((name) => ({ name, maxCount: 1 })));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "saint-merchant-backend", blob: BLOB_ENABLED });
});

/**
 * Vercel Blob client-upload token endpoint. The browser calls this (via
 * `@vercel/blob/client` `upload`) to get a short-lived token, then uploads the
 * CSV directly to Blob storage — never through this function's request body.
 */
app.post("/api/blob/token", async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "text/csv",
          "application/vnd.ms-excel",
          "application/octet-stream",
          "text/plain",
        ],
        maximumSizeInBytes: 30 * 1024 * 1024,
        addRandomSuffix: true,
      }),
      // We process on demand and delete the blobs afterwards, so no-op here.
      onUploadCompleted: async () => {},
    });
    return res.json(jsonResponse);
  } catch (err) {
    return res
      .status(400)
      .json({ error: err instanceof Error ? err.message : "token error" });
  }
});

/** Resolve the 5 input buffers from either Blob URLs (JSON) or multipart. */
async function collectBuffers(
  req: express.Request,
): Promise<{ buffers: FileBuffers; blobUrls: string[] }> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const buffers: FileBuffers = {};
  const blobUrls: string[] = [];

  const urlMap = body.files as Record<string, string> | undefined;
  if (urlMap && typeof urlMap === "object") {
    // Blob mode — fetch each uploaded CSV from its Blob URL.
    await Promise.all(
      FIELD_KEYS.map(async (key) => {
        const url = urlMap[key];
        if (typeof url !== "string" || !url) return;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Failed to fetch ${key} from Blob (${r.status})`);
        buffers[key] = Buffer.from(await r.arrayBuffer());
        blobUrls.push(url);
      }),
    );
    return { buffers, blobUrls };
  }

  // Multipart mode (local dev).
  const filesByField = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  for (const key of FIELD_KEYS) {
    const file = filesByField[key]?.[0];
    if (file) buffers[key] = file.buffer;
  }
  return { buffers, blobUrls };
}

app.post("/api/process", uploadFields, async (req, res) => {
  let blobUrls: string[] = [];
  try {
    const collected = await collectBuffers(req);
    blobUrls = collected.blobUrls;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const params: ProcessParams = {
      dateStart: clean(body.dateStart),
      dateEnd: clean(body.dateEnd),
      orderStart: clean(body.orderStart),
      orderEnd: clean(body.orderEnd),
    };

    const result = await runPipeline(collected.buffers, params);
    if (!result.ok) return res.status(400).json(result);

    // Return the workbook via Blob (avoids the 4.5 MB response cap) when Blob is
    // configured; otherwise inline base64 for local dev.
    if (BLOB_ENABLED) {
      const buffer = Buffer.from(result.file.base64, "base64");
      const out = await put(result.file.name, buffer, {
        access: "public",
        addRandomSuffix: true,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      return res.json({
        ...result,
        file: { name: result.file.name, url: out.downloadUrl },
      });
    }
    return res.json(result);
  } catch (err) {
    console.error("Pipeline error:", err);
    return res.status(500).json({
      ok: false,
      stage: "processing",
      message: err instanceof Error ? err.message : "Unexpected processing error.",
    });
  } finally {
    // Clean up the uploaded input blobs — nothing is retained.
    if (blobUrls.length > 0) {
      del(blobUrls).catch((e) => console.warn("Blob cleanup failed:", e));
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
