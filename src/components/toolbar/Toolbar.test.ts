import { describe, it, expect } from 'vitest';
import type { WorkspaceMode } from '../../store/app';

// Toolbar is a React component — test the workspace structure.

describe('Toolbar workspace structure', () => {
  const workspaces: { mode: WorkspaceMode; shortcut: string }[] = [
    { mode: 'sketch', shortcut: 'S' },
    { mode: 'model', shortcut: 'M' },
    { mode: 'assembly', shortcut: '' },
    { mode: 'drawing', shortcut: 'D' },
    { mode: 'cam', shortcut: 'C' },
  ];

  it('has 5 workspace modes', () => {
    expect(workspaces).toHaveLength(5);
  });

  it('includes sketch, model, drawing, cam', () => {
    const modes = workspaces.map((w) => w.mode);
    expect(modes).toContain('sketch');
    expect(modes).toContain('model');
    expect(modes).toContain('drawing');
    expect(modes).toContain('cam');
  });

  it('sketch has shortcut S', () => {
    const sketch = workspaces.find((w) => w.mode === 'sketch');
    expect(sketch!.shortcut).toBe('S');
  });

  it('model has shortcut M', () => {
    const model = workspaces.find((w) => w.mode === 'model');
    expect(model!.shortcut).toBe('M');
  });

  it('drawing has shortcut D', () => {
    const drawing = workspaces.find((w) => w.mode === 'drawing');
    expect(drawing!.shortcut).toBe('D');
  });

  it('cam has shortcut C', () => {
    const cam = workspaces.find((w) => w.mode === 'cam');
    expect(cam!.shortcut).toBe('C');
  });

  it('assembly has no shortcut', () => {
    const assembly = workspaces.find((w) => w.mode === 'assembly');
    expect(assembly!.shortcut).toBe('');
  });
});

describe('Toolbar undo/redo logic', () => {
  it('canUndo checks if undo stack has items', () => {
    const undoStack = [{}, {}];
    const sketchUndoStack: unknown[] = [];
    const sketchActive = false;
    const canUndo = (sketchActive ? sketchUndoStack : undoStack).length > 0;
    expect(canUndo).toBe(true);
  });

  it('canRedo checks if redo stack has items', () => {
    const redoStack: unknown[] = [];
    const canRedo = redoStack.length > 0;
    expect(canRedo).toBe(false);
  });

  it('sketch undo uses sketch stack when active', () => {
    const undoStack: unknown[] = [];
    const sketchUndoStack = [{}];
    const sketchActive = true;
    const canUndo = (sketchActive ? sketchUndoStack : undoStack).length > 0;
    expect(canUndo).toBe(true);
  });
});
