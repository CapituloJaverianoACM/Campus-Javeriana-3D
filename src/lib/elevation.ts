import * as THREE from "three";
import raw from "@/data/elevation.json";
import { BOUNDS } from "./bounds";
import { campusData } from "./campus-data";
import type { Ring } from "./types";

/**
 * Relieve del terreno (ver scripts/fetch-elevation.ts).
 *
 * El modelo digital es de ~90 m de resolución: describe la ladera, no cada
 * escalón del campus. Se interpola con Catmull-Rom bicúbico para que la
 * superficie sea suave y no salgan facetas de rejilla.
 */

type Grid = {
  meta: { stepM: number; x0: number; y0: number; cols: number; rows: number; minM: number };
  heights: number[];
};
const grid = raw as unknown as Grid;

/**
 * Exageración vertical. El desnivel real dentro del rectángulo es de ~140 m sobre
 * ~800 m de lado (pendiente media 17 %), que en pantalla se lee casi plano al
 * lado de edificios de 20–70 m.
 */
export const VERTICAL_EXAGGERATION = 1.5;

/** Profundidad del zócalo bajo el punto más bajo del terreno, en metros. */
export const BASE_DEPTH = 14;

const { stepM, x0, y0, cols, rows, minM } = grid.meta;

function cell(c: number, r: number): number {
  const cc = Math.min(cols - 1, Math.max(0, c));
  const rr = Math.min(rows - 1, Math.max(0, r));
  return grid.heights[rr * cols + cc] - minM;
}

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/** Relieve del modelo digital, sin plataformas de edificios. */
function demAtShape(x: number, y: number): number {
  const fx = (x - x0) / stepM;
  const fy = (y - y0) / stepM;
  const c = Math.floor(fx);
  const r = Math.floor(fy);
  const tx = fx - c;
  const ty = fy - r;
  const col: number[] = [];
  for (let j = -1; j <= 2; j++) {
    col.push(
      cubic(cell(c - 1, r + j), cell(c, r + j), cell(c + 1, r + j), cell(c + 2, r + j), tx),
    );
  }
  return cubic(col[0], col[1], col[2], col[3], ty);
}


/* ------------------------------------------------------------------ *
 *  Plataformas de edificios
 * ------------------------------------------------------------------ */

/**
 * El modelo digital es una ladera suave de 90 m; el campus real está aterrazado.
 * Si un edificio se apoya en esa ladera tal cual, el lado alto queda enterrado (en
 * decenas de edificios el desnivel bajo la huella supera su propia altura). Por eso se
 * nivela una plataforma bajo cada edificio, a la cota media de su huella, con una
 * rampa suave hacia el terreno natural.
 */
const PAD_CELL = 2;
const PAD_RAMP = 9;
const gx0 = BOUNDS.minX - PAD_CELL;
const gy0 = BOUNDS.minY - PAD_CELL;
const gcols = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / PAD_CELL) + 3;
const grows = Math.ceil((BOUNDS.maxY - BOUNDS.minY) / PAD_CELL) + 3;

const raster = new Float32Array(gcols * grows);
const padByBuilding = new Map<string, number>();

function distToRing(px: number, py: number, ring: Ring): { d: number; inside: boolean } {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return { d: inside ? 0 : best, inside };
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a) / 2;
}

