"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { groundUnderFootprint, padYFor } from "@/lib/elevation";
import { buildBuildingGeometry, type BuildingGeometry } from "@/lib/geometry";
import { highlightMaterial, materialsFor } from "@/lib/materials";
import type { Building } from "@/lib/types";

export type PreparedBuilding = {
  building: Building;
  geometry: BuildingGeometry;
  materials: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** cota del terreno sobre la que se apoya el volumen */
  groundY: number;
};

/** Construye geometría y materiales una sola vez para todo el dataset. */
export function usePreparedBuildings(buildings: Building[]): PreparedBuilding[] {
  const prepared = useMemo(() => {
    const out: PreparedBuilding[] = [];
    for (const building of buildings) {
      const geometry = buildBuildingGeometry(building);
      if (!geometry) continue;
      out.push({
        building,
        geometry,
        materials: materialsFor(building),
        // Bajo la plataforma nivelada; 0,3 m hundido para que el muro no deje rendija.
        groundY:
          (padYFor(building.id) ??
            groundUnderFootprint(geometry.center[0], geometry.center[1], geometry.footprintRadius)) -
          0.3,
      });
    }
    return out;
  }, [buildings]);

  useEffect(() => {
    return () => {
      for (const p of prepared) {
        p.geometry.body.dispose();
        p.geometry.roof?.dispose();
      }
    };
  }, [prepared]);

  return prepared;
}

type Props = {
  prepared: PreparedBuilding[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
};

export function Buildings({ prepared, selectedId, onSelect, onHover }: Props) {
  // Un único clon resaltado, recreado solo cuando cambia la selección.
  const highlight = useMemo(() => {
    const target = prepared.find((p) => p.building.id === selectedId);
    if (!target) return null;
    return [highlightMaterial(target.materials[0]), highlightMaterial(target.materials[1])] as [
      THREE.MeshStandardMaterial,
      THREE.MeshStandardMaterial,
    ];
  }, [prepared, selectedId]);

  useEffect(() => {
    return () => {
      highlight?.[0].dispose();
      highlight?.[1].dispose();
    };
  }, [highlight]);

  return (
    <group>
      {prepared.map(({ building, geometry, materials, groundY }) => {
        const isSelected = building.id === selectedId;
        const mats = isSelected && highlight ? highlight : materials;

        return (
          <group
            key={building.id}
            position={[0, groundY, 0]}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(building.id);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              // En táctil no hay "salir": el hover se quedaría pegado hasta otro toque.
              if (e.pointerType === "touch") return;
              onHover(building.id);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              onHover(null);
            }}
          >
            {/* El z-fighting de los `building:part` contra su envolvente se resuelve
                con polygonOffset en el material (ver lib/materials.ts). */}
            <mesh geometry={geometry.body} material={mats} castShadow receiveShadow />
            {geometry.roof && (
              <mesh geometry={geometry.roof} material={mats} castShadow receiveShadow />
            )}
          </group>
        );
      })}
    </group>
  );
}
