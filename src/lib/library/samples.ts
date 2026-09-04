// One-click starter projects for the welcome card (TinkerCAD "starters").
// Pure builders — orchestration (confirm/save/replace scene) lives in
// loadSample.ts so this module stays DOM- and store-free.
import { createBox, createCylinder } from '../geometry/brep';
import { translateBody } from '../geometry/operations';
import { booleanOp } from '../geometry/boolean';
import type { SolidBody } from '../geometry/types';
import { findLibraryPart } from './parts';

export interface SampleProject {
  id: string;
  /** Body count shown on the card; matches build().length. */
  build: () => SolidBody[];
}

const part = (id: string): SolidBody => {
  const p = findLibraryPart(id);
  if (!p) throw new Error(`Unknown library part: ${id}`);
  return p.build();
};

export const SAMPLE_PROJECTS: SampleProject[] = [
  {
    id: 'phoneStand',
    build: () => [
      { ...createBox(70, 6, 90), name: 'Stand base' },
      translateBody(createBox(70, 60, 6), { x: 0, y: 6, z: -42 }, 'Stand back'),
      translateBody(createBox(70, 6, 8), { x: 0, y: 6, z: 36 }, 'Stand lip'),
    ],
  },
  {
    id: 'penCup',
    build: () => {
      const outer = createCylinder(20, 90);
      const inner = translateBody(createCylinder(17, 86), { x: 0, y: 4, z: 0 });
      const cup = booleanOp(outer, inner, 'difference', 48);
      return [{ ...(cup ?? { ...createBox(40, 90, 40) }), name: 'Pen cup' }];
    },
  },
  {
    id: 'gearAssembly',
    build: () => [
      part('gear'),
      translateBody(part('rod'), { x: 40, y: 0, z: 0 }, 'Shaft'),
      translateBody(part('hexNut'), { x: -40, y: 0, z: 0 }),
    ],
  },
  {
    id: 'nameplate',
    build: () => [
      { ...createBox(80, 4, 24), name: 'Nameplate' },
      translateBody(createBox(6, 10, 26), { x: 37, y: 0, z: 0 }, 'Foot'),
      translateBody(createBox(6, 10, 26), { x: -37, y: 0, z: 0 }, 'Foot'),
    ],
  },
];

export function findSampleProject(id: string): SampleProject | undefined {
  return SAMPLE_PROJECTS.find((s) => s.id === id);
}
