import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { importSTEP } from './stepImport';
import { occtMeshToSolidBody, stepNeedsExactKernel } from './stepOCCT';
import {
  createBox,
  createCylinder,
  createSphere,
  computeVolume,
  buildEdgesFromFaces,
  adaptiveSegments,
} from '../geometry/brep';
import { translateBody } from '../geometry/operations';
import { warmUpBooleanEngine, booleanOpManifold } from '../geometry/booleanManifold';
import type { Face, SolidBody, Vec3 } from '../geometry/types';
import type { OcctImportApi } from 'occt-import-js';

/**
 * The STEP export oracle, in three layers:
 *
 * 1. Always-on structural tests (below) — parse our own file text and prove
 *    the exact defects the kernel audit found cannot regress: the canonical
 *    SHAPE_DEFINITION_REPRESENTATION → ADVANCED_BREP_SHAPE_REPRESENTATION →
 *    MANIFOLD_SOLID_BREP chain, unit-length DIRECTIONs, FACE_OUTER_BOUND
 *    wiring per face, and loops that close.
 * 2. Always-on round trips through our own faceted importer (stepImport.ts).
 * 3. An OPT-IN round trip through the real occt-import-js WASM kernel
 *    (run with SCENELAB_OCCT_UNIT=1). Unit tests never fetch the ~7 MB wasm
 *    by default, mirroring the stepOCCT.ts test-seam convention — the
 *    always-on real-kernel coverage lives in the browser e2e suite
 *    (e2e/step-roundtrip.spec.ts), which loads the same chunk the curved
 *    STEP import flow uses.
 */

/** Parse the DATA section into id → { type, args } (top-level arg split). */
function parseEntities(step: string): Map<number, { type: string; args: string[] }> {
  const splitTop = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) out.push(cur.trim());
    return out;
  };
  const out = new Map<number, { type: string; args: string[] }>();
  const re = /#(\d+)=([A-Z0-9_]+)\s*\(([^;]*)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step)) !== null) {
    out.set(Number(m[1]!), { type: m[2]!, args: splitTop(m[3]!) });
  }
  return out;
}

/** `#123` → 123; anything else → null. */
const refId = (arg: string): number | null => {
  const m = /^#(\d+)$/.exec(arg);
  return m ? Number(m[1]) : null;
};

/** ids inside a `(#1,#2,...)` list argument. */
const refList = (arg: string): number[] =>
  arg
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((s) => refId(s.trim()))
    .filter((n): n is number => n !== null);

