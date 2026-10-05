import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { createBox, createCylinder, createSphere } from '../geometry/brep';

/** Parse the DATA section into id → { type, args } (single nesting level). */
function parseEntities(step: string): Map<number, { type: string; args: string[] }> {
  // Split an argument list at top-level commas (parens/quotes aware).
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

describe('exportSTEP', () => {
  it('produces a valid STEP file header', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('HEADER');
    expect(step).toContain('FILE_DESCRIPTION');
    expect(step).toContain('FILE_SCHEMA');
    expect(step).toContain('ENDSEC');
    expect(step).toContain('END-ISO-10303-21');
  });

  it('contains CARTESIAN_POINT entities for vertices', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('CARTESIAN_POINT');
    expect(step).toContain('VERTEX_POINT');
  });

  it('contains ADVANCED_FACE entities for faces', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    expect(step).toContain('PLANE');
  });

  it('contains EDGE_CURVE and ORIENTED_EDGE', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('EDGE_CURVE');
    expect(step).toContain('ORIENTED_EDGE');
    expect(step).toContain('EDGE_LOOP');
  });

  it('includes the body name in the product', () => {
    const box = createBox(10, 10, 10);
    box.name = 'TestPart';
    const step = exportSTEP(box);
    expect(step).toContain('TestPart');
  });

  it('has correct entity count for a box (6 faces)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Count ADVANCED_FACE entities — should be 6 for a box.
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBe(6);
  });

  it('contains AXIS2_PLACEMENT_3D for each face plane', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const axisCount = (step.match(/AXIS2_PLACEMENT_3D/g) ?? []).length;
    expect(axisCount).toBe(6); // one per face
  });

  it('has the canonical OCCT shape chain (SDR → ABSR → MSB)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('SHAPE_DEFINITION_REPRESENTATION');
    expect(step).toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
    expect(step).toContain('MANIFOLD_SOLID_BREP');
  });

  it('has the product chain APPLICATION_PROTOCOL_DEFINITION → PRODUCT → PDF → PD → PDS', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('APPLICATION_PROTOCOL_DEFINITION');
    expect(step).toContain('PRODUCT_DEFINITION_FORMATION');
    expect(step).toContain('PRODUCT_DEFINITION_SHAPE');
  });

  it('contains LINE entities for edges', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('LINE');
  });

  it('contains DIRECTION entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('DIRECTION');
  });

  it('contains VECTOR entities', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    expect(step).toContain('VECTOR');
  });

  it('produces valid file structure with DATA section', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const lines = step.split('\n');
    expect(lines[0]).toBe('ISO-10303-21;');
    expect(step).toContain('HEADER;');
    expect(step).toContain('DATA;');
    expect(step).toContain('ENDSEC;');
    expect(step).toContain('END-ISO-10303-21;');
  });

  it('has valid entity references (no dangling #N)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    // Extract all entity definitions (#N=...).
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      defined.add(parseInt(match[1]!));
    }
    // Extract all entity references (#N).
    const refs = new Set<number>();
    const refUsePattern = /#(\d+)/g;
    while ((match = refUsePattern.exec(step)) !== null) {
      refs.add(parseInt(match[1]!));
    }
    // All referenced entities should be defined.
    for (const r of refs) {
      expect(defined.has(r)).toBe(true);
    }
  });

  it('has consistent entity count (no duplicates)', () => {
    const box = createBox(10, 10, 10);
    const step = exportSTEP(box);
    const defined = new Set<number>();
    const refPattern = /#(\d+)=/g;
    let match;
    while ((match = refPattern.exec(step)) !== null) {
      const eid = parseInt(match[1]!);
      expect(defined.has(eid)).toBe(false); // no duplicate definitions
      defined.add(eid);
    }
    expect(defined.size).toBeGreaterThan(10); // reasonable entity count
  });

  it('exports a cylinder with valid structure', () => {
    const cyl = createCylinder(5, 10, 16);
    const step = exportSTEP(cyl);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6); // cylinder has more faces than box
  });

  it('exports a sphere with valid structure', () => {
    const sphere = createSphere(5, 16);
    const step = exportSTEP(sphere);
    expect(step).toContain('ISO-10303-21');
    expect(step).toContain('ADVANCED_FACE');
    expect(step).toContain('CLOSED_SHELL');
    const faceCount = (step.match(/ADVANCED_FACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(6);
  });

  it('all exported bodies have valid entity references', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const step = exportSTEP(make());
      const defined = new Set<number>();
      const defPattern = /#(\d+)=/g;
      let m;
      while ((m = defPattern.exec(step)) !== null) defined.add(parseInt(m[1]!));
      const refPattern = /#(\d+)/g;
      while ((m = refPattern.exec(step)) !== null) {
        expect(defined.has(parseInt(m[1]!))).toBe(true);
      }
    }
  });

  // ---- OCCT structural contract (the defects the kernel audit found) ------

  it('every DIRECTION is unit length (OCCT rejects non-unit directions)', () => {
    for (const make of [() => createBox(10, 10, 10), () => createCylinder(5, 10, 16), () => createSphere(5, 16)]) {
      const step = exportSTEP(make());
      const dirRe = /DIRECTION\('',\(([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\)\)/g;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = dirRe.exec(step)) !== null) {
        const len = Math.hypot(Number(m[1]), Number(m[2]), Number(m[3]));
        expect(len).toBeCloseTo(1, 5);
        count++;
      }
      expect(count).toBeGreaterThan(0);
    }
  });

  it('every ADVANCED_FACE bounds through a FACE_OUTER_BOUND → EDGE_LOOP', () => {
    const ents = parseEntities(exportSTEP(createBox(10, 10, 10)));
    const faces = [...ents.values()].filter((e) => e.type === 'ADVANCED_FACE');
    expect(faces).toHaveLength(6);
    for (const f of faces) {
      // bounds tuple arrives as one arg like (#12)
      const bounds = f.args[1]!.replace(/^\(|\)$/g, '').split(',').map((s) => Number(s.replace('#', '')));
      expect(bounds).toHaveLength(1);
      const bound = ents.get(bounds[0]!)!;
      expect(bound.type).toBe('FACE_OUTER_BOUND');
      const loop = ents.get(Number(bound.args[1]!.replace('#', '')))!;
      expect(loop.type).toBe('EDGE_LOOP');
    }
  });

  it('MANIFOLD_SOLID_BREP references the CLOSED_SHELL which lists every face', () => {
    const ents = parseEntities(exportSTEP(createBox(10, 10, 10)));
    const msb = [...ents.values()].find((e) => e.type === 'MANIFOLD_SOLID_BREP')!;
    expect(msb.args[0]).toBe(`'Box'`);
    const shell = ents.get(Number(msb.args[1]!.replace('#', '')))!;
    expect(shell.type).toBe('CLOSED_SHELL');
    const shellFaces = shell.args[1]!.replace(/^\(|\)$/g, '').split(',').map((s) => Number(s.replace('#', '')));
    const allFaces = [...ents.entries()].filter(([, e]) => e.type === 'ADVANCED_FACE').map(([i]) => i);
    expect(shellFaces.sort((a, b) => a - b)).toEqual(allFaces.sort((a, b) => a - b));
  });

  it('ADVANCED_BREP_SHAPE_REPRESENTATION carries the geometric unit context', () => {
    const step = exportSTEP(createBox(10, 10, 10));
    const ents = parseEntities(step);
    const absr = [...ents.values()].find((e) => e.type === 'ADVANCED_BREP_SHAPE_REPRESENTATION')!;
    // items (#N) and context (#M)
    const msbId = Number(absr.args[1]!.replace(/^\(|\)$/g, '').replace('#', ''));
    expect(ents.get(msbId)!.type).toBe('MANIFOLD_SOLID_BREP');
    const ctxId = absr.args[2]!.replace('#', '');
    // The context is the complex GEOMETRIC_REPRESENTATION_CONTEXT entity —
    // not captured by the simple parser, so assert on the raw text.
    const ctxRe = new RegExp(`#${ctxId}=\\(GEOMETRIC_REPRESENTATION_CONTEXT\\(3\\)`);
    expect(ctxRe.test(step)).toBe(true);
  });

  it('every AXIS2_PLACEMENT_3D has an explicit axis and ref direction', () => {
    const step = exportSTEP(createBox(10, 10, 10));
    const axisRe = /AXIS2_PLACEMENT_3D\('',#(\d+),#(\d+),#(\d+)\);/g;
    const count = [...step.matchAll(axisRe)].length;
    expect(count).toBe(6); // one per face, none with a $ ref direction
  });
});
