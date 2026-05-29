import type { Feature } from '../features/types';
import type { SolidBody } from '../geometry/types';

export interface ProjectFile {
  version: number;
  name: string;
  features: SerializedFeature[];
  bodies: SerializedBody[];
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
): ProjectFile {
  return {
    version: FILE_VERSION,
    name,
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
      return feature.params;
    case 'revolve':
      return feature.params;
    case 'fillet':
      return feature.params;
    case 'chamfer':
      return feature.params;
    case 'shell':
      return feature.params;
  }
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
