import { BOUNDS, inBounds } from "./bounds";
import type { Building, CampusData, PlacesData, Ring, TerrainData } from "./types";

/**
 * Recorte de los datasets al rectángulo de BOUNDS. Se hace al cargar, una vez.
 * Los puntos se descartan; las vías se cortan en el borde (para que terminen a ras
 * del costado de la maqueta) y las áreas se recortan con Sutherland–Hodgman.
 */

type P = [number, number];

function clipRing(ring: Ring): Ring {
  const edges: { inside: (p: P) => boolean; cut: (a: P, b: P) => P }[] = [
    {
      inside: (p) => p[0] >= BOUNDS.minX,
      cut: (a, b) => [BOUNDS.minX, a[1] + ((b[1] - a[1]) * (BOUNDS.minX - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[0] <= BOUNDS.maxX,
      cut: (a, b) => [BOUNDS.maxX, a[1] + ((b[1] - a[1]) * (BOUNDS.maxX - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[1] >= BOUNDS.minY,
      cut: (a, b) => [a[0] + ((b[0] - a[0]) * (BOUNDS.minY - a[1])) / (b[1] - a[1]), BOUNDS.minY],
    },
    {
      inside: (p) => p[1] <= BOUNDS.maxY,
      cut: (a, b) => [a[0] + ((b[0] - a[0]) * (BOUNDS.maxY - a[1])) / (b[1] - a[1]), BOUNDS.maxY],
    },
  ];
  let poly = ring as P[];
  for (const e of edges) {
    if (poly.length === 0) break;
    const next: P[] = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const prev = poly[(i + poly.length - 1) % poly.length];
      if (e.inside(cur)) {
        if (!e.inside(prev)) next.push(e.cut(prev, cur));
        next.push(cur);
      } else if (e.inside(prev)) {
        next.push(e.cut(prev, cur));
      }
    }
    poly = next;
  }
  return poly;
}

/** Parte una polilínea en los tramos que caen dentro del rectángulo (Liang–Barsky). */
function clipPolyline(pts: Ring): Ring[] {
  const out: Ring[] = [];
  let cur: P[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - BOUNDS.minX, BOUNDS.maxX - x0, y0 - BOUNDS.minY, BOUNDS.maxY - y0];
    let visible = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) visible = false;
      } else {
        const r = q[k] / p[k];
        if (p[k] < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!visible || t0 > t1) {
      flush();
      continue;
    }
    const a: P = [x0 + t0 * dx, y0 + t0 * dy];
    const b: P = [x0 + t1 * dx, y0 + t1 * dy];
    if (cur.length === 0) cur.push(a);
    else if (t0 > 0) {
      flush();
      cur.push(a);
    }
    cur.push(b);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

function buildingCentre(b: Building): P | null {
  const outer = b.parts[0]?.outer;
  if (!outer?.length) return null;
  let x = 0;
  let y = 0;
  for (const p of outer) {
    x += p[0];
    y += p[1];
  }
  return [x / outer.length, y / outer.length];
}

export function clipCampus(d: CampusData): CampusData {
  const buildings = d.buildings.filter((b) => {
    const c = buildingCentre(b);
    return c ? inBounds(c[0], c[1]) : false;
  });
  return {
    ...d,
    buildings,
    meta: {
      ...d.meta,
      buildingCount: buildings.length,
      namedCount: buildings.filter((b) => b.name).length,
    },
  };
}

export function clipTerrain(d: TerrainData): TerrainData {
  const areas = d.areas.flatMap((a) => {
    const outer = clipRing(a.outer);
    if (outer.length < 3) return [];
    return [{ ...a, outer, holes: a.holes.map(clipRing).filter((h) => h.length >= 3) }];
  });
  const paths = d.paths.flatMap((p) =>
    clipPolyline(p.points).map((points, i) => ({ ...p, id: i ? `${p.id}#${i}` : p.id, points })),
  );
  const trees = d.trees.filter((t) => inBounds(t.pos[0], t.pos[1]));
  return {
    ...d,
    areas,
    paths,
    trees,
    meta: { ...d.meta, areaCount: areas.length, pathCount: paths.length, treeCount: trees.length },
  };
}

export function clipPlaces(d: PlacesData): PlacesData {
  const accesses = d.accesses.filter((a) => inBounds(a.pos[0], a.pos[1]));
  const services = d.services.filter((s) => inBounds(s.pos[0], s.pos[1]));
  return {
    ...d,
    accesses,
    services,
    meta: { ...d.meta, accessCount: accesses.length, serviceCount: services.length },
  };
}
