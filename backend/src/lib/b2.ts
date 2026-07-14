import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Backblaze B2 is S3-compatible, so the AWS S3 SDK talks to it directly.
 *
 * The browser can't POST a ~14 MB file through Vercel (4.5 MB request-body cap →
 * HTTP 413). Instead we hand the browser a short-lived **presigned PUT URL** so
 * it uploads the CSV straight to B2, then a matching **presigned GET URL** the
 * server uses to fetch that object back when processing. No large payload ever
 * touches the Vercel function.
 */

const {
  B2_ENDPOINT,
  B2_REGION,
  B2_BUCKET,
  B2_KEY_ID,
  B2_APP_KEY,
  B2_URL_EXPIRY,
} = process.env;

/** True only when every B2 credential is present (e.g. on the deployed host). */
export const B2_ENABLED = Boolean(
  B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APP_KEY,
);

/** Seconds a presigned URL stays valid (default 600 = 10 min). */
const EXPIRY = Number(B2_URL_EXPIRY ?? 600);

let client: S3Client | null = null;
function s3(): S3Client {
  if (!B2_ENABLED) {
    throw new Error("Backblaze B2 is not configured (missing B2_* env vars).");
  }
  if (!client) {
    client = new S3Client({
      endpoint: B2_ENDPOINT,
      region: B2_REGION,
      credentials: { accessKeyId: B2_KEY_ID!, secretAccessKey: B2_APP_KEY! },
      // B2's S3 API requires path-style addressing.
      forcePathStyle: true,
    });
  }
  return client;
}

export interface PresignedUpload {
  /** Object key in the bucket. */
  objectKey: string;
  /** Presigned PUT URL — the browser uploads the file body here. */
  uploadUrl: string;
  /** Presigned GET URL — the server fetches the object from here. */
  fileUrl: string;
}

/**
 * Create a presigned PUT + GET pair for one upload. Objects are grouped under a
 * random per-submission prefix so parallel jobs never collide.
 */
export async function presignUpload(
  prefix: string,
  key: string,
  contentType = "text/csv",
): Promise<PresignedUpload> {
  const objectKey = `uploads/${prefix}/${key}.csv`;
  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: B2_BUCKET, Key: objectKey, ContentType: contentType }),
    { expiresIn: EXPIRY },
  );
  const fileUrl = await getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: B2_BUCKET, Key: objectKey }),
    { expiresIn: EXPIRY },
  );
  return { objectKey, uploadUrl, fileUrl };
}

/** A fresh random prefix for one upload batch. */
export const newUploadPrefix = (): string => randomUUID();

/** Extract the bucket object key from a presigned URL (path-style). */
function objectKeyFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    // Path-style: /<bucket>/<key...> — strip the leading bucket segment.
    const decoded = decodeURIComponent(pathname.replace(/^\/+/, ""));
    const prefix = `${B2_BUCKET}/`;
    return decoded.startsWith(prefix) ? decoded.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

/**
 * Delete uploaded input objects once processing is done — the app keeps nothing.
 * Best-effort: failures are swallowed by the caller.
 */
export async function deleteByUrls(urls: string[]): Promise<void> {
  if (!B2_ENABLED || urls.length === 0) return;
  await Promise.all(
    urls.map(async (url) => {
      const objectKey = objectKeyFromUrl(url);
      if (!objectKey) return;
      await s3().send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: objectKey }));
    }),
  );
}
