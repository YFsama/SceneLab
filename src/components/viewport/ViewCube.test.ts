import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ViewCube } from './ViewCube';
import { VIEWS } from './viewcubeViews';
import {
  ORIENTATIONS,
  FACE_DIRS,
  classifyHit,
  findOrientation,
  EDGE_THRESHOLD,
} from './viewcubeOrientations';
import { useStore } from '../../store/app';
import { translations } from '../../lib/i18n';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Both view components are data-driven — the tests import the real exported
// tables and logic so the components cannot drift from what is asserted here
// (previously this file re-declared the 26-orientation tables locally).

type Hit = NonNullable<ReturnType<typeof classifyHit>>;

function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

describe('ViewCube views', () => {
  it('offers all 7 ViewDirection values exactly once, in bar order', () => {
    expect(VIEWS.map((e) => e.dir)).toEqual(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso']);
    expect(new Set(VIEWS.map((e) => e.dir)).size).toBe(VIEWS.length);
  });

  it('every view carries a shortcut badge', () => {
    for (const entry of VIEWS) {
      expect(entry.shortcut, entry.dir).toBeTruthy();
    }
  });

  it('badges match the central hotkeys registered by initShortcuts (1 front, 2 top, 3 right, 4 iso, 5 back, 6 bottom, 7 left)', () => {
    const hotkeys: Record<string, string> = {
      front: '1', top: '2', right: '3', iso: '4', back: '5', bottom: '6', left: '7',
    };
    for (const entry of VIEWS) {
      expect(entry.shortcut, entry.dir).toBe(hotkeys[entry.dir]);
    }
  });

  it('every view has a label in both locales', () => {
    for (const { dir } of VIEWS) {
      const key = `viewport.${dir}`;
      expect(translations.en?.[key], key).toBeTruthy();
      expect(translations.zh?.[key], key).toBeTruthy();
    }
  });
});

describe('ViewCube orientations', () => {
  it('has 26 orientations: 6 faces + 12 edges + 8 corners', () => {
    expect(ORIENTATIONS).toHaveLength(26);
    // Classify by how many axes the (normalized) direction touches: a face
    // direction has one nonzero component, an edge two, a corner three.
    const axesTouched = (p: THREE.Vector3) =>
      [p.x, p.y, p.z].filter((c) => Math.abs(c) > 0.5).length;
    const faces = ORIENTATIONS.filter((o) => axesTouched(o.position) === 1);
    const edges = ORIENTATIONS.filter((o) => axesTouched(o.position) === 2);
    const corners = ORIENTATIONS.filter((o) => axesTouched(o.position) === 3);
    expect(faces).toHaveLength(6);
    expect(edges).toHaveLength(12);
    expect(corners).toHaveLength(8);
  });

  it('every position is a unit vector (buildOrientations normalizes)', () => {
    for (const o of ORIENTATIONS) {
      expect(o.position.length(), o.label).toBeCloseTo(1, 6);
    }
  });

  it('every up vector is unit and never parallel to the view direction (no degenerate camera)', () => {
    for (const o of ORIENTATIONS) {
      expect(o.up.length(), o.label).toBeCloseTo(1, 6);
      expect(Math.abs(o.position.dot(o.up)), o.label).toBeLessThan(1 - 1e-6);
    }
  });

  it('labels are unique', () => {
    const labels = ORIENTATIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('each face direction maps to its labeled axis normal', () => {
    const faceAxes: Record<string, [number, number, number]> = {
      Front: [0, 0, 1], Back: [0, 0, -1], Right: [1, 0, 0],
      Left: [-1, 0, 0], Top: [0, 1, 0], Bottom: [0, -1, 0],
    };
    const faces = ORIENTATIONS.filter(
      (o) => [o.position.x, o.position.y, o.position.z].filter((c) => Math.abs(c) > 0.5).length === 1,
    );
    expect(faces.map((o) => o.label).sort()).toEqual(Object.keys(faceAxes).sort());
    for (const o of faces) {
      const [x, y, z] = faceAxes[o.label]!;
      expect(o.position.distanceTo(v(x, y, z)), o.label).toBeCloseTo(0, 6);
    }
  });

  it('is closed under negation: every orientation has its mirror opposite (front↔back, right↔left, top↔bottom, …)', () => {
    for (const o of ORIENTATIONS) {
      const opposite = o.position.clone().negate();
      const match = ORIENTATIONS.find((other) => other.position.distanceTo(opposite) < 1e-6);
      expect(match, o.label).toBeDefined();
    }
  });
});

describe('ViewCube face geometry', () => {
  it('has 6 clickable faces labeled like the 6 face orientations', () => {
    expect(FACE_DIRS).toHaveLength(6);
    const faceOrientationLabels = new Set(
      ORIENTATIONS.filter(
        (o) => [o.position.x, o.position.y, o.position.z].filter((c) => Math.abs(c) > 0.5).length === 1,
      ).map((o) => o.label),
    );
    expect(new Set(FACE_DIRS.map((f) => f.label))).toEqual(faceOrientationLabels);
  });

  it('each face frame is right-handed: uDir × up = normal', () => {
    for (const f of FACE_DIRS) {
      const cross = new THREE.Vector3().crossVectors(f.uDir, f.up);
      expect(cross.distanceTo(f.normal), f.label).toBeCloseTo(0, 6);
      expect(f.normal.length(), f.label).toBeCloseTo(1, 6);
    }
  });

  it('each face normal and up match the orientation it snaps to (cube geometry ↔ orientation table consistency)', () => {
    for (const f of FACE_DIRS) {
      const ori = ORIENTATIONS.find((o) => o.label === f.label);
      expect(ori, f.label).toBeDefined();
      expect(f.normal.distanceTo(ori!.position), f.label).toBeCloseTo(0, 6);
      expect(f.up.distanceTo(ori!.up), f.label).toBeCloseTo(0, 6);
    }
  });
});

describe('ViewCube orientation lookup', () => {
  it('finds each of the 26 orientations from its own direction', () => {
    for (let i = 0; i < ORIENTATIONS.length; i++) {
      expect(findOrientation(ORIENTATIONS[i]!.position.clone()), ORIENTATIONS[i]!.label).toBe(i);
    }
  });

  it('snaps a slightly perturbed direction to the nearest face', () => {
    expect(findOrientation(v(0.05, 0.02, 1).normalize())).toBe(ORIENTATIONS.findIndex((o) => o.label === 'Front'));
    expect(findOrientation(v(-1, 0.02, 0.01).normalize())).toBe(ORIENTATIONS.findIndex((o) => o.label === 'Left'));
  });

  it('returns null for a direction far from all 26 orientations', () => {
    expect(findOrientation(v(0, 0, 0))).toBeNull();
    expect(findOrientation(v(1, 0.2, 0.2).normalize())).toBeNull();
  });
});

describe('ViewCube hit classification', () => {
  // Build a face mesh exactly the way buildCube does, so classifyHit runs
  // against the real geometry it sees in production.
  function buildFaceMesh(faceIndex: number): THREE.Mesh {
    const { normal } = FACE_DIRS[faceIndex]!;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    mesh.position.copy(normal).multiplyScalar(1);
    mesh.lookAt(mesh.position.clone().add(normal));
    mesh.userData = { faceIndex };
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  /** A raycast-equivalent hit at face-local UV (u, v), both in [-1, 1]. */
  function hitAt(mesh: THREE.Mesh, u: number, w: number): THREE.Intersection {
    return { object: mesh, point: mesh.localToWorld(new THREE.Vector3(u, w, 0)) } as unknown as THREE.Intersection;
  }

  function labelOf(result: Hit | null): string {
    expect(result).not.toBeNull();
    return ORIENTATIONS[result!.orientationIndex]!.label;
  }

  it('clicking the center of each of the 6 faces classifies as that face orientation', () => {
    for (let i = 0; i < FACE_DIRS.length; i++) {
      const mesh = buildFaceMesh(i);
      const result = classifyHit(hitAt(mesh, 0, 0));
      expect(result?.type, FACE_DIRS[i]!.label).toBe('face');
      expect(labelOf(result), FACE_DIRS[i]!.label).toBe(FACE_DIRS[i]!.label);
    }
  });

  it('clicking near an edge of the Front face classifies as the matching edge orientation', () => {
    const front = buildFaceMesh(0);
    // Local +u is the Front face's uDir (+X) → Front-Right.
    expect(classifyHit(hitAt(front, EDGE_THRESHOLD + 0.05, 0.3))?.type).toBe('edge');
    expect(labelOf(classifyHit(hitAt(front, EDGE_THRESHOLD + 0.05, 0.3)))).toBe('Front-Right');
    // Local +v is the Front face's up (+Y) → Front-Top.
    expect(labelOf(classifyHit(hitAt(front, 0.3, EDGE_THRESHOLD + 0.05)))).toBe('Front-Top');
    // Local −u → Front-Left.
    expect(labelOf(classifyHit(hitAt(front, -(EDGE_THRESHOLD + 0.05), 0.3)))).toBe('Front-Left');
  });

  it('clicking near a corner of the Front face classifies as the matching corner orientation', () => {
    const front = buildFaceMesh(0);
    const result = classifyHit(hitAt(front, EDGE_THRESHOLD + 0.1, EDGE_THRESHOLD + 0.1));
    expect(result?.type).toBe('corner');
    expect(labelOf(result)).toBe('Front-Right-Top');
    expect(labelOf(classifyHit(hitAt(front, -(EDGE_THRESHOLD + 0.1), EDGE_THRESHOLD + 0.1)))).toBe('Front-Left-Top');
  });

  it('the Back face maps local +u to world −X (lookAt orientation sign check)', () => {
    const back = buildFaceMesh(1); // Back: normal (0,0,-1), uDir (-1,0,0)
    expect(labelOf(classifyHit(hitAt(back, EDGE_THRESHOLD + 0.05, 0.3)))).toBe('Back-Left');
    expect(labelOf(classifyHit(hitAt(back, -(EDGE_THRESHOLD + 0.05), 0.3)))).toBe('Back-Right');
  });

  it('classifies just inside the threshold as face and just outside as edge', () => {
    const front = buildFaceMesh(0);
    expect(classifyHit(hitAt(front, EDGE_THRESHOLD - 0.01, 0.3))?.type).toBe('face');
    expect(classifyHit(hitAt(front, EDGE_THRESHOLD + 0.01, 0.3))?.type).toBe('edge');
  });

  it('returns null for a hit on an object without face metadata', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    mesh.updateMatrixWorld(true);
    expect(classifyHit(hitAt(mesh, 0, 0))).toBeNull();
  });
});

// --- Rendered coverage --------------------------------------------------------
// Same minimal mount harness the other component tests use (no testing-library
// in this project): render with createRoot inside act(), click the real button.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

async function mountCube(component: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
  });
  return { container, root };
}

async function unmountCube({ container, root }: Mounted): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

describe('ViewCube (rendered)', () => {
  beforeEach(() => {
    useStore.setState({ locale: 'en', viewDirection: 'iso', projection: 'perspective' });
  });

  function viewButton(container: HTMLElement, dir: string): HTMLButtonElement | null {
    const label = translations.en!['viewport.switchTo']!.replace('{view}', translations.en![`viewport.${dir}`]!);
    return container.querySelector(`button[aria-label="${label}"]`);
  }

  it('renders one button per view plus the projection toggle', async () => {
    const m = await mountCube(createElement(ViewCube));
    try {
      const group = m.container.querySelector('div[role="group"]');
      expect(group).not.toBeNull();
      const buttons = m.container.querySelectorAll('button');
      expect(buttons).toHaveLength(VIEWS.length + 1);
      for (const { dir } of VIEWS) {
        expect(viewButton(m.container, dir), dir).not.toBeNull();
      }
    } finally {
      await unmountCube(m);
    }
  });

  it('marks the current view as pressed and switches view direction on click', async () => {
    const m = await mountCube(createElement(ViewCube));
    try {
      const iso = viewButton(m.container, 'iso')!;
      const front = viewButton(m.container, 'front')!;
      expect(iso.getAttribute('aria-pressed')).toBe('true');
      expect(front.getAttribute('aria-pressed')).toBe('false');

      await act(async () => {
        front.click();
      });
      expect(useStore.getState().viewDirection).toBe('front');
      expect(front.getAttribute('aria-pressed')).toBe('true');
      expect(iso.getAttribute('aria-pressed')).toBe('false');
    } finally {
      await unmountCube(m);
    }
  });

  it('the projection button toggles perspective/orthographic', async () => {
    const m = await mountCube(createElement(ViewCube));
    try {
      const projection = m.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${translations.en!['viewport.projection']!}"]`,
      )!;
      expect(projection.textContent).toContain(translations.en!['viewport.perspective']!);
      await act(async () => {
        projection.click();
      });
      expect(useStore.getState().projection).toBe('orthographic');
      expect(projection.getAttribute('aria-pressed')).toBe('true');
      expect(projection.textContent).toContain(translations.en!['viewport.orthographic']!);
    } finally {
      await unmountCube(m);
    }
  });
});
