import { fromArrayBuffer } from "geotiff";
import type { HazardKind, Raster } from "../model/types";

export async function readRaster(buffer: ArrayBuffer, scenarioId: string, fileName: string): Promise<Raster> {
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const band = (await image.readRasters({ samples: [0], interleave: true })) as unknown as ArrayLike<number>;
  const data = band instanceof Float32Array ? band : Float32Array.from(band);
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  return {
    scenarioId,
    fileName,
    width: image.getWidth(),
    height: image.getHeight(),
    bbox: [minLon, minLat, maxLon, maxLat],
    data,
    noData: image.getGDALNoData(),
  };
}

/** A raw cell value turned into a usable hazard value. Anything that is not a positive number is dry. */
export function cleanValue(raw: number, raster: Pick<Raster, "noData">, kind: HazardKind): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raster.noData !== null && raw === raster.noData) return 0;
  if (kind === "depth_m" && raw > 1e6) return 0;
  return raw;
}

export interface Sample {
  inside: boolean;
  value: number;
}

/** Value of the cell that contains the point. */
export function sampleRaster(raster: Raster, lon: number, lat: number, kind: HazardKind): Sample {
  const [minLon, minLat, maxLon, maxLat] = raster.bbox;
  const col = Math.floor(((lon - minLon) / (maxLon - minLon)) * raster.width);
  const row = Math.floor(((maxLat - lat) / (maxLat - minLat)) * raster.height);
  if (col < 0 || row < 0 || col >= raster.width || row >= raster.height) return { inside: false, value: 0 };
  return { inside: true, value: cleanValue(raster.data[row * raster.width + col], raster, kind) };
}
