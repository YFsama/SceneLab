import type {
  Feature,
  SketchFeature,
  ExtrudeFeature,
  RevolveFeature,
  SweepFeature,
  LoftFeature,
  FilletFeature,
  ChamferFeature,
  ShellFeature,
  HoleFeature,
  ScaleFeature,
  LinearArrayFeature,
  CircularArrayFeature,
  MirrorFeature,
} from '../features/types';
import type { SolidBody, Vec3 } from '../geometry/types';
import type { SketchEntity, SketchConstraint } from '../sketch/types';
import type { PlaneDefinition } from '../geometry/types';
import type { AxisDefinition, PointDefinition, CoordinateSystemDefinition, AnnotationDefinition } from '../geometry/referenceGeometry';
import type { DrawingDetail, DrawingNote, DrawingSectionAxis } from './drawingNotes';
// Type-only imports: erased at runtime, so the io layer never pulls in the CAM
// generator stack — the shapes are the contract shared with lib/cam/setup.
import type { CAMSetup, CAMOperation } from '../cam/setup';
import type { CAMParameters } from '../cam/types';

/** Datum planes/axes/points/coordinate systems — plain serializable reference geometry. */
export interface SerializedReferenceGeometry {
  planes: PlaneDefinition[];
  axes: AxisDefinition[];
  points: PointDefinition[];
  coordSystems: CoordinateSystemDefinition[];
  annotations: AnnotationDefinition[];
}

/** Drawing-sheet state (drawing workspace): section axis, detail views, notes. */
export interface SerializedDrawing {
  sectionAxis: DrawingSectionAxis;
  details: DrawingDetail[];
  notes: DrawingNote[];
}

/**
 * CAM setup (cam workspace): stock + ordered operations, structurally the
 * live CAMSetup (pure data — no caches). The derived toolpath caches are NOT
 * serialized; they are regenerated from the operations after load.
 */
export type SerializedCam = CAMSetup;

export interface ProjectFile {
  version: number;
  name: string;
  features: SerializedFeature[];
  bodies: SerializedBody[];
  /** Full meshes of bodies created outside the feature tree (AI/imported). */
  directBodies?: SolidBody[];
  /** Datum planes/axes/points (reference geometry). */
  referenceGeometry?: SerializedReferenceGeometry;
  /** Drawing-sheet state (optional: older files predate it). */
  drawing?: SerializedDrawing;
  /** CAM setup (optional: older files predate it; toolpath caches excluded). */
  cam?: SerializedCam;
  metadata: {
    created: string;
    modified: string;
    appVersion: string;
  };
}

interface SerializedFeature {
  id: string;
  type: string;
  name: string;
  suppressed: boolean;
  parentIds: string[];
  data: unknown;
}

interface SerializedBody {
  id: string;
  name: string;
  vertices: { x: number; y: number; z: number }[];
  faceCount: number;
  edgeCount: number;
}

const FILE_VERSION = 1;
// Injected from package.json by vite/vitest (see src/vite-env.d.ts).
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

export function serializeProject(
  name: string,
  features: Feature[],
  bodies: SolidBody[],
  directBodies: SolidBody[] = [],
  referenceGeometry: SerializedReferenceGeometry = { planes: [], axes: [], points: [], coordSystems: [], annotations: [] },
  drawing: SerializedDrawing | null = null,
  cam: SerializedCam | null = null,
): ProjectFile {
  return {
    version: FILE_VERSION,
    name,
    directBodies,
    referenceGeometry,
    ...(drawing ? { drawing } : {}),
    ...(cam ? { cam } : {}),
    features: features.map((f) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      suppressed: f.suppressed,
      parentIds: f.parentIds,
      data: serializeFeatureData(f),
    })),
    bodies: bodies.map((b) => ({
      id: b.id,
      name: b.name,
      vertices: b.vertices,
      faceCount: b.faces.length,
      edgeCount: b.edges.length,
    })),
    metadata: {
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      appVersion: APP_VERSION,
    },
  };
}

function serializeFeatureData(feature: Feature): unknown {
  switch (feature.type) {
    case 'sketch':
      return {
        planeId: feature.sketch.planeId,
        entities: Array.from(feature.sketch.entities.entries()),
        constraints: Array.from(feature.sketch.constraints.entries()),
      };
    case 'extrude':
    case 'revolve':
    case 'sweep':
    case 'loft':
    case 'fillet':
    case 'chamfer':
    case 'shell':
    case 'hole':
    case 'scale':
    case 'linearArray':
    case 'circularArray':
    case 'mirror':
      return feature.params;
  }
}

