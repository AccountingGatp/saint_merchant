import express from "express";
import cors from "cors";
import multer from "multer";
import { runPipeline } from "./pipeline/index.js";
import { FIELD_KEYS, type FileBuffers, type ProcessParams } from "./types.js";

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

const PORT = Number(process.env.PORT ?? 4000);

/**
 * IMPORTANT: multer memoryStorage keeps every uploaded file as an in-memory
 * Buffer. Nothing is ever written to disk — the buffers are processed and then
 * discarded when the request ends. No storage, anywhere.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: FIELD_KEYS.length },
});

const app = express();
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "saint-merchant-backend" });
});

const uploadFields = upload.fields(FIELD_KEYS.map((name) => ({ name, maxCount: 1 })));

app.post("/api/process", uploadFields, async (req, res) => {
  try {
    const filesByField = (req.files ?? {}) as Record<string, Express.Multer.File[]>;

    const buffers: FileBuffers = {};
    for (const key of FIELD_KEYS) {
      const file = filesByField[key]?.[0];
      if (file) buffers[key] = file.buffer;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const params: ProcessParams = {
      dateStart: clean(body.dateStart),
      dateEnd: clean(body.dateEnd),
      orderStart: clean(body.orderStart),
      orderEnd: clean(body.orderEnd),
    };

    const result = await runPipeline(buffers, params);

    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("Pipeline error:", err);
    return res.status(500).json({
      ok: false,
      stage: "processing",
      message: err instanceof Error ? err.message : "Unexpected processing error.",
    });
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