describe('STEP export: OCCT structural contract', () => {
  const box = createBox(10, 10, 10);
  const step = exportSTEP(box);
  const ents = parseEntities(step);

  it('SDR chains the product definition shape to the advanced B-rep representation', () => {
    const sdr = [...ents.values()].find((e) => e.type === 'SHAPE_DEFINITION_REPRESENTATION')!;
    expect(refId(sdr.args[0]!)).not.toBeNull();
    const pds = ents.get(refId(sdr.args[0]!)!)!;
    expect(pds.type).toBe('PRODUCT_DEFINITION_SHAPE');
    const absr = ents.get(refId(sdr.args[1]!)!)!;
    expect(absr.type).toBe('ADVANCED_BREP_SHAPE_REPRESENTATION');
    // ...which holds the solid and references the mm geometric context.
    const msbId = refList(absr.args[1]!)[0]!;
    expect(ents.get(msbId)!.type).toBe('MANIFOLD_SOLID_BREP');
    expect(absr.args[2]).toMatch(/^#\d+$/); // a context entity (complex, unparsed here)
  });

  it('the product chain resolves PRODUCT → formation → definition → shape', () => {
    const pdEntry = [...ents.entries()].find(([, e]) => e.type === 'PRODUCT_DEFINITION')!;
    const pd = pdEntry[1];
    const formation = ents.get(refId(pd.args[2]!)!)!;
    expect(formation.type).toBe('PRODUCT_DEFINITION_FORMATION');
    const product = ents.get(refId(formation.args[2]!)!)!;
    expect(product.type).toBe('PRODUCT');
    expect(product.args[0]).toBe(`'Box'`);
    const pds = [...ents.values()].find((e) => e.type === 'PRODUCT_DEFINITION_SHAPE')!;
    expect(refId(pds.args[2]!)).toBe(pdEntry[0]); // PDS → PD closes the chain
  });

  it('every ADVANCED_FACE has exactly one FACE_OUTER_BOUND wired to an EDGE_LOOP', () => {
    const faces = [...ents.values()].filter((e) => e.type === 'ADVANCED_FACE');
    expect(faces.length).toBe(box.faces.length);
    for (const f of faces) {
      const bounds = refList(f.args[1]!);
      expect(bounds).toHaveLength(1);
      const bound = ents.get(bounds[0]!)!;
      expect(bound.type).toBe('FACE_OUTER_BOUND');
      const loop = ents.get(refId(bound.args[1]!)!)!;
      expect(loop.type).toBe('EDGE_LOOP');
      // The loop has at least 3 oriented edges and sits on a PLANE surface.
      expect(refList(loop.args[1]!).length).toBeGreaterThanOrEqual(3);
      const surface = ents.get(refId(f.args[2]!)!)!;
      expect(surface.type).toBe('PLANE');
    }
  });

  it('every EDGE_LOOP closes: consecutive oriented edges share vertices', () => {
    // EDGE_CURVE id → [vertex ids]
    const edgeVerts = new Map<number, [number, number]>();
    for (const [eid, e] of ents) {
      if (e.type === 'EDGE_CURVE') {
        const v1 = refId(e.args[1]!)!;
        const v2 = refId(e.args[2]!)!;
        edgeVerts.set(eid, [v1, v2]);
      }
    }
    const loops = [...ents.values()].filter((e) => e.type === 'EDGE_LOOP');
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) {
      const oes = refList(loop.args[1]!);
      let prevEnd: number | null = null;
      let firstStart: number | null = null;
      for (const oeId of oes) {
        const oe = ents.get(oeId!)!;
        expect(oe.type).toBe('ORIENTED_EDGE');
        const edgeId = refId(oe.args[3]!)!;
        const [a, b] = edgeVerts.get(edgeId)!;
        const forward = oe.args[4] !== '.F.';
        const start = forward ? a : b;
        const end = forward ? b : a;
        if (prevEnd !== null) expect(start).toBe(prevEnd);
        if (firstStart === null) firstStart = start;
        prevEnd = end;
      }
      expect(prevEnd).toBe(firstStart); // closed cycle
    }
  });

  it('all DIRECTION entities are unit length', () => {
    const dirs = [...ents.values()].filter((e) => e.type === 'DIRECTION');
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const coords = d.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
      expect(Math.hypot(coords[0]!, coords[1]!, coords[2]!)).toBeCloseTo(1, 5);
    }
  });

  it('VECTOR magnitudes equal the distance between their LINE endpoints', () => {
    // VERTEX_POINT id → coordinates (via its CARTESIAN_POINT).
    const verts = new Map<number, [number, number, number]>();
    for (const [eid, e] of ents) {
      if (e.type === 'VERTEX_POINT') {
        const ptId = refId(e.args[1]!)!;
        const pt = ents.get(ptId)!;
        const c = pt.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
        verts.set(eid, [c[0]!, c[1]!, c[2]!]);
      }
    }
    let checked = 0;
    for (const [, e] of ents) {
      if (e.type !== 'EDGE_CURVE') continue;
      const [v1, v2] = [refId(e.args[1]!)!, refId(e.args[2]!)!];
      const line = ents.get(refId(e.args[3]!)!)!;
      const vec = ents.get(refId(line.args[2]!)!)!;
      const mag = Number(vec.args[2]);
      const p1 = verts.get(v1)!;
      const p2 = verts.get(v2)!;
      expect(mag).toBeCloseTo(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]), 4);
      checked++;
    }
    // A box has 24 loop segments but exactly 12 UNIQUE shared edges.
    expect(checked).toBe(12);
  });
});