function buildRaster() {
  // Base: el modelo digital muestreado en la rejilla fina.
  for (let r = 0; r < grows; r++) {
    for (let c = 0; c < gcols; c++) raster[r * gcols + c] = demAtShape(gx0 + c * PAD_CELL, gy0 + r * PAD_CELL);
  }
  const base = Float32Array.from(raster);

  const rings = campusData.buildings
    .filter((b) => !b.isPart && b.parts[0])
    .flatMap((b) => b.parts.map((p) => ({ id: b.id, ring: p.outer })))
    .filter((e) => e.ring.length >= 3 && ringArea(e.ring) > 25)
    // Los grandes primero: si dos huellas se solapan, gana la más pequeña.
    .sort((a, b) => ringArea(b.ring) - ringArea(a.ring));

  const wMax = new Float32Array(gcols * grows);
  const wSum = new Float32Array(gcols * grows);
  const hSum = new Float32Array(gcols * grows);
  const flat = new Float32Array(gcols * grows).fill(NaN);

  for (const { id, ring } of rings) {
    let mean = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      mean += demAtShape(x, y);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const pad = mean / ring.length;
    padByBuilding.set(id, pad);

    const c0 = Math.max(0, Math.floor((minX - PAD_RAMP - gx0) / PAD_CELL));
    const c1 = Math.min(gcols - 1, Math.ceil((maxX + PAD_RAMP - gx0) / PAD_CELL));
    const r0 = Math.max(0, Math.floor((minY - PAD_RAMP - gy0) / PAD_CELL));
    const r1 = Math.min(grows - 1, Math.ceil((maxY + PAD_RAMP - gy0) / PAD_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const { d, inside } = distToRing(gx0 + c * PAD_CELL, gy0 + r * PAD_CELL, ring);
        const k = r * gcols + c;
        if (inside) {
          flat[k] = pad;
        } else if (d < PAD_RAMP) {
          const t = d / PAD_RAMP;
          const w = 1 - t * t * (3 - 2 * t);
          wSum[k] += w;
          hSum[k] += w * pad;
          if (w > wMax[k]) wMax[k] = w;
        }
      }
    }
  }

  for (let k = 0; k < raster.length; k++) {
    if (!Number.isNaN(flat[k])) raster[k] = flat[k];
    else if (wSum[k] > 0) raster[k] = base[k] * (1 - wMax[k]) + (hSum[k] / wSum[k]) * wMax[k];
  }
  // Pasa a metros de mundo con la exageración ya aplicada.
  for (let k = 0; k < raster.length; k++) raster[k] *= VERTICAL_EXAGGERATION;
  for (const [id, v] of padByBuilding) padByBuilding.set(id, v * VERTICAL_EXAGGERATION);
}
buildRaster();

/** Cota de la plataforma de un edificio, si tiene. */
export function padYFor(buildingId: string): number | undefined {
  return padByBuilding.get(buildingId);
}

/** Altura del terreno en un punto del plano de la shape (metros sobre el punto más bajo). */
export function groundAtShape(x: number, y: number): number {
  const fx = Math.min(gcols - 1.001, Math.max(0, (x - gx0) / PAD_CELL));
  const fy = Math.min(grows - 1.001, Math.max(0, (y - gy0) / PAD_CELL));
  const c = Math.floor(fx);
  const r = Math.floor(fy);
  const tx = fx - c;
  const ty = fy - r;
  const k = r * gcols + c;
  return (
    raster[k] * (1 - tx) * (1 - ty) +
    raster[k + 1] * tx * (1 - ty) +
    raster[k + gcols] * (1 - tx) * ty +
    raster[k + gcols + 1] * tx * ty
  );
}

/** Altura del terreno en coordenadas del mundo (x = este, z = -norte). */
export function groundY(x: number, z: number): number {
  return groundAtShape(x, -z);
}

/** Normal del terreno en el mundo, por diferencias centrales. */
export function groundNormal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 3;
  const dx = groundY(x + e, z) - groundY(x - e, z);
  const dz = groundY(x, z + e) - groundY(x, z - e);
  return out.set(-dx / (2 * e), 1, -dz / (2 * e)).normalize();
}

