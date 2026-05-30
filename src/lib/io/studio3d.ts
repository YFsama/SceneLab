import type {
  Feature,
  SketchFeature,
  ExtrudeFeature,
  RevolveFeature,
  FilletFeature,
  ChamferFeature,
  ShellFeature,
  LinearArrayFeature,
  CircularArrayFeature,
  MirrorFeature,
} from '../features/types';
import type { SolidBody } from '../geometry/types';
import type { SketchEntity, SketchConstraint } from '../sketch/types';

export interface ProjectFile {
  version: number;
  name: string;
  features: SerializedFeature[];
  bodies: SerializedBody[];
  /** Full meshes of bodies created outside the feature tree (AI/imported). */
  directBodies?: SolidBody[];
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
const APP_VERSION = '0.1.0';

export function serializeProject(
  name: string,
  features: Feature[],
  bodies: SolidBody[],
  directBodies: SolidBody[] = [],
): ProjectFile {
  return {
    version: FILE_VERSION,
    name,
    directBodies,
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
    case 'fillet':
    case 'chamfer':
    case 'shell':
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
      case 'fillet':
        return { ...base, type: 'fillet', params: sf.data } as FilletFeature;
      case 'chamfer':
        return { ...base, type: 'chamfer', params: sf.data } as ChamferFeature;
      case 'shell':
        return { ...base, type: 'shell', params: sf.data } as ShellFeature;
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

export function saveToFile(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
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
