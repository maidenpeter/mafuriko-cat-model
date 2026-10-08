// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { listModelFiles, type ModelFile } from "../../../lib/modelData/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What GET /api/model-data replies with. The browser side reads this in src/lib/modelData/client.ts. */
export type ModelDataListResponse =
  | { ok: true; source: "folder"; folderName: string; files: ModelFile[] }
  | { ok: false; folderName: string; reason: string };

/**
 * Lists the model input files that sit in the model data folder on this machine.
 * 200 with the list, or 404 with a reason when the folder is not there. Never cached,
 * so a file added to the folder shows on the next load.
 */
export async function GET() {
  const listing = await listModelFiles();
  const body: ModelDataListResponse = listing.ok
    ? { ok: true, source: "folder", folderName: listing.folderName, files: listing.files }
    : { ok: false, folderName: listing.folderName, reason: listing.reason };
  return Response.json(body, { status: listing.ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
