/**
 * Writes the building-level exports the three Oasis runs read (see oasis/README.md).
 *
 *   node scripts/export-buildings.mjs [output folder]
 *
 * Run it from the web folder. The default output folder is ../oasis/runs/exports, which git
 * ignores: the files hold one row per building of the starter kit and must never be committed.
 *
 * The work is done by scripts/export-buildings.test.ts, run here through the test runner so the
 * app's own TypeScript library is used as it is. That file does nothing in an ordinary "npm test".
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folder = resolve(process.argv[2] ?? resolve(web, "..", "oasis", "runs", "exports"));
process.env.OASIS_EXPORT_DIR = folder;

const runner = await startVitest("test", ["scripts/export-buildings.test.ts"], { root: web, watch: false });
await runner?.close();

// Totals only: which view each file is for, its fingerprint and its event losses.
if (!process.exitCode) {
  console.log(`Building-level exports in ${folder}`);
  for (const name of readdirSync(folder).filter((f) => f.endsWith(".view.json")).sort()) {
    const view = JSON.parse(readFileSync(join(folder, name), "utf8"));
    console.log(`  ${name.replace(/\.view\.json$/, ".csv")}: ${view.floodSourceLabel}, ${view.lossesFromLabel}, ${view.assumptions.set} assumptions, fingerprint ${view.fingerprint}`);
    console.log(`    ground-up loss, KES m: ${view.scenarios.map((s) => `1-in-${s.returnPeriod} ${(s.lossKes / 1e6).toFixed(1)}`).join(", ")}`);
  }
}
