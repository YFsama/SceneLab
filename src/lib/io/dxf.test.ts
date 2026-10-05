import { describe, it, expect } from 'vitest';
import { exportDXF, exportDXF3D, exportSheetDXF } from './dxf';
import { createBox, createCylinder, createSphere } from '../geometry/brep';
import { formatDimValue, projectBodies, viewTransform } from './drawing';

describe('exportDXF', () => {
  it('should start with SECTION HEADER', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('SECTION');
    expect(result).toContain('HEADER');
  });

  it('should end with EOF', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('EOF');
  });

  it('should contain LINE entities', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('LINE');
  });

  it('should contain ENTITIES section', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF(body);
    expect(result).toContain('ENTITIES');
  });
});

describe('exportDXF3D', () => {
  it('should contain 3DFACE entities', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    expect(result).toContain('3DFACE');
  });

  it('should start with SECTION and end with EOF', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    expect(result).toContain('SECTION');
    expect(result).toContain('EOF');
  });

  it('should contain coordinate data', () => {
    const body = createBox(2, 2, 2);
    const result = exportDXF3D(body);
    // Should have numeric coordinate values
    expect(result).toMatch(/\d+\.\d+/);
  });

  it('fan-triangulates n-gon faces instead of dropping vertices', () => {
    // A cylinder has two 32-gon caps. Writing only the first 4 vertices per
    // face would lose the caps; fan triangulation must emit (n-2) faces each.
    const segs = 32;
    const result = exportDXF3D(createCylinder(5, 10, segs));
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    // 2 caps × (32-2) tris + 32 quad side faces × 2 tris each = 60 + 64 = 124.
    const expected = 2 * (segs - 2) + segs * 2;
    expect(faceCount).toBe(expected);
  });

  it('exports a sphere with 3DFACE entities', () => {
    const sphere = createSphere(5, 16);
    const result = exportDXF3D(sphere);
    expect(result).toContain('3DFACE');
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(0);
  });

  it('exports a cylinder with 3DFACE entities', () => {
    const cyl = createCylinder(5, 10, 16);
    const result = exportDXF3D(cyl);
    expect(result).toContain('3DFACE');
    const faceCount = (result.match(/3DFACE/g) ?? []).length;
    expect(faceCount).toBeGreaterThan(0);
  });

  it('all 3DFACE entities have valid vertex data', () => {
    const box = createBox(10, 10, 10);
    const result = exportDXF3D(box);
    // Each 3DFACE should have numeric coordinates.
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.trim() === '3DFACE') {
        // Next few lines should be numeric coordinates.
        const idx = lines.indexOf(line);
        for (let i = idx + 1; i < idx + 13 && i < lines.length; i++) {
          const val = parseFloat(lines[i]!.trim());
          if (!isNaN(val)) {
            expect(Number.isFinite(val)).toBe(true);
          }
        }
      }
    }
  });
});

describe('exportDXF multi-body', () => {
  it('accepts an array and merges all entities', () => {
    const a = createBox(10, 10, 10);
    const b = createCylinder(5, 10, 16);
    const singleA = exportDXF(a);
    const singleB = exportDXF(b);
    const merged = exportDXF([a, b]);
    const countLines = (s: string) => (s.match(/\bLINE\b/g) ?? []).length;
    expect(countLines(merged)).toBe(countLines(singleA) + countLines(singleB));
    expect(merged).toContain('EOF');
  });

  it('single-body result matches the array form', () => {
    const box = createBox(10, 10, 10);
    expect(exportDXF(box)).toBe(exportDXF([box]));
  });

  it('defines the DASHED linetype it references (LTYPE table entry)', () => {
    // The HIDDEN layer names DASHED — without an LTYPE table entry R12
    // importers reject the file over the undefined linetype.
    const result = exportDXF(createBox(2, 2, 2));
    expect(result).toMatch(/0\r\nTABLE\r\n2\r\nLTYPE[\s\S]*?0\r\nLTYPE\r\n2\r\nDASHED\r\n/);
  });
});

// ---------------------------------------------------------------------------
// exportSheetDXF: the drawing sheet as true 2D CAD entities.
// ---------------------------------------------------------------------------

/** One parsed DXF entity: its type plus group-code → value props. */
interface DxfEntity {
  type: string;
  props: Record<string, string>;
}

