import { describe, it, expect } from 'vitest';
import {
  DETAIL_RADIUS_MM,
  DETAIL_SCALE,
  detailLabel,
  detailTitle,
  layoutDetailPanels,
  detailPointToSheet,
  makeDetailId,
  makeNoteId,
  nextDetailLetter,
  type DrawingDetail,
} from './drawingNotes';

describe('detail ids and letters', () => {
  it('default radius is ~25mm at 2x magnification', () => {
    expect(DETAIL_RADIUS_MM).toBe(25);
    expect(DETAIL_SCALE).toBe(2);
  });

  it('generates unique note and detail ids', () => {
    const noteIds = new Set(Array.from({ length: 50 }, () => makeNoteId()));
    const detailIds = new Set(Array.from({ length: 50 }, () => makeDetailId()));
    expect(noteIds.size).toBe(50);
    expect(detailIds.size).toBe(50);
  });

  it('letters increment A, B, … Z, AA', () => {
    expect(detailLabel(0)).toBe('A');
    expect(detailLabel(1)).toBe('B');
    expect(detailLabel(2)).toBe('C');
    expect(detailLabel(25)).toBe('Z');
    expect(detailLabel(26)).toBe('AA');
    expect(detailLabel(27)).toBe('AB');
  });

  it('the next detail gets the next free letter', () => {
    const mk = (i: number): DrawingDetail => ({
      id: `d${i}`,
      viewIndex: 0,
      center: { x: 0, y: 0 },
      radius: 10,
      scale: 2,
    });
    expect(nextDetailLetter([])).toBe('A');
    expect(nextDetailLetter([mk(0)])).toBe('B');
    expect(nextDetailLetter([mk(0), mk(1)])).toBe('C');
  });

  it('formats titles like "DETAIL A (2:1)"', () => {
    expect(detailTitle('A', 2)).toBe('DETAIL A (2:1)');
    expect(detailTitle('B', 2.5)).toBe('DETAIL B (2.5:1)');
    expect(detailTitle('C', 1.69)).toBe('DETAIL C (1.7:1)');
  });
});

describe('layoutDetailPanels', () => {
  const cellW = 400;
  const cellH = 300;

  it('returns no strip without details', () => {
    const { panels, stripHeight } = layoutDetailPanels([], 800, 600, cellW, cellH);
    expect(panels).toEqual([]);
    expect(stripHeight).toBe(0);
  });

  it('honours the requested magnification when the panel fits', () => {
    // sourceScale 1 px/mm, 25mm circle at 2x → 50px radius, under the 135px cap.
    const { panels, stripHeight } = layoutDetailPanels(
      [{ scale: 2, radius: 25, sourceScale: 1 }],
      800,
      600,
      cellW,
      cellH,
    );
    expect(panels).toHaveLength(1);
    const p = panels[0]!;
    expect(p.rPx).toBeCloseTo(50, 6);
    expect(p.effectiveScale).toBeCloseTo(2, 6);
    expect(p.letter).toBe('A');
    expect(p.title).toBe('DETAIL A (2:1)');
    // Circle sits below the base sheet with room for its label.
    expect(p.cy).toBeGreaterThan(600);
    expect(p.cy + p.rPx).toBeLessThanOrEqual(600 + stripHeight);
    expect(stripHeight).toBeGreaterThan(0);
  });

  it('caps oversized panels and reports the reduced magnification', () => {
    // 25mm at 6 px/mm × 2 = 300px wanted → capped at 135px → effective 0.9.
    const { panels } = layoutDetailPanels(
      [{ scale: 2, radius: 25, sourceScale: 6 }],
      800,
      600,
      cellW,
      cellH,
    );
    const p = panels[0]!;
    expect(p.rPx).toBeCloseTo(135, 6);
    expect(p.effectiveScale).toBeCloseTo(0.9, 6);
    expect(p.title).toBe('DETAIL A (0.9:1)');
  });

  it('letters panels A, B and wraps rows past two per row', () => {
    const input = { scale: 2, radius: 25, sourceScale: 6 }; // always capped → 135px
    const { panels, stripHeight } = layoutDetailPanels(
      [input, input, input],
      800,
      600,
      cellW,
      cellH,
    );
    expect(panels.map((p) => p.letter)).toEqual(['A', 'B', 'C']);
    // perRow = floor(800 / 294) = 2 → two rows.
    expect(panels[0]!.cy).toBeLessThan(panels[2]!.cy);
    expect(stripHeight).toBeGreaterThan(panels[1]!.cy + panels[1]!.rPx - 600);
  });

  it('skips details without a source view but keeps original indices', () => {
    const { panels } = layoutDetailPanels(
      [
        { scale: 2, radius: 25, sourceScale: 1 },
        { scale: 2, radius: 25, sourceScale: 0 }, // stale viewIndex
        { scale: 2, radius: 25, sourceScale: 1 },
      ],
      800,
      600,
      cellW,
      cellH,
    );
    expect(panels).toHaveLength(2);
    expect(panels[0]!.detailIndex).toBe(0);
    expect(panels[1]!.detailIndex).toBe(2);
    // Letters follow rendered order, so no letter is burned on the gap.
    expect(panels.map((p) => p.letter)).toEqual(['A', 'B']);
  });
});

describe('detailPointToSheet', () => {
  const panel = { cx: 400, cy: 500, rPx: 50, sourceScale: 1, effectiveScale: 2, detailIndex: 0, letter: 'A', title: 'DETAIL A (2:1)' };

  it('maps the crop centre to the panel centre', () => {
    expect(detailPointToSheet({ x: 10, y: -5 }, { x: 10, y: -5 }, panel)).toEqual({ x: 400, y: 500 });
  });

  it('scales offsets by sourceScale × magnification with y flipped', () => {
    // +x in model goes right; +y in model goes UP, which is minus sheet y.
    expect(detailPointToSheet({ x: 15, y: 0 }, { x: 10, y: -5 }, panel)).toEqual({ x: 410, y: 490 });
    expect(detailPointToSheet({ x: 10, y: 0 }, { x: 10, y: -5 }, panel)).toEqual({ x: 400, y: 490 });
  });
});