describe('STEP export → our importer round trip', () => {
  it('box: faces, volume and name survive', () => {
    const back = importSTEP(exportSTEP(createBox(10, 20, 30)), 'Box');
    expect(back.name).toBe('Box');
    expect(back.faces).toHaveLength(6);
    expect(computeVolume(back)).toBeCloseTo(6000, 3);
  });

  it('cylinder: faceted volume survives exactly', () => {
    const cyl = createCylinder(5, 12, 16);
    const back = importSTEP(exportSTEP(cyl));
    expect(back.faces).toHaveLength(cyl.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(cyl), 3);
  });

  it('sphere: faceted volume survives exactly', () => {
    const sphere = createSphere(5, 16);
    const back = importSTEP(exportSTEP(sphere));
    expect(back.faces).toHaveLength(sphere.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(sphere), 3);
  });

  it('translated body keeps its position', () => {
    const moved = translateBody(createBox(10, 10, 10), { x: 100, y: 5, z: -20 });
    const back = importSTEP(exportSTEP(moved));
    const xs = back.vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(95, 3);
    expect(Math.max(...xs)).toBeCloseTo(105, 3);
  });

  it('apostrophes and non-ASCII in body names are escaped safely', () => {
    const box = createBox(10, 10, 10);
    box.name = "O'Brien's 部品";
    const text = exportSTEP(box);
    // The literal is quoted with '' escapes; re-import recovers the ASCII part.
    expect(text).toContain("'O''Brien''s __'");
    const back = importSTEP(text);
    expect(back.name).toBe("O'Brien's __");
  });
});

// ---------------------------------------------------------------------------
// Analytic cylinders (Face.source — see step.test.ts for the double
// builders' rationale; they are duplicated here because test files cannot
// import each other without double-registering their suites).

/** Local widening of Face carrying the documented `source` tag. */
type TaggedFace = Face & { source?: { kind: 'cylinder'; origin: Vec3; axis: Vec3; radius: number } };

function ringPoints(radius: number, y: number, count: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
  }
  return pts;
}

const bodyOf = (name: string, faces: Face[]): SolidBody => ({
  id: `body_${name}`,
  name,
  vertices: faces.flatMap((f) => f.vertices),
  faces,
  edges: buildEdgesFromFaces(faces),
});

/** An ISOLATED ⌀6 wall band (no face shares its rims) → canonical tube form. */
function isolatedBand(radius = 3, height = 20): SolidBody {
  const n = adaptiveSegments(radius * 2);
  const wall: TaggedFace = {
    id: 'wall',
    vertices: [...ringPoints(radius, 0, n), ...ringPoints(radius, height, n)],
    normal: { x: 1, y: 0, z: 0 },
    source: { kind: 'cylinder', origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius },
  };
  return bodyOf('Band', [wall]);
}

/** A tube the way the landed classifier shapes it: 55 tagged wall facets + 2 caps. */
function facetedTube(radius = 3, height = 20): SolidBody {
  const n = adaptiveSegments(radius * 2);
  const p = (a: number, y: number): Vec3 => ({ x: Math.cos(a) * radius, y, z: Math.sin(a) * radius });
  const wall: TaggedFace[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    wall.push({
      id: `facet_${i}`,
      vertices: [p(a0, 0), p(a1, 0), p(a1, height), p(a0, height)],
      normal: { x: Math.cos(mid), y: 0, z: Math.sin(mid) },
      source: { kind: 'cylinder', origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius },
    });
  }
  const bottom = ringPoints(radius, 0, n);
  const top = ringPoints(radius, height, n);
  const capB: TaggedFace = { id: 'capB', vertices: [...bottom].reverse(), normal: { x: 0, y: -1, z: 0 } };
  const capT: TaggedFace = { id: 'capT', vertices: top, normal: { x: 0, y: 1, z: 0 } };
  return bodyOf('Tube', [...wall, capB, capT]);
}

/**
 * A real Manifold drilled box with the wall tags applied by hand — the
 * production classifier tags these in fromManifold now, but the explicit
 * tags keep this writer test independent of classifier changes. Box spans
 * y∈[0,20] (createExtrude is 0-based along +Y), so the un-translated ⌀6
 * cylinder spanning y∈[0,22] cuts fully through.
 */
function manifoldDrilledBox(): SolidBody {
  const raw = booleanOpManifold(createBox(20, 20, 20), createCylinder(3, 22), 'difference');
  expect(raw).not.toBeNull();
  for (const f of raw!.faces) {
    if (Math.abs(f.normal.y) < 0.1 && f.vertices.every((v) => Math.abs(Math.hypot(v.x, v.z) - 3) < 0.01)) {
      (f as TaggedFace).source = { kind: 'cylinder', origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius: 3 };
    }
  }
  return raw!;
}