/** Minimal DXF reader: walk (code, value) pairs, split on code 0. */
function parseDxfEntities(dxf: string): DxfEntity[] {
  const raw = dxf.split('\r\n');
  const entities: DxfEntity[] = [];
  let cur: DxfEntity | null = null;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const code = raw[i]!.trim();
    const value = raw[i + 1]!;
    if (code === '0') {
      if (cur) entities.push(cur);
      cur = { type: value.trim(), props: {} };
    } else if (cur) {
      cur.props[code] = value.trim();
    }
  }
  if (cur) entities.push(cur);
  return entities;
}

function entitiesOf(dxf: string, ...types: string[]): DxfEntity[] {
  return parseDxfEntities(dxf).filter((e) => types.includes(e.type));
}

describe('exportSheetDXF', () => {
  const cyl = createCylinder(5, 10, 32);
  // Top view (looking down the cylinder axis): the caps project as full
  // circles → detectCircles finds center marks. The front view is edge-on.
  const top = projectBodies([cyl], { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50, 'Top');
  const boxFront = projectBodies([createBox(10, 10, 10)], { x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, 50, 'Front');

  it('emits LINE entities for the view geometry on the OUTLINE layer', () => {
    const dxf = exportSheetDXF([boxFront]);
    const lines = entitiesOf(dxf, 'LINE').filter((e) => e.props['8'] === 'OUTLINE');
    expect(lines.length).toBeGreaterThanOrEqual(boxFront.lines.length);
  });

  it('emits CIRCLE entities for detected circles at the fitted sheet position (y-flipped)', () => {
    expect(top.centers?.length).toBeGreaterThan(0);
    const dxf = exportSheetDXF([top]);
    const circles = entitiesOf(dxf, 'CIRCLE');
    expect(circles.length).toBeGreaterThanOrEqual(top.centers!.length);
    const mark = top.centers![0]!;
    const tr = viewTransform(top, { x: 0, y: 0, w: 800, h: 600 });
    const sheet = tr.toSheet(mark);
    const match = circles.find(
      (e) =>
        Math.abs(Number(e.props['40']) - mark.radius * tr.scale) < 1e-3 &&
        Math.abs(Number(e.props['10']) - sheet.x) < 1e-3 &&
        Math.abs(Number(e.props['20']) - (600 - sheet.y)) < 1e-3,
    );
    expect(match).toBeDefined();
  });

  it('emits ARC entities with CCW start/end degrees for a sectioned cylinder cap', () => {
    // Top view of an X-sectioned cylinder: the cut cap fits to an open arc.
    const view = projectBodies(
      [cyl],
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      50,
      'Top — SECTION A-A',
      { normal: { x: 1, y: 0, z: 0 }, offset: 0 },
    );
    expect(view.arcs.length).toBeGreaterThan(0);
    const dxf = exportSheetDXF([view]);
    const arcs = entitiesOf(dxf, 'ARC');
    expect(arcs.length).toBeGreaterThanOrEqual(view.arcs.length);
    // DXF arcs sweep CCW from 50 to 51; view angles map 1:1 after the double
    // y-flip, CW view arcs (ccw === false) swap their endpoints.
    const arc = view.arcs[0]!;
    const ccw = arc.ccw !== false;
    const expStart = ((ccw ? arc.startAngle : arc.endAngle) * 180) / Math.PI;
    const expEnd = ((ccw ? arc.endAngle : arc.startAngle) * 180) / Math.PI;
    expect(Number(arcs[0]!.props['50'])).toBeCloseTo(expStart, 3);
    expect(Number(arcs[0]!.props['51'])).toBeCloseTo(expEnd, 3);
  });

  it('emits TEXT with the hole-callout string on the CALLOUT layer (⌀ → %%c)', () => {
    const dxf = exportSheetDXF([boxFront], 800, 600, {
      holeCallouts: [{ viewIndex: 0, center: { x: 0, y: 0 }, radius: 3 * 50, text: '⌀6×THRU' }],
    });
    const texts = entitiesOf(dxf, 'TEXT').filter((e) => e.props['8'] === 'CALLOUT');
    expect(texts.some((e) => e.props['1'] === '%%c6×THRU')).toBe(true);
  });

  it('defines the OUTLINE/CENTER/CALLOUT/NOTES/DIMENSIONS layers and the CENTER LTYPE', () => {
    const dxf = exportSheetDXF([boxFront]);
    const layers = [...dxf.matchAll(/0\r\nLAYER\r\n2\r\n(\w+)/g)].map((m) => m[1]!);
    for (const name of ['OUTLINE', 'CENTER', 'CALLOUT', 'NOTES', 'DIMENSIONS']) {
      expect(layers).toContain(name);
    }
    expect(dxf).toMatch(/0\r\nLTYPE\r\n2\r\nCENTER\r\n/);
    // Every entity's layer is defined in the table (or the 0 layer).
    for (const e of parseDxfEntities(dxf)) {
      if (['LINE', 'CIRCLE', 'ARC', 'TEXT', 'SOLID'].includes(e.type)) {
        expect([...layers, '0']).toContain(e.props['8']);
      }
    }
  });

  it('places dimension lines, SOLID arrowheads and the value TEXT on DIMENSIONS', () => {
    const dxf = exportSheetDXF([boxFront]);
    const ents = parseDxfEntities(dxf).filter((e) => e.props['8'] === 'DIMENSIONS');
    expect(ents.filter((e) => e.type === 'LINE').length).toBeGreaterThanOrEqual(3 * boxFront.dimensions.length);
    expect(ents.filter((e) => e.type === 'SOLID')).toHaveLength(2 * boxFront.dimensions.length);
    expect(
      ents.some((e) => e.type === 'TEXT' && e.props['1'] === formatDimValue(boxFront.dimensions[0]!.value)),
    ).toBe(true);
  });

  it('writes the cutting-plane trace: chain LINE + SOLID arrows + letter TEXT', () => {
    const view = projectBodies(
      [createBox(10, 10, 10)],
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
      50,
      'Front — SECTION A-A',
      { normal: { x: 1, y: 0, z: 0 }, offset: 0 },
    );
    const dxf = exportSheetDXF([view], 800, 600, {
      sectionCuts: [{ viewIndex: 0, coord: 0, screen: 'x', arrow: { x: -1, y: 0 }, label: 'A' }],
    });
    const ents = parseDxfEntities(dxf);
    expect(ents.filter((e) => e.type === 'TEXT' && e.props['1'] === 'A').length).toBeGreaterThanOrEqual(2);
    expect(ents.filter((e) => e.type === 'SOLID').length).toBeGreaterThanOrEqual(2);
    expect(ents.some((e) => e.type === 'LINE' && e.props['6'] === 'CENTER')).toBe(true);
  });

  it('writes the title block as a LINE frame + TEXT fields in the bottom-right corner', () => {
    const dxf = exportSheetDXF([boxFront], 800, 600, { titleBlock: { projectName: 'Parity Project' } });
    const texts = entitiesOf(dxf, 'TEXT');
    expect(texts.some((e) => e.props['1'] === 'Parity Project')).toBe(true);
    // The frame's right edge sits at 800 − 200 − 4 = 796 mm.
    const lines = entitiesOf(dxf, 'LINE');
    expect(lines.some((e) => Math.abs(Number(e.props['11']) - 796) < 1e-6)).toBe(true);
  });

  it('round-trips: balanced sections/tables, EOF last, numeric groups finite', () => {
    const dxf = exportSheetDXF([top], 800, 600, {
      notes: [{ id: 'dnote_1', x: 100, y: 80, text: 'Break all sharp edges' }],
      holeCallouts: [{ viewIndex: 0, center: { x: 0, y: 0 }, radius: 3 * 50, text: '⌀6×THRU' }],
      sectionCuts: [{ viewIndex: 0, coord: 0, screen: 'x', arrow: { x: -1, y: 0 }, label: 'A' }],
      titleBlock: { projectName: 'RoundTrip' },
    });
    const raw = dxf.split('\r\n');
    expect(raw[raw.length - 1]).toBe('EOF');
    const zeros = parseDxfEntities(dxf).filter((e) => e.type === 'SECTION' || e.type === 'ENDSEC');
    expect(zeros.filter((e) => e.type === 'SECTION')).toHaveLength(zeros.filter((e) => e.type === 'ENDSEC').length);
    const tabs = parseDxfEntities(dxf).filter((e) => e.type === 'TABLE' || e.type === 'ENDTAB');
    expect(tabs.filter((e) => e.type === 'TABLE')).toHaveLength(tabs.filter((e) => e.type === 'ENDTAB').length);
    for (const e of entitiesOf(dxf, 'LINE', 'CIRCLE', 'ARC')) {
      for (const code of ['10', '20', '40']) {
        if (e.props[code] !== undefined) expect(Number.isFinite(Number(e.props[code]))).toBe(true);
      }
    }
    expect(entitiesOf(dxf, 'TEXT').some((e) => e.props['1'] === 'Break all sharp edges')).toBe(true);
  });
});