/** Full direct-body meshes stored in a loaded project (empty if none). */
export function deserializeDirectBodies(project: ProjectFile): SolidBody[] {
  return Array.isArray(project.directBodies) ? project.directBodies : [];
}

/** Datum planes/axes/points stored in a loaded project (empty arrays if absent). */
export function deserializeReferenceGeometry(project: ProjectFile): SerializedReferenceGeometry {
  const rg = project.referenceGeometry;
  return {
    planes: Array.isArray(rg?.planes) ? rg.planes : [],
    axes: Array.isArray(rg?.axes) ? rg.axes : [],
    points: Array.isArray(rg?.points) ? rg.points : [],
    coordSystems: Array.isArray(rg?.coordSystems) ? rg.coordSystems : [],
    annotations: Array.isArray(rg?.annotations) ? rg.annotations : [],
  };
}

/** Drawing-sheet state stored in a loaded project (defaults for older files). */
export function deserializeDrawing(project: ProjectFile): SerializedDrawing {
  const d = project.drawing;
  const axis = typeof d?.sectionAxis === 'string' && ['off', 'x', 'y', 'z'].includes(d.sectionAxis)
    ? d.sectionAxis
    : 'off';
  return {
    sectionAxis: axis,
    details: Array.isArray(d?.details) ? d.details : [],
    notes: Array.isArray(d?.notes) ? d.notes : [],
  };
}

// --- CAM block deserialization ------------------------------------------------
// Every field is validated with unknown/malformed data falling back to the
// defaultCamSetup() values (kept in sync here — importing the generator module
// would chain the whole toolpath stack into the io layer for three constants).