describe('STEP export: analytic cylinder structural contract', () => {
  const text = exportSTEP(isolatedBand());
  const ents = parseEntities(text);

  it('every EDGE_CURVE — closed CIRCLEs included — carries VERTEX_POINT refs', () => {
    // This is the shape our faceted importer walks; the closed circle edges
    // (start = end vertex) keep it parsing without touching curve geometry.
    const edges = [...ents.values()].filter((e) => e.type === 'EDGE_CURVE');
    expect(edges).toHaveLength(3); // 2 circles + 1 seam
    for (const e of edges) {
      expect(ents.get(refId(e.args[1]!)!)?.type).toBe('VERTEX_POINT');
      expect(ents.get(refId(e.args[2]!)!)?.type).toBe('VERTEX_POINT');
    }
  });

  it('all DIRECTIONs are unit length on analytic exports too', () => {
    const dirs = [...ents.values()].filter((e) => e.type === 'DIRECTION');
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const coords = d.args[1]!.replace(/^\(|\)$/g, '').split(',').map(Number);
      expect(Math.hypot(coords[0]!, coords[1]!, coords[2]!)).toBeCloseTo(1, 5);
    }
  });

  it('every EDGE_LOOP closes — the seam/circle cycle chains like any other', () => {
    const edgeVerts = new Map<number, [number, number]>();
    for (const [eid, e] of ents) {
      if (e.type === 'EDGE_CURVE') {
        edgeVerts.set(eid, [refId(e.args[1]!)!, refId(e.args[2]!)!]);
      }
    }
    const loops = [...ents.values()].filter((e) => e.type === 'EDGE_LOOP');
    expect(loops.length).toBe(1);
    for (const loop of loops) {
      const oes = refList(loop.args[1]!);
      expect(oes).toHaveLength(4); // circle, seam, circle, seam
      let prevEnd: number | null = null;
      let firstStart = 0;
      for (const oeId of oes) {
        const oe = ents.get(oeId!)!;
        const [a, b] = edgeVerts.get(refId(oe.args[3]!)!)!;
        const forward = oe.args[4] !== '.F.';
        const start = forward ? a : b;
        const end = forward ? b : a;
        if (prevEnd !== null) expect(start).toBe(prevEnd);
        if (prevEnd === null) firstStart = start;
        prevEnd = end;
      }
      expect(prevEnd).toBe(firstStart);
    }
  });
});

describe('STEP export → our importer round trip (analytic cylinders)', () => {
  it('drilled tube: faceted wall facets + caps round-trip exactly', () => {
    // Shared rims keep the chord boundary, so the whole body stays LINE
    // edges and our polygon importer recovers it one-to-one.
    const tube = facetedTube();
    const text = exportSTEP(tube);
    expect(stepNeedsExactKernel(text)).toBe(true); // CYLINDRICAL_SURFACE routes the UI import through OCCT
    const back = importSTEP(text);
    expect(back.name).toBe('Tube');
    expect(back.faces).toHaveLength(tube.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(tube), 3);
  });

  it('an isolated band export has no polygon for the faceted parser (exact-kernel only)', () => {
    const text = exportSTEP(isolatedBand());
    expect(stepNeedsExactKernel(text)).toBe(true);
    // The band's only loop is the two closed circles; their two seam
    // vertices collapse below the 3-point polygon minimum.
    expect(() => importSTEP(text)).toThrow(/No faceted faces/);
  });

  it('the same tube stripped of tags round-trips fully faceted (control)', () => {
    const tube = facetedTube();
    for (const f of tube.faces) delete (f as TaggedFace).source;
    const back = importSTEP(exportSTEP(tube));
    expect(back.faces).toHaveLength(tube.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(tube), 3);
  });
});

// ---------------------------------------------------------------------------
// Opt-in: the REAL occt-import-js kernel (the same WASM the browser loads on
// curved STEP imports). Skipped unless SCENELAB_OCCT_UNIT is set:
//
//   SCENELAB_OCCT_UNIT=1 npx vitest run src/lib/io/step-roundtrip.test.ts
//
// This exercises the kernel directly rather than through importSTEPAuto's
// dispatcher seam (__setExactStepLoaderForTests): our exports are planar, so
// the dispatcher would never route them to the exact loader by design. The
// dispatcher itself is covered in stepOCCT.test.ts.
const RUN_REAL_OCCT = !!process.env.SCENELAB_OCCT_UNIT;

