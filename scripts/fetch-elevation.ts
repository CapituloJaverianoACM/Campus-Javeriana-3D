/**
 * Ingesta del RELIEVE (elevación del terreno) bajo el rectángulo de trabajo.
 *
 * Fuente: Open-Meteo Elevation API (Copernicus DEM GLO-90, ~90 m de resolución).
 * Es un modelo de terreno, no de edificios: da la ladera de los Cerros Orientales,
 * no cada escalón del campus. Se muestrea cada STEP_M y en runtime se interpola.
 *
 * Se ejecuta manualmente (`bun run osm:elevation`) y escribe src/data/elevation.json.
 * Usa el mismo origen de proyección que campus.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BOUNDS } from "../src/lib/bounds";

const IN_PATH = fileURLToPath(new URL("../src/data/campus.json", import.meta.url));
const OUT_PATH = fileURLToPath(new URL("../src/data/elevation.json", import.meta.url));
const M_PER_DEG_LAT = 111_320;
const STEP_M = 45;
const MARGIN_M = STEP_M * 2;

const campus = JSON.parse(await readFile(IN_PATH, "utf8"));
const { lat: lat0, lon: lon0 } = campus.meta.origin;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

const x0 = BOUNDS.minX - MARGIN_M;
const y0 = BOUNDS.minY - MARGIN_M;
const cols = Math.ceil((BOUNDS.maxX + MARGIN_M - x0) / STEP_M) + 1;
const rows = Math.ceil((BOUNDS.maxY + MARGIN_M - y0) / STEP_M) + 1;

const lats: number[] = [];
const lons: number[] = [];
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    lats.push(+(lat0 + (y0 + r * STEP_M) / M_PER_DEG_LAT).toFixed(6));
    lons.push(+(lon0 + (x0 + c * STEP_M) / mPerDegLon).toFixed(6));
  }
}

const heights: number[] = [];
for (let i = 0; i < lats.length; i += 100) {
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats.slice(i, i + 100).join(",")}&longitude=${lons.slice(i, i + 100).join(",")}`;
  let json: { elevation?: number[] } | null = null;
  for (let attempt = 0; attempt < 4 && !json?.elevation; attempt++) {
    const res = await fetch(url);
    if (res.ok) json = await res.json();
    else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!json?.elevation) throw new Error(`Open-Meteo falló en el lote ${i}`);
  heights.push(...json.elevation);
}

await writeFile(
  OUT_PATH,
  JSON.stringify({
    meta: {
      source: "Copernicus DEM GLO-90 vía Open-Meteo",
      fetchedAt: new Date().toISOString(),
      origin: { lat: lat0, lon: lon0 },
      stepM: STEP_M,
      x0,
      y0,
      cols,
      rows,
      minM: Math.min(...heights),
      maxM: Math.max(...heights),
    },
    heights,
  }),
);
console.log(`${cols}×${rows} puntos, ${Math.min(...heights)}–${Math.max(...heights)} m → ${OUT_PATH}`);
