/**
 * Rectángulo de trabajo, en el plano de la shape ([x = este, y = norte], metros
 * desde el origen de campus.json).
 *
 * Todo lo que queda fuera se descarta al cargar los datos (edificios, árboles,
 * puntos) o se recorta (vías y áreas). Abarca el campus completo más las manzanas
 * de alrededor, cerrado por vías: Av. Cra. 7 al oeste, Av. Cra. 1 al este,
 * Av. Calle 45 al norte y el eje de la Calle 40 / Av. Calle 39 al sur.
 */
export const BOUNDS = { minX: -330, maxX: 330, minY: -450, maxY: 350 } as const;

export function inBounds(x: number, y: number): boolean {
  return x >= BOUNDS.minX && x <= BOUNDS.maxX && y >= BOUNDS.minY && y <= BOUNDS.maxY;
}
