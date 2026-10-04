import { describe, it, expect } from 'vitest';
import { holeCalloutText } from '../features/summary';
import { holeAnchor, holeKeptBySection, collectHoleCallouts, type CalloutViewFrame } from './drawingCallouts';
import { createHoleFeature } from '../features/tree';
import { exportDrawingSVG, projectBodies, viewRightAxis } from './drawing';
import { createBox } from '../geometry/brep';

const DOWN_HOLE = {
  center: { x: 2, y: 8, z: 1 },
  direction: { x: 0, y: -1, z: 0 },
  diameter: 6,
  depth: null,
} as const;

describe('holeCalloutText (shared GD&T formatting)', () => {
  // Mirrors the featureSummary hole cases (summary.test.ts), with the
  // localized through word instead of the timeline's ∞ glyph.
  it('formats thru/blind holes with the passed depth word', () => {
    expect(holeCalloutText(DOWN_HOLE, 'THRU')).toBe('⌀6×THRU');
    expect(holeCalloutText({ ...DOWN_HOLE, depth: 12.5 }, 'THRU')).toBe('⌀6×12.5');
    expect(holeCalloutText(DOWN_HOLE, '∞')).toBe('⌀6×∞');
    expect(holeCalloutText(DOWN_HOLE, '通孔')).toBe('⌀6×通孔');
  });

  it('appends counterbore/countersink annotations (⌴ preferred)', () => {
    expect(
      holeCalloutText(
        { ...DOWN_HOLE, depth: 12.5, counterbore: { diameter: 10, depth: 3 } },
        'THRU',
      ),
    ).toBe('⌀6×12.5 ⌴10×3');
    expect(
      holeCalloutText({ ...DOWN_HOLE, countersink: { diameter: 10, angleDeg: 90 } }, 'THRU'),
    ).toBe('⌀6×THRU ⌵10°90');
    expect(
      holeCalloutText(
        {
          ...DOWN_HOLE,
          counterbore: { diameter: 10, depth: 3 },
          countersink: { diameter: 12, angleDeg: 60 },
        },
        'THRU',
      ),
    ).toBe('⌀6×THRU ⌴10×3');
  });
});

describe('holeAnchor (projection + axis-on test)', () => {
  const SCALE = 50;

  it('a −Y hole is on-axis in the top view: center via the exact projection frame, radius = D/2·scale', () => {
    const viewDir = { x: 0, y: 1, z: 0 };
    const up = { x: 0, y: 0, z: -1 };
    const right = viewRightAxis(up, viewDir); // same frame projectBodies uses
    const a = holeAnchor(DOWN_HOLE, viewDir, right, up, SCALE);
    expect(a.axisOn).toBe(true);
    // p·right = x·1 = 2; p·up = z·(−1) = −1 (times scale).
    expect(a.center.x).toBeCloseTo(2 * SCALE, 9);
    expect(a.center.y).toBeCloseTo(-1 * SCALE, 9);
    expect(a.radius).toBeCloseTo(3 * SCALE, 9);
  });

  it('the same hole is off-axis (no callout) in the front and iso views', () => {
    const front = { dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
    const a = holeAnchor(DOWN_HOLE, front.dir, viewRightAxis(front.up, front.dir), front.up, SCALE);
    expect(a.axisOn).toBe(false);
    // Front view still anchors the center correctly (x, y of the model).
    expect(a.center.x).toBeCloseTo(2 * SCALE, 9);
    expect(a.center.y).toBeCloseTo(8 * SCALE, 9);
    const isoDir = { x: 0.577, y: 0.577, z: 0.577 };
    const isoUp = { x: 0, y: 1, z: 0 };
    const b = holeAnchor(DOWN_HOLE, isoDir, viewRightAxis(isoUp, isoDir), isoUp, SCALE);
    expect(b.axisOn).toBe(false); // |dot| = 0.577 < 0.95
  });
});

describe('holeKeptBySection (section-view culling)', () => {
  const section = { normal: { x: 1, y: 0, z: 0 }, offset: 0 };

  it('culls holes whose entry point is on the removed side, keeps the rest', () => {
    expect(holeKeptBySection({ ...DOWN_HOLE, center: { x: 2, y: 8, z: 1 } }, section)).toBe(false);
    expect(holeKeptBySection({ ...DOWN_HOLE, center: { x: -2, y: 8, z: 1 } }, section)).toBe(true);
    expect(holeKeptBySection({ ...DOWN_HOLE, center: { x: 0, y: 8, z: 1 } }, section)).toBe(true);
    expect(holeKeptBySection(DOWN_HOLE, undefined)).toBe(true);
  });
});

describe('collectHoleCallouts', () => {
  const frames: CalloutViewFrame[] = [
    { dir: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, scale: 50 }, // Front
    { dir: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 }, scale: 50 }, // Top
    { dir: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, scale: 50 }, // Right
    { dir: { x: 0.577, y: 0.577, z: 0.577 }, up: { x: 0, y: 1, z: 0 }, scale: 50 }, // Iso
  ];

  it('a −Y through hole gets exactly one callout, on the Top view', () => {
    const hole = createHoleFeature({ ...DOWN_HOLE }, []);
    const callouts = collectHoleCallouts([hole], frames, undefined, 'THRU');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.viewIndex).toBe(1); // Top
    expect(callouts[0]!.text).toBe('⌀6×THRU');
    expect(callouts[0]!.radius).toBeCloseTo(150, 9); // ⌀6 → r 3 × scale 50
  });

  it('skips suppressed holes and holes culled by the section', () => {
    const hole = createHoleFeature({ ...DOWN_HOLE }, []);
    expect(collectHoleCallouts([{ ...hole, suppressed: true }], frames, undefined, 'THRU')).toHaveLength(0);
    const section = { normal: { x: 1, y: 0, z: 0 }, offset: 0 };
    expect(collectHoleCallouts([hole], frames, section, 'THRU')).toHaveLength(0); // center x=2 removed
    const kept = createHoleFeature({ ...DOWN_HOLE, center: { x: -2, y: 8, z: 1 } }, []);
    expect(collectHoleCallouts([kept], frames, section, 'THRU')).toHaveLength(1);
  });

  it('SVG export renders the callout leader and text after the dims group', () => {
    const view = projectBodies([createBox(20, 10, 20)], frames[0]!.dir, frames[0]!.up, 50, 'Front');
    const svg = exportDrawingSVG([view], 800, 600, {
      holeCallouts: collectHoleCallouts(
        [createHoleFeature({ ...DOWN_HOLE, center: { x: 2, y: 8, z: 5 }, direction: { x: 0, y: 0, z: 1 } }, [])],
        [frames[0]!],
        undefined,
        'THRU',
      ),
    });
    expect(svg).toContain('⌀6×THRU');
    // Leader polyline (rim → elbow → shelf) plus text, in a group after the
    // red dimension group.
    expect(svg).toMatch(/<g stroke="#333"[^>]*>/);
    expect(svg).toMatch(/<path d="M[\d.-]+ [\d.-]+ L[\d.-]+ [\d.-]+ L[\d.-]+ [\d.-]+" fill="none" \/>/);
    expect(svg.indexOf('stroke="#333"')).toBeGreaterThan(svg.indexOf('stroke="red"'));
  });
});
