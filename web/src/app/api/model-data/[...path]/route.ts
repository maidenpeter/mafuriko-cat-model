// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveListed } from "../../../../lib/modelData/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One answer for everything that is not on the list, so a caller learns nothing about the disk. */
const notFound = () => Response.json({ ok: false, reason: "Not a model input file." }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * Serves one file from the list that GET /api/model-data returns, as bytes.
 * Anything else, whatever the reason, is the same plain 404.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  if (!Array.isArray(segments) || segments.length === 0) return notFound();
  // The framework has already decoded each segment, so a separator inside one can only have
  // arrived percent-encoded. No listed path needs that, and it is refused before the lookup.
  if (segments.some((s) => typeof s !== "string" || s === "" || s.includes("/") || s.includes("\\"))) return notFound();

  const found = await resolveListed(segments.join("/"));
  if (!found) return notFound();

  // Streamed, not read whole: a hazard raster can be large.
  const body = Readable.toWeb(createReadStream(found.file)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": found.contentType,
      "Content-Length": String(found.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
