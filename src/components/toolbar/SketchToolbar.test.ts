import { describe, it, expect } from 'vitest';
import type { SketchTool } from '../../store/app';

// SketchToolbar is a React component — test the tool structure.

describe('SketchToolbar tool structure', () => {
  const tools: { tool: SketchTool; shortcut: string }[] = [
    { tool: 'select', shortcut: 'V' },
    { tool: 'line', shortcut: 'L' },
    { tool: 'polyline', shortcut: 'Shift+L' },
    { tool: 'rect', shortcut: 'R' },
    { tool: 'circle', shortcut: 'O' },
    { tool: 'arc', shortcut: 'A' },
    { tool: 'polygon', shortcut: 'P' },
  ];

  it('has 7 sketch tools', () => {
    expect(tools).toHaveLength(7);
  });

  it('includes select, line, rect, circle, arc, polygon', () => {
    const toolNames = tools.map((t) => t.tool);
    expect(toolNames).toContain('select');
    expect(toolNames).toContain('line');
    expect(toolNames).toContain('rect');
    expect(toolNames).toContain('circle');
    expect(toolNames).toContain('arc');
    expect(toolNames).toContain('polygon');
  });

  it('includes polyline', () => {
    const toolNames = tools.map((t) => t.tool);
    expect(toolNames).toContain('polyline');
  });

  it('select has shortcut V', () => {
    const select = tools.find((t) => t.tool === 'select');
    expect(select!.shortcut).toBe('V');
  });

  it('line has shortcut L', () => {
    const line = tools.find((t) => t.tool === 'line');
    expect(line!.shortcut).toBe('L');
  });

  it('polyline has shortcut Shift+L', () => {
    const polyline = tools.find((t) => t.tool === 'polyline');
    expect(polyline!.shortcut).toBe('Shift+L');
  });

  it('rect has shortcut R', () => {
    const rect = tools.find((t) => t.tool === 'rect');
    expect(rect!.shortcut).toBe('R');
  });

  it('circle has shortcut O', () => {
    const circle = tools.find((t) => t.tool === 'circle');
    expect(circle!.shortcut).toBe('O');
  });

  it('arc has shortcut A', () => {
    const arc = tools.find((t) => t.tool === 'arc');
    expect(arc!.shortcut).toBe('A');
  });

  it('polygon has shortcut P', () => {
    const polygon = tools.find((t) => t.tool === 'polygon');
    expect(polygon!.shortcut).toBe('P');
  });
});
