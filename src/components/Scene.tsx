"use client";

import { Line, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Buildings, type PreparedBuilding } from "./Buildings";
import { Labels } from "./Labels";
import { Terrain } from "./Terrain";
import { Places } from "./Places";
import { buildCampusGround, campusOutlinePoints } from "@/lib/geometry";
import { buildGroundPlate, drapeGeometry, groundY } from "@/lib/elevation";
import { setNightMode } from "@/lib/materials";
import type { CampusData, PlacesData, TerrainData } from "@/lib/types";

/**
 * Todas las magnitudes de esta escena se derivan del tamaño real del campus
 * (meta.widthM × meta.depthM ≈ 393 × 590 m). Fijar niebla, zoom o volumen de
 * sombra a constantes pensadas para una escena de juguete es lo que dejaba el
 * prototipo anterior en pantalla negra: la cámara arrancaba a ~770 m con la
 * niebla cerrando a 260 m.
 */

function EnvironmentLighting() {
  const { gl, scene } = useThree();

  useEffect(() => {
    // RoomEnvironment es procedural: da reflejos creíbles al vidrio y al acero
    // sin descargar ningún HDR de un CDN externo.
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = new RoomEnvironment();
    const target = pmrem.fromScene(env, 0.04);
    scene.environment = target.texture;

    return () => {
      scene.environment = null;
      target.texture.dispose();
      pmrem.dispose();
      env.dispose?.();
    };
  }, [gl, scene]);

  return null;
}

/**
 * Esfera envolvente de lo que proyecta sombra.
 *
 * Antes el frustum se dimensionaba con el radio del CAMPUS (295 m), que no es lo mismo
 * que la extensión de los volúmenes: estos llegan a z = +285 y a x = -193, así que la
 * esquina sur-oeste queda a 330 m del origen y se salía de la caja. Como el ortho está
 * orientado según la luz y no según los ejes del mundo, el recorte no era evidente —
 * simplemente algunos edificios del sur dejaban de proyectar.
 *
 * Se usa una esfera y no una caja precisamente porque es invariante a la orientación
 * de la luz: sirva cual sirva la dirección del sol, la cobertura está garantizada.
 */
function castingBounds(prepared: PreparedBuilding[]): { center: THREE.Vector3; radius: number } {
  const box = new THREE.Box3();
  for (const p of prepared) {
    const [x, z] = p.geometry.center;
    const r = p.geometry.footprintRadius;
    box.expandByPoint(new THREE.Vector3(x - r, p.groundY, z - r));
    box.expandByPoint(new THREE.Vector3(x + r, p.groundY + p.geometry.top, z + r));
  }
  if (box.isEmpty()) return { center: new THREE.Vector3(), radius: 300 };

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // Margen para el arbolado del borde, que también proyecta.
  const radius = size.length() / 2 + 40;
  return { center, radius };
}

function Sun({
  bounds,
  isNight = false,
}: {
  bounds: { center: THREE.Vector3; radius: number };
  isNight?: boolean;
}) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const { center, radius } = bounds;

  // El sol apunta al centro de los volúmenes, no al origen: el campus está descentrado
  // respecto a su bbox, y apuntar a [0,0,0] desperdicia parte del mapa de sombras.
  const position: [number, number, number] = [
    center.x - radius * 0.8,
    radius * 1.25,
    center.z + radius * 0.55,
  ];

  useEffect(() => {
    const light = ref.current;
    if (!light) return;

    // El `target` por defecto de DirectionalLight es un Object3D suelto que NO está en
    // el grafo de la escena, así que nadie le actualiza la matriz. Hay que hacerlo a
    // mano; si no, la luz apunta al origen pase lo que pase con `target.position`.
    light.target.position.copy(center);
    light.target.updateMatrixWorld();

    // El ortho de sombra por defecto es de ±5 unidades. Sobre un campus de 600 m
    // eso significa que solo un parche de 10 m proyecta sombra.
    const cam = light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;

    // near/far ceñidos a la esfera. Con proyección ortográfica la profundidad es
    // lineal, así que no gana tanta precisión como ganaría en perspectiva, pero evita
    // gastar rango de profundidad en vacío delante y detrás del campus.
    const distance = light.position.distanceTo(center);
    cam.near = Math.max(distance - radius, 1);
    cam.far = distance + radius;
    cam.updateProjectionMatrix();
  }, [center, radius]);

  return (
    <directionalLight
      ref={ref}
      position={position}
      intensity={isNight ? 0.85 : 2.3}
      color={isNight ? "#9fc2f0" : "#fff6e8"}
      castShadow
      // 4096² sobre un ortho de ~740 m da ~18 cm por texel, frente a los ~29 cm de
      // antes. Es lo que permite bajar el normalBias sin que aparezca acné.
      shadow-mapSize={[4096, 4096]}
      shadow-bias={-0.0004}
      // Era 0.6, o sea 60 cm de desplazamiento en la búsqueda de la sombra: suficiente
      // para despegarla visiblemente del pie de cada muro. Con el doble de resolución
      // se puede bajar y recuperar la sombra de contacto.
      shadow-normalBias={0.12}
    />
  );
}

