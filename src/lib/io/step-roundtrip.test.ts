import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { importSTEP } from './stepImport';
import { occtMeshToSolidBody } from './stepOCCT';
import { createBox, createCylinder, createSphere, computeVolume } from '../geometry/brep';
import { translateBody } from '../geometry/operations';
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
});
