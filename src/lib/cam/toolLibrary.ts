import type { ToolDefinition } from './types';

const defaultTools: ToolDefinition[] = [
  {
    id: 'em-6mm',
    name: '6mm End Mill',
    type: 'endmill',
    diameter: 6,
    fluteLength: 20,
    overallLength: 60,
    flutes: 3,
    material: 'carbide',
  },
  {
    id: 'em-3mm',
    name: '3mm End Mill',
    type: 'endmill',
    diameter: 3,
    fluteLength: 12,
    overallLength: 50,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'em-1mm',
    name: '1mm End Mill',
    type: 'endmill',
    diameter: 1,
    fluteLength: 6,
    overallLength: 40,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'bm-6mm',
    name: '6mm Ball Mill',
    type: 'ballmill',
    diameter: 6,
    fluteLength: 18,
    overallLength: 60,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'bm-3mm',
    name: '3mm Ball Mill',
    type: 'ballmill',
    diameter: 3,
    fluteLength: 10,
    overallLength: 50,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'vbit-60deg',
    name: '60° V-Bit',
    type: 'vbit',
    diameter: 12,
    fluteLength: 10,
    overallLength: 50,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'vbit-90deg',
    name: '90° V-Bit',
    type: 'vbit',
    diameter: 12,
    fluteLength: 8,
    overallLength: 50,
    flutes: 2,
    material: 'carbide',
  },
  {
    id: 'drill-3mm',
    name: '3mm Drill',
    type: 'drill',
    diameter: 3,
    fluteLength: 30,
    overallLength: 60,
    flutes: 2,
    material: 'hss',
  },
  {
    id: 'drill-5mm',
    name: '5mm Drill',
    type: 'drill',
    diameter: 5,
    fluteLength: 40,
    overallLength: 75,
    flutes: 2,
    material: 'hss',
  },
];

const customTools: ToolDefinition[] = [];

export function getAllTools(): ToolDefinition[] {
  return [...defaultTools, ...customTools];
}

export function getTool(id: string): ToolDefinition | undefined {
  return getAllTools().find((t) => t.id === id);
}

export function addCustomTool(tool: ToolDefinition): void {
  customTools.push(tool);
}

export function removeCustomTool(id: string): void {
  const idx = customTools.findIndex((t) => t.id === id);
  if (idx !== -1) customTools.splice(idx, 1);
}