function Ground({
  data,
  radius,
  isNight = false,
}: {
  data: CampusData;
  radius: number;
  isNight?: boolean;
}) {
  const geometry = useMemo(() => {
    const flat = buildCampusGround(data.campusOutline);
    const g = drapeGeometry(flat);
    flat.dispose();
    return g;
  }, [data.campusOutline]);
  const plate = useMemo(() => buildGroundPlate(), []);
  const outline = useMemo(() => {
    // Se subdivide el contorno para que la línea siga la ladera y no la corte.
    const raw = campusOutlinePoints(data.campusOutline, 0.6);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      const n = Math.max(1, Math.ceil(a.distanceTo(b) / 10));
      for (let k = 0; k < n; k++) {
        const p = a.clone().lerp(b, k / n);
        pts.push(p.setY(0.6 + groundY(p.x, p.z)));
      }
    }
    if (pts.length) pts.push(pts[0].clone());
    return pts;
  }, [data.campusOutline]);

  useEffect(
    () => () => {
      geometry.dispose();
      plate.top.dispose();
      plate.skirt.dispose();
    },
    [geometry, plate],
  );

  return (
    <group>
      {/* Contexto urbano dentro del rectángulo: terreno con el relieve real y costados
          hasta un zócalo, como una maqueta recortada por las vías. Va nivelado con la
          rasante de las calles para que las manzanas no queden flotando. */}
      <mesh geometry={plate.top} receiveShadow>
        <meshStandardMaterial color={isNight ? "#141c26" : "#323b35"} roughness={1} />
      </mesh>
      <mesh geometry={plate.skirt} receiveShadow>
        <meshStandardMaterial
          color={isNight ? "#151a20" : "#4a4138"}
          roughness={1}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Superficie del campus, recortada con su contorno oficial (way/40739535).
          Tono neutro a propósito: el verde solo aparece donde OSM lo mapea (ver
          lib/terrain.ts). Se apoya sobre el relieve igual que las vías y las zonas. */}
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial color={isNight ? "#212a23" : "#4e564b"} roughness={1} />
      </mesh>

      <Line
        points={outline}
        color={isNight ? "#3a6042" : "#7fa88a"}
        lineWidth={1.5}
        transparent
        opacity={0.55}
      />
    </group>
  );
}

/**
 * Encuadre suave hacia el edificio enfocado. Trabaja sobre el target de OrbitControls
 * y conserva la distancia y el ángulo actuales del usuario, en vez de teletransportar
 * la cámara a una pose fija.
 */
function CameraRig({ focus, radius }: { focus: Focus | null; radius: number }) {
  const controls = useThree((s) => s.controls) as
    | (THREE.EventDispatcher & { target: THREE.Vector3; update: () => void })
    | null;
  const camera = useThree((s) => s.camera);

  const anim = useRef<{
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startCam: THREE.Vector3;
    endCam: THREE.Vector3;
    startTime: number;
    duration: number;
  } | null>(null);

  const lastId = useRef<string | null>(null);

  // Cancela la animación inmediatamente si el usuario mueve o arrastra la cámara manualmente
  useEffect(() => {
    if (!controls) return;
    const onStart = () => {
      anim.current = null;
    };
    (controls as any).addEventListener("start", onStart);
    return () => {
      (controls as any).removeEventListener("start", onStart);
    };
  }, [controls]);

  useEffect(() => {
    if (!focus) {
      anim.current = null;
      lastId.current = null;
      return;
    }
    if (focus.id === lastId.current) return;
    lastId.current = focus.id;

    if (!controls) return;

    const startTarget = controls.target.clone();
    const endTarget = new THREE.Vector3(...focus.position);

    const goalDistance = THREE.MathUtils.clamp(
      focus.extent * 3.2,
      55,
      radius * 1.6,
    );

    const offset = camera.position.clone().sub(startTarget);
    const direction = offset.length() > 1e-4 ? offset.normalize() : new THREE.Vector3(1, 1, 1).normalize();

    // Ángulo mínimo sobre el horizonte para no atravesar fachadas
    const elevation = Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
    if (elevation < MIN_FOCUS_ELEVATION) {
      const azimuth = Math.atan2(direction.x, direction.z);
      const cos = Math.cos(MIN_FOCUS_ELEVATION);
      direction.set(
        Math.sin(azimuth) * cos,
        Math.sin(MIN_FOCUS_ELEVATION),
        Math.cos(azimuth) * cos,
      );
    }

    const endCam = endTarget.clone().add(direction.multiplyScalar(goalDistance));

    anim.current = {
      startTarget,
      endTarget,
      startCam: camera.position.clone(),
      endCam,
      startTime: performance.now(),
      duration: 800,
    };
  }, [focus, radius, controls, camera]);

  useFrame(() => {
    if (!anim.current || !controls) return;

    const { startTarget, endTarget, startCam, endCam, startTime, duration } = anim.current;
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Deceleración cúbica suave (ease-out)
    const ease = 1 - Math.pow(1 - progress, 3);

    controls.target.lerpVectors(startTarget, endTarget, ease);
    camera.position.lerpVectors(startCam, endCam, ease);
    controls.update();

    if (progress >= 1) {
      anim.current = null;
    }
  });

  return null;
}

