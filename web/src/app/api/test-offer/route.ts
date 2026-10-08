// Relative paths, not the "@/" alias, as in the model data routes beside this one.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { modelDataDir } from "../../../lib/modelData/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const missing = (reason: string) => Response.json({ ok: false, reason }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * The Nairobi test offer, for rehearsal (/?offer=1). It is read where it lies: the first .docx
 * with NAIROBI in its name, in the folder test-data beside the model data folder. Nothing is
 * copied into this repository. 404 with a reason when the folder or the file is not there.
 */
export async function GET() {
  const dir = path.resolve(modelDataDir(), "..", "test-data");
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return missing("There is no test-data folder beside the model data folder.");
  }
  // A name starting "~$" is the lock file Word leaves beside a document that is open.
  const name = names.find((n) => !n.startsWith(".") && !n.startsWith("~$") && /\.docx$/i.test(n) && /nairobi/i.test(n));
  if (!name) return missing("The test-data folder holds no Nairobi offer (.docx).");

  let bytes: Buffer;
  try {
    const file = path.join(dir, name);
    if (!(await stat(file)).isFile()) return missing("The Nairobi offer in the test-data folder is not a file.");
    bytes = await readFile(file);
  } catch {
    return missing("The Nairobi offer in the test-data folder could not be read.");
  }

  // The plain name for old readers, with anything a header cannot carry replaced, and the exact name beside it.
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": WORD_TYPE,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
