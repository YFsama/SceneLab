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

// User-defined tools, persisted to localStorage (the viewBookmarks pattern):
// a preference, not document state — the library survives reloads and New
// scene without touching the project fingerprint. Access is guarded so the
// module imports cleanly in non-DOM contexts.
const STORAGE_KEY = 'scenelab.customTools';

const persist = (tools: ToolDefinition[]): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tools));
  } catch {
    // Quota/security errors: the in-memory list stays authoritative.
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const TOOL_TYPES: readonly ToolDefinition['type'][] = ['endmill', 'ballmill', 'vbit', 'drill'];
const TOOL_MATERIALS: readonly ToolDefinition['material'][] = ['carbide', 'hss', 'cobalt'];

/** Defensive shape check (a corrupted payload degrades to fewer tools, never
 *  a crash downstream) — the same contract as the generator's ToolDefinition. */
export const isToolDefinition = (v: unknown): v is ToolDefinition =>
  isRecord(v) &&
  typeof v.id === 'string' && v.id.length > 0 &&
  typeof v.name === 'string' && v.name.length > 0 &&
  TOOL_TYPES.includes(v.type as ToolDefinition['type']) &&
  TOOL_MATERIALS.includes(v.material as ToolDefinition['material']) &&
  ['diameter', 'fluteLength', 'overallLength', 'flutes'].every(
    (k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && (v[k] as number) > 0,
  );

/** Boot state: the persisted list, validated entry by entry. */
const loadPersisted = (): ToolDefinition[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isToolDefinition);
  } catch {
    return [];
  }
};

const customTools: ToolDefinition[] = loadPersisted();

export function getAllTools(): ToolDefinition[] {
  return [...defaultTools, ...customTools];
}

/** The user-defined tools only (the editor list; defaults are immutable). */
export function getCustomTools(): ToolDefinition[] {
  return [...customTools];
}

/** Test/maintenance hook: drop every custom tool (also clears storage). */
export function clearCustomTools(): void {
  customTools.length = 0;
  persist(customTools);
}

export function getTool(id: string): ToolDefinition | undefined {
  return getAllTools().find((t) => t.id === id);
}

export function addCustomTool(tool: ToolDefinition): void {
  // Upsert by id so re-adding (e.g. editing) a tool replaces it instead of
  // accumulating duplicates that shadow each other in getTool/getAllTools.
  const idx = customTools.findIndex((t) => t.id === tool.id);
  if (idx !== -1) customTools[idx] = tool;
  else customTools.push(tool);
  persist(customTools);
}

export function removeCustomTool(id: string): void {
  const idx = customTools.findIndex((t) => t.id === id);
  if (idx !== -1) {
    customTools.splice(idx, 1);
    persist(customTools);
  }
}