/** Punto más bajo bajo una huella circular: el edificio se apoya en él y se entierra por el lado alto. */
export function groundUnderFootprint(cx: number, cz: number, radius: number): number {
  let low = groundY(cx, cz);
  const r = Math.min(radius, 60) * 0.8;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    low = Math.min(low, groundY(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
  }
  return low;
}

export const WORLD_BOUNDS = {
  minX: BOUNDS.minX,
  maxX: BOUNDS.maxX,
  // z = -norte
  minZ: -BOUNDS.maxY,
  maxZ: -BOUNDS.minY,
};

/**
 * Subdivide los triángulos hasta que ninguna arista (en XZ) supere `maxEdge` y
 * apoya la malla sobre el relieve: y += terreno, normales = normal del terreno.
 * Hace falta subdividir porque un polígono triangulado con tres vértices no
 * puede seguir una ladera.
 */
export function drapeGeometry(src: THREE.BufferGeometry, maxEdge = 6): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const names = Object.keys(g.attributes);
  const sizes = names.map((n) => g.attributes[n].itemSize);
  const stride = sizes.reduce((a, b) => a + b, 0);
  const posOff = 0; // `position` es siempre el primer atributo tras toNonIndexed en nuestras mallas
  if (names[0] !== "position") throw new Error("[elevation] position debe ser el primer atributo");

  const count = g.attributes.position.count;
  const vert = (i: number) => {
    const v = new Array<number>(stride);
    let o = 0;
    names.forEach((n, k) => {
      const a = g.attributes[n];
      for (let c = 0; c < sizes[k]; c++) v[o++] = a.getComponent(i, c);
    });
    return v;
  };
  const mid = (a: number[], b: number[]) => a.map((v, i) => (v + b[i]) / 2);
  const len2 = (a: number[], b: number[]) =>
    Math.hypot(a[posOff] - b[posOff], a[posOff + 2] - b[posOff + 2]);

  const out: number[][] = [];
  const stack: number[][][] = [];
  for (let t = 0; t < count; t += 3) {
    stack.push([vert(t), vert(t + 1), vert(t + 2)]);
    while (stack.length) {
      const [a, b, c] = stack.pop()!;
      const ab = len2(a, b);
      const bc = len2(b, c);
      const ca = len2(c, a);
      const m = Math.max(ab, bc, ca);
      if (m <= maxEdge) {
        out.push(a, b, c);
      } else if (m === ab) {
        const d = mid(a, b);
        stack.push([a, d, c], [d, b, c]);
      } else if (m === bc) {
        const d = mid(b, c);
        stack.push([a, b, d], [a, d, c]);
      } else {
        const d = mid(c, a);
        stack.push([a, b, d], [d, b, c]);
      }
    }
  }
  g.dispose();

  const res = new THREE.BufferGeometry();
  let o = 0;
  const n = new THREE.Vector3();
  names.forEach((name, k) => {
    const arr = new Float32Array(out.length * sizes[k]);
    out.forEach((v, i) => {
      for (let c = 0; c < sizes[k]; c++) arr[i * sizes[k] + c] = v[o + c];
    });
    res.setAttribute(name, new THREE.BufferAttribute(arr, sizes[k]));
    o += sizes[k];
  });

  const pos = res.attributes.position as THREE.BufferAttribute;
  const nor = res.attributes.normal as THREE.BufferAttribute | undefined;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + groundY(x, z));
    if (nor) {
      groundNormal(x, z, n);
      nor.setXYZ(i, n.x, n.y, n.z);
    }
  }
  return res;
}

/**
 * Plano de terreno rectangular con los cuatro costados hasta el zócalo: se lee
 * como una maqueta recortada por las vías y no como una mancha flotante.
 */
export function buildGroundPlate(step = 4, lift = -0.6): {
  top: THREE.BufferGeometry;
  skirt: THREE.BufferGeometry;
} {
  const { minX, maxX, minZ, maxZ } = WORLD_BOUNDS;
  const nx = Math.ceil((maxX - minX) / step);
  const nz = Math.ceil((maxZ - minZ) / step);
  const xAt = (i: number) => minX + ((maxX - minX) * i) / nx;
  const zAt = (j: number) => minZ + ((maxZ - minZ) * j) / nz;

  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const nor = new Float32Array((nx + 1) * (nz + 1) * 3);
  const n = new THREE.Vector3();
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = (j * (nx + 1) + i) * 3;
      const x = xAt(i);
      const z = zAt(j);
      pos[k] = x;
      pos[k + 1] = groundY(x, z) + lift;
      pos[k + 2] = z;
      groundNormal(x, z, n);
      nor[k] = n.x;
      nor[k + 1] = n.y;
      nor[k + 2] = n.z;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  top.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  top.setIndex(idx);

  // Cada costado se emite por separado (vértices propios en las esquinas) para que
  // su normal sea horizontal y no se promedie con la del costado vecino.
  const sp: number[] = [];
  const sn: number[] = [];
  const si: number[] = [];
  const bottom = -BASE_DEPTH;
  const side = (pts: [number, number][], ox: number, oz: number) => {
    const base = sp.length / 3;
    pts.forEach(([x, z]) => {
      sp.push(x, groundY(x, z) + lift, z, x, bottom, z);
      sn.push(ox, 0, oz, ox, 0, oz);
    });
    for (let k = 0; k < pts.length - 1; k++) {
      const a = base + k * 2;
      si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  const xs = Array.from({ length: nx + 1 }, (_, i) => xAt(i));
  const zs = Array.from({ length: nz + 1 }, (_, j) => zAt(j));
  side(xs.map((x) => [x, minZ]), 0, -1);
  side(xs.map((x) => [x, maxZ]), 0, 1);
  side(zs.map((z) => [minX, z]), -1, 0);
  side(zs.map((z) => [maxX, z]), 1, 0);
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
  skirt.setAttribute("normal", new THREE.Float32BufferAttribute(sn, 3));
  skirt.setIndex(si);
  return { top, skirt };
}
