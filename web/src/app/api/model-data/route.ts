// Relative paths, not the "@/" alias: the tests call this handler directly, and they run without the alias.
import { listModelFiles, type ModelDataLayout, type ModelFile } from "../../../lib/modelData/server";
import type { ListedVersion } from "../../../lib/modelData/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What GET /api/model-data replies with. The browser side reads this in src/lib/modelData/client.ts.
 *
 *   versions   every version in the folder, newest first in `versions` is not promised: sort with
 *              newestFirst from version.ts. One with a `problem` is shown but cannot be loaded.
 *   default    the id of the version that opens by default, null when none can; `why` says why.
 *   files      the default version's files, as "<version id>/<file name>" (plain names in the flat layout).
 *   layout     "versions" for dated version folders, "flat" for a folder holding the files directly.
 */
export type ModelDataListResponse =
  | { ok: true; source: "folder"; folderName: string; layout: ModelDataLayout; files: ModelFile[]; versions: ListedVersion[]; default: string | null; why: string }
  | { ok: false; folderName: string; reason: string };

/**
 * Lists the model data versions in the folder on this machine, and the files of the default one.
 * 200 with the list, or 404 with a reason when the folder is not there. Never cached, so a
 * version added to the folder shows on the next load.
 */
export async function GET() {
  const listing = await listModelFiles();
  const body: ModelDataListResponse = listing.ok
    ? { ok: true, source: "folder", folderName: listing.folderName, layout: listing.layout, files: listing.files, versions: listing.versions, default: listing.defaultId, why: listing.why }
    : { ok: false, folderName: listing.folderName, reason: listing.reason };
  return Response.json(body, { status: listing.ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
