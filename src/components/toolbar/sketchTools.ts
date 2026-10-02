import { MousePointer2, Minus, Square, Circle, CircleDot, Hexagon } from 'lucide-react';
import type { SketchTool } from '../../store/app';

/** Sketch draw-tool table shared by SketchToolbar (rendering) and its test. */
export const SKETCH_TOOLS: { tool: SketchTool; icon: typeof MousePointer2; shortcut: string }[] = [
  { tool: 'select', icon: MousePointer2, shortcut: 'V' },
  { tool: 'line', icon: Minus, shortcut: 'L' },
  { tool: 'rect', icon: Square, shortcut: 'R' },
  { tool: 'circle', icon: Circle, shortcut: 'O' },
  { tool: 'arc', icon: CircleDot, shortcut: 'A' },
  { tool: 'polygon', icon: Hexagon, shortcut: 'P' },
];
