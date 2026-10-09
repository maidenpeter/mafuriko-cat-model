// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveListed } from "../../../../lib/modelData/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A version's file never changes, so the browser may keep it for a year without asking again. */
const FOR_GOOD = "public, max-age=31536000, immutable";

/** One answer for everything that is not on the list, so a caller learns nothing about the disk. */
const notFound = () => Response.json({ ok: false, reason: "Not a model input file." }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Serves one file of a version, as bytes: GET /api/model-data/<version id>/<file name>, the paths
 * that GET /api/model-data lists. In the flat layout the old paths without a version id still
 * work. A file of a manifest-backed version comes with a long cache header and an ETag made from
 * its manifest hash, and a matching If-None-Match gets a 304; a file of the flat layout, which
 * can change on disk, is never cached. Anything else, whatever the reason, is the same plain 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  if (!Array.isArray(segments) || segments.length === 0) return notFound();
  // The framework has already decoded each segment, so a separator inside one can only have
  // arrived percent-encoded. No listed path needs that, and it is refused before the lookup.
  if (segments.some((s) => typeof s !== "string" || s === "" || s.includes("/") || s.includes("\\"))) return notFound();

  const found = await resolveListed(segments.join("/"));
  if (!found) return notFound();

  const etag = found.sha256 ? `"${found.sha256}"` : null;
  const caching: Record<string, string> = found.immutable && etag ? { "Cache-Control": FOR_GOOD, ETag: etag } : { "Cache-Control": "no-store" };
  if (etag && found.immutable && req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: caching });

  // Streamed, not read whole: a hazard raster can be large.
  const body = Readable.toWeb(createReadStream(found.file)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": found.contentType,
      "Content-Length": String(found.size),
      "X-Content-Type-Options": "nosniff",
      ...caching,
    },
  });
}