describe.skipIf(!RUN_REAL_OCCT)('STEP export → real OCCT kernel (opt-in)', () => {
  it('occt-import-js parses our export and tessellates it with sane volume', async () => {
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const nodeRequire = createRequire(import.meta.url);
    type OcctFactory = (opts: { wasmBinary: Uint8Array }) => Promise<OcctImportApi>;
    const factory = nodeRequire('occt-import-js') as OcctFactory;
    // Hand the wasm to Emscripten directly: under jsdom the module would
    // otherwise try to fetch() it like a browser would.
    const wasmPath = nodeRequire.resolve('occt-import-js/dist/occt-import-js.wasm');
    const occt = await factory({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });

    for (const body of [createBox(10, 10, 10), createCylinder(5, 10, 16), createSphere(5, 16)]) {
      const bytes = new TextEncoder().encode(exportSTEP(body));
      const result = occt.ReadStepFile(bytes, {
        linearUnit: 'millimeter',
        linearDeflectionType: 'absolute_value',
        linearDeflection: 0.1,
        angularDeflection: 0.5,
      });
      expect(result.success).toBe(true);
      const nodes = result.meshes.filter((m) => (m.index?.array?.length ?? 0) >= 3);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      const solids = nodes.map((m) =>
        occtMeshToSolidBody({ positions: m.attributes.position.array, indices: m.index.array }, body.name),
      );
      for (const solid of solids) {
        expect(solid.faces.length).toBeGreaterThan(0);
        // All faces are planar, so OCCT's tessellation reproduces the faceted
        // volume essentially exactly.
        expect(computeVolume(solid)).toBeCloseTo(computeVolume(body), 1);
      }
    }
  }, 120_000);

  it('occt-import-js parses the ANALYTIC cylinder exports as single exact solids', async () => {
    const { createRequire } = await import('node:module');
    const { readFileSync } = await import('node:fs');
    const nodeRequire = createRequire(import.meta.url);
    type OcctFactory = (opts: { wasmBinary: Uint8Array }) => Promise<OcctImportApi>;
    const factory = nodeRequire('occt-import-js') as OcctFactory;
    const wasmPath = nodeRequire.resolve('occt-import-js/dist/occt-import-js.wasm');
    const occt = await factory({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });

    const read = (text: string) => {
      const result = occt.ReadStepFile(new TextEncoder().encode(text), {
        linearUnit: 'millimeter',
        linearDeflectionType: 'absolute_value',
        linearDeflection: 0.01,
        angularDeflection: 0.3,
      });
      expect(result.success).toBe(true);
      return result.meshes
        .filter((m) => (m.index?.array?.length ?? 0) >= 3)
        .map((m) =>
          occtMeshToSolidBody({ positions: m.attributes.position.array, indices: m.index.array }, 'analytic'),
        );
    };

    // (a) Shared-rim form (the real drilled-solid path): facets on one
    // shared CYLINDRICAL_SURFACE with the caps' chord edges. Must come back
    // as ONE solid with the exact faceted volume — the CIRCLE form would
    // split the shell here (measured: 3 solids, +11.8% volume).
    await warmUpBooleanEngine();
    const drilled = manifoldDrilledBox();
    const drilledText = exportSTEP(drilled);
    expect((drilledText.match(/CYLINDRICAL_SURFACE/g) ?? []).length).toBe(1);
    expect((drilledText.match(/CIRCLE\(/g) ?? []).length).toBe(0);
    const solids = read(drilledText);
    expect(solids).toHaveLength(1);
    expect(computeVolume(solids[0]!)).toBeCloseTo(computeVolume(drilled), 1);

    // (b) Isolated band (the CIRCLE tube form): the real kernel parses the
    // closed CIRCLE edge curves and tessellates the true cylinder.
    const bandSolids = read(exportSTEP(isolatedBand()));
    expect(bandSolids.length).toBeGreaterThanOrEqual(1);
    expect(bandSolids[0]!.faces.length).toBeGreaterThan(0);
  }, 120_000);
});