/**
 * Compensa la barra lateral: sin esto el campus se centra en el canvas completo y queda
 * parcialmente tapado, porque 288 px de la izquierda están cubiertos por la lista.
 * `setViewOffset` desplaza la proyección, así que el raycasting sigue siendo coherente.
 */
function SidebarViewOffset({ left }: { left: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  useEffect(() => {
    const w = Math.round(size.width);
    const h = Math.round(size.height);
    if (w === 0 || h === 0) return;
    camera.setViewOffset(w, h, -left / 2, 0, w, h);
    camera.updateProjectionMatrix();
    return () => {
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [camera, size.width, size.height, left]);

  return null;
}

/** ~32°. Ángulo mínimo sobre el horizonte al que se sitúa la cámara al enfocar. */
const MIN_FOCUS_ELEVATION = 0.56;

export type Focus = {
  id: string;
  position: [number, number, number];
  /** Media diagonal de la huella del objetivo; determina a qué distancia encuadrar. */
  extent: number;
};

export type SceneProps = {
  data: CampusData;
  terrain: TerrainData;
  places: PlacesData;
  /**
   * La geometría se prepara fuera del Canvas: es matemática de BufferGeometry, no
   * necesita contexto WebGL. Así la lista lateral y el buscador funcionan aunque la
   * GPU falle, en vez de quedarse vacíos esperando a que monte la escena.
   */
  prepared: PreparedBuilding[];
  selectedId: string | null;
  hoveredId: string | null;
  showLabels: boolean;
  showTrees: boolean;
  showAccesses: boolean;
  showServices: boolean;
  isNight?: boolean;
  focus: Focus | null;
  /** Ancho en px que la barra lateral tapa del canvas. */
  sidebarWidth: number;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
};

export function Scene({
  data,
  terrain,
  places,
  prepared,
  selectedId,
  hoveredId,
  showLabels,
  showTrees,
  showAccesses,
  showServices,
  isNight = false,
  focus,
  sidebarWidth,
  onSelect,
  onHover,
}: SceneProps) {
  const radius = Math.max(data.meta.widthM, data.meta.depthM) / 2;
  const bounds = useMemo(() => castingBounds(prepared), [prepared]);

  useEffect(() => {
    setNightMode(Boolean(isNight));
  }, [isNight]);

  const bgColor = isNight ? "#080f1a" : "#96b4d6";

  return (
    <>
      <color attach="background" args={[bgColor]} />
      {/* La niebla arranca más allá del campus completo: da profundidad sin ocultarlo. */}
      <fog
        attach="fog"
        args={[bgColor, radius * 2.2, isNight ? radius * 6.5 : radius * 7.2]}
      />

      <EnvironmentLighting />
      <hemisphereLight
        args={
          isNight
            ? ["#1b293d", "#0c141d", 0.5]
            : ["#ffffff", "#6e6250", 0.95]
        }
      />
      <Sun bounds={bounds} isNight={isNight} />

      <Ground data={data} radius={radius} isNight={isNight} />

      {/* Senderos, plazas, canchas y arbolado. Va después del suelo base y antes de
          los volúmenes: son superficies planas escalonadas en Y (ver lib/terrain.ts). */}
      <Terrain terrain={terrain} showTrees={showTrees} />

      <Buildings
        prepared={prepared}
        selectedId={selectedId}
        onSelect={onSelect}
        onHover={onHover}
      />

      <Places
        places={places}
        showAccesses={showAccesses}
        showServices={showServices}
      />

      <Labels
        prepared={prepared}
        selectedId={selectedId}
        hoveredId={hoveredId}
        showLabels={showLabels}
        campusRadius={radius}
        sidebarWidth={sidebarWidth}
      />

      <CameraRig focus={focus} radius={radius} />
      <SidebarViewOffset left={sidebarWidth} />

      <OrbitControls
        makeDefault
        // Paneo habilitado: un campus de 600 m no se explora orbitando un punto fijo.
        enablePan
        screenSpacePanning={false}
        minDistance={25}
        // radius*5 dejaba alejarse hasta ~1,5 km, donde el campus era una mancha
        // diminuta flotando en el vacío. radius*3 (~885 m) es lo justo para verlo
        // entero sin que sobre pantalla.
        maxDistance={radius * 3}
        // Un pelo por encima del horizonte, para no meter la cámara bajo el terreno.
        maxPolarAngle={Math.PI / 2 - 0.04}
        // Centro del rectángulo recortado (z = -norte) y a media altura del relieve.
        target={[0, 25, 50]}
      />
    </>
  );
}