/** Defaults mirroring defaultCamSetup() (lib/cam/setup.ts). */
const CAM_DEFAULT_MARGIN = 2;
const CAM_DEFAULT_SAFE_Z = 5;
const CAM_REQUIRED_PARAM_KEYS = ['feedRate', 'plungeRate', 'spindleSpeed', 'depthOfCut', 'stepover', 'stockTop', 'stockBottom'] as const;

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function finiteVec3(v: unknown): Vec3 | null {
  if (!v || typeof v !== 'object') return null;
  const x = finiteNum((v as Record<string, unknown>).x);
  const y = finiteNum((v as Record<string, unknown>).y);
  const z = finiteNum((v as Record<string, unknown>).z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

function sanitizeCamStock(raw: unknown): CAMSetup['stock'] {
  if (!raw || typeof raw !== 'object') return { mode: 'bounding-box', margin: CAM_DEFAULT_MARGIN };
  const s = raw as Record<string, unknown>;
  if (s.mode === 'bounding-box') {
    const margin = finiteNum(s.margin);
    return { mode: 'bounding-box', margin: margin !== null ? margin : CAM_DEFAULT_MARGIN };
  }
  if (s.mode === 'box') {
    const min = finiteVec3(s.min);
    const max = finiteVec3(s.max);
    if (min && max) return { mode: 'box', min, max };
  }
  return { mode: 'bounding-box', margin: CAM_DEFAULT_MARGIN };
}

/** Numeric params with finite-number overrides on top of the defaults; the
 * optional allowance/peckDepth survive only when finite. */
function sanitizeCamParams(raw: unknown): CAMParameters {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: CAMParameters = {
    feedRate: 1000,
    plungeRate: 300,
    spindleSpeed: 10000,
    depthOfCut: 2,
    stepover: 3,
    stockTop: 0,
    stockBottom: -10,
  };
  for (const key of CAM_REQUIRED_PARAM_KEYS) {
    const v = finiteNum(p[key]);
    if (v !== null) out[key] = v;
  }
  const allowance = finiteNum(p.allowance);
  if (allowance !== null) out.allowance = allowance;
  const peckDepth = finiteNum(p.peckDepth);
  if (peckDepth !== null) out.peckDepth = peckDepth;
  return out;
}

/** One operation, or null when the record is too malformed to keep. */
function sanitizeCamOperation(raw: unknown): CAMOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (
    typeof o.id !== 'string' || typeof o.name !== 'string' ||
    (type !== 'pocket' && type !== 'contour' && type !== 'drill' && type !== 'face') ||
    typeof o.bodyId !== 'string' || typeof o.toolId !== 'string'
  ) return null;
  const holes = Array.isArray(o.holes)
    ? o.holes.flatMap((h): Array<{ x: number; z: number; depth: number }> => {
        if (!h || typeof h !== 'object') return [];
        const x = finiteNum((h as Record<string, unknown>).x);
        const z = finiteNum((h as Record<string, unknown>).z);
        const depth = finiteNum((h as Record<string, unknown>).depth);
        return x !== null && z !== null && depth !== null ? [{ x, z, depth }] : [];
      })
    : [];
  return {
    id: o.id,
    name: o.name,
    enabled: o.enabled !== false, // only an explicit false disables
    type,
    bodyId: o.bodyId,
    toolId: o.toolId,
    params: sanitizeCamParams(o.params),
    ...(holes.length > 0 ? { holes } : {}),
  };
}

/** CAM setup stored in a loaded project (defaults for older/corrupt files). */
export function deserializeCam(project: ProjectFile): CAMSetup {
  const cam = project.cam;
  if (!cam || typeof cam !== 'object') {
    return { stock: { mode: 'bounding-box', margin: CAM_DEFAULT_MARGIN }, safeZAboveStock: CAM_DEFAULT_SAFE_Z, operations: [] };
  }
  const safeZ = finiteNum(cam.safeZAboveStock);
  return {
    stock: sanitizeCamStock(cam.stock),
    safeZAboveStock: safeZ !== null ? safeZ : CAM_DEFAULT_SAFE_Z,
    operations: Array.isArray(cam.operations)
      ? cam.operations.map(sanitizeCamOperation).filter((op): op is CAMOperation => op !== null)
      : [],
  };
}

/** Reconstruct Feature objects (incl. sketch Maps) from a loaded project. */
export function deserializeFeatures(project: ProjectFile): Feature[] {
  return project.features.map((sf): Feature => {
    const base = { id: sf.id, name: sf.name, suppressed: sf.suppressed, parentIds: sf.parentIds };
    switch (sf.type) {
      case 'sketch': {
        const d = sf.data as {
          planeId: string;
          entities: [string, SketchEntity][];
          constraints: [string, SketchConstraint][];
        };
        return {
          ...base,
          type: 'sketch',
          sketch: {
            id: `${sf.id}_sketch`,
            planeId: d.planeId,
            entities: new Map(d.entities),
            constraints: new Map(d.constraints),
          },
        } as SketchFeature;
      }
      case 'extrude':
        return { ...base, type: 'extrude', params: sf.data } as ExtrudeFeature;
      case 'revolve':
        return { ...base, type: 'revolve', params: sf.data } as RevolveFeature;
      case 'sweep':
        return { ...base, type: 'sweep', params: sf.data } as SweepFeature;
      case 'loft':
        return { ...base, type: 'loft', params: sf.data } as LoftFeature;
      case 'fillet':
        return { ...base, type: 'fillet', params: sf.data } as FilletFeature;
      case 'chamfer':
        return { ...base, type: 'chamfer', params: sf.data } as ChamferFeature;
      case 'shell':
        return { ...base, type: 'shell', params: sf.data } as ShellFeature;
      case 'hole':
        return { ...base, type: 'hole', params: sf.data } as HoleFeature;
      case 'scale':
        return { ...base, type: 'scale', params: sf.data } as ScaleFeature;
      case 'linearArray':
        return { ...base, type: 'linearArray', params: sf.data } as LinearArrayFeature;
      case 'circularArray':
        return { ...base, type: 'circularArray', params: sf.data } as CircularArrayFeature;
      case 'mirror':
        return { ...base, type: 'mirror', params: sf.data } as MirrorFeature;
      default:
        throw new Error(`Unknown feature type: ${sf.type}`);
    }
  });
}

/** Output form of {@link saveToFile}: compact by default, pretty on demand. */
export interface SaveFileOptions {
  /** Pretty-print with 2-space indent (human-readable .studio3d export). */
  pretty?: boolean;
}

/**
 * Serialize a project to JSON. COMPACT by default: the pretty variant put
 * ~3× the bytes into localStorage/autosave (and desktop crash snapshots) for
 * zero functional gain — loadFromFile only JSON.parses. Pass
 * `{ pretty: true }` when a human is meant to read the file.
 */
export function saveToFile(project: ProjectFile, options: SaveFileOptions = {}): string {
  return options.pretty ? JSON.stringify(project, null, 2) : JSON.stringify(project);
}

export function loadFromFile(json: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON format');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid project file: not an object');
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.version !== 'number') {
    throw new Error('Invalid project file: missing version');
  }

  if (obj.version !== FILE_VERSION) {
    throw new Error(`Unsupported file version: ${obj.version}`);
  }

  if (typeof obj.name !== 'string') {
    throw new Error('Invalid project file: missing name');
  }

  if (!Array.isArray(obj.features)) {
    throw new Error('Invalid project file: missing features array');
  }

  return data as ProjectFile;
}

export function downloadFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
