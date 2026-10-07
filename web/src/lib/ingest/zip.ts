import JSZip from "jszip";
import type { FileSource } from "./index";

// Zips made on Windows can use backslashes between folders.
const normalise = (path: string) => path.replaceAll("\\", "/").replace(/^\/+/, "");

/** Entries of an uploaded zip, read lazily. */
export async function filesFromZip(zipFile: Blob | ArrayBuffer | Uint8Array): Promise<FileSource[]> {
  const zip = await JSZip.loadAsync(zipFile);
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && !entry.name.endsWith("\\"))
    .map((entry) => ({
      path: normalise(entry.name),
      size: (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      text: () => entry.async("string"),
      arrayBuffer: () => entry.async("arraybuffer"),
    }));
}

/** Loose files or a dropped folder, for when the data does not arrive zipped. */
export function filesFromList(list: File[]): FileSource[] {
  return list.map((f) => ({
    path: normalise(f.webkitRelativePath || f.name),
    size: f.size,
    text: () => f.text(),
    arrayBuffer: () => f.arrayBuffer(),
  }));
}

/** Accepts one zip, or any set of loose files. */
export async function filesFromUpload(list: File[]): Promise<{ name: string; files: FileSource[] }> {
  const zips = list.filter((f) => f.name.toLowerCase().endsWith(".zip"));
  if (zips.length === 1 && list.length === 1) {
    return { name: zips[0].name.replace(/\.zip$/i, ""), files: await filesFromZip(zips[0]) };
  }
  return { name: "uploaded files", files: filesFromList(list.filter((f) => !f.name.toLowerCase().endsWith(".zip"))) };
}
