/**
 * Faceted B-rep STEP import. Works on SceneLab's own export and, best-effort,
 * on any FACETED_BREP-flavoured AP203/AP214 file: faces are recovered from
 * ADVANCED_FACE → FACE_BOUND → EDGE_LOOP → ORIENTED_EDGE → EDGE_CURVE →
 * VERTEX_POINT chains, which every faceted writer emits. Curved edge geometry
 * (the curve spanning each edge's two vertices) is ignored — faceted models
 * are linear there anyway.
 */
import type { SolidBody, Vec3, Face } from '../geometry/types';
import { buildEdgesFromFaces } from '../geometry/brep';

interface StepEntity {
  type: string;
  /** Raw argument list (between the outermost parens), unparsed. */
  args: string;
}

/** Split a STEP argument list at top-level commas (quotes/parens aware). */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (const ch of args) {
    if (ch === "'" && depth === 0) {
      inQuote = !inQuote;
      cur += ch;
    } else if (inQuote) {
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out.map((s) => s.trim());
}

/** `#123` → 123; anything else → null. */
function refId(arg: string): number | null {
  const m = /^#(\d+)$/.exec(arg);
  return m ? Number(m[1]) : null;
}

/** `'name'` → name (STEP escapes a quote as ''). */
function stepStr(arg: string): string {
  return arg.replace(/^'|'$/g, '').replace(/''/g, "'");
}

function parsePoint(args: string): Vec3 | null {
  // CARTESIAN_POINT('',(x,y,z)) — the coordinate tuple arrives as one arg.
  const parts = splitArgs(args);
  const coordPart = parts.find((p) => p.startsWith('('));
  if (!coordPart) return null;
  const coords = splitArgs(coordPart.slice(1, -1)).map(Number);
  if (coords.length < 3 || !coords.slice(0, 3).every(Number.isFinite)) return null;
  return { x: coords[0]!, y: coords[1]!, z: coords[2]! };
}

const RECORD_RE = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)\s*;/g;

/**
 * Import a faceted STEP file. A file carrying several solids is merged into
 * one body (matching the single-scene document model). Throws when the file
 * has no parseable faceted geometry (e.g. a true curved B-rep from OCCT).
 */
export function importSTEP(text: string, name = 'STEP Import'): SolidBody {
  const entities = new Map<number, StepEntity>();
  let m: RegExpExecArray | null;
  while ((m = RECORD_RE.exec(text)) !== null) {
    entities.set(Number(m[1]), { type: m[2]!, args: m[3]! });
  }
  if (entities.size === 0) {
    // Laxer line-based fallback for unusual whitespace/line splits.
    const lineRe = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([^;]*)\);/g;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(text)) !== null) {
      entities.set(Number(line[1]), { type: line[2]!, args: line[3]! });
    }
  }

  const points = new Map<number, Vec3>();
  for (const [eid, ent] of entities) {
    if (ent.type === 'CARTESIAN_POINT') {
      const p = parsePoint(ent.args);
      if (p) points.set(eid, p);
    }
  }

  // VERTEX_POINT('', #point)
  const vertexPoint = new Map<number, Vec3>();
  for (const [eid, ent] of entities) {
    if (ent.type === 'VERTEX_POINT') {
      const pid = refId(splitArgs(ent.args)[1] ?? '');
      const p = pid !== null ? points.get(pid) : undefined;
      if (p) vertexPoint.set(eid, p);
    }
  }

  // EDGE_CURVE('','',#v1,#v2,#curve,.T.)
  const edgeCurves = new Map<number, [number, number]>();
  for (const [eid, ent] of entities) {
    if (ent.type === 'EDGE_CURVE') {
      const a = splitArgs(ent.args);
      const v1 = refId(a[2] ?? '');
      const v2 = refId(a[3] ?? '');
      if (v1 !== null && v2 !== null) edgeCurves.set(eid, [v1, v2]);
    }
  }

  let bodyName = name;
  for (const ent of entities.values()) {
    if (ent.type === 'PRODUCT') {
      const n = stepStr(splitArgs(ent.args)[0] ?? '');
      if (n) {
        bodyName = n;
        break;
      }
    }
  }

  const normalOf = (pts: Vec3[]): Vec3 => {
    const a = pts[0]!, b = pts[1]!, c = pts[2]!;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  };

  let nextId = 1;
  const faces: Face[] = [];
  for (const ent of entities.values()) {
    if (ent.type !== 'ADVANCED_FACE' && ent.type !== 'FACE_SURFACE') continue;
    const a = splitArgs(ent.args);
    const boundRefs = splitArgs((a[1] ?? '').replace(/^\(|\)$/g, '')).map(refId);
    const loopPts: Vec3[] = [];
    for (const boundId of boundRefs) {
      if (boundId === null) continue;
      const bound = entities.get(boundId);
      if (!bound) continue;
      const loopId = refId(splitArgs(bound.args)[1] ?? '');
      if (loopId === null) continue;
      const loop = entities.get(loopId);
      if (!loop) continue;
      const oeRefs = splitArgs((splitArgs(loop.args)[1] ?? '').replace(/^\(|\)$/g, '')).map(refId);
      for (const oeId of oeRefs) {
        if (oeId === null) continue;
        const oe = entities.get(oeId);
        if (!oe) continue;
        const oeArgs = splitArgs(oe.args);
        // ORIENTED_EDGE('','',*,*,#edge,.T.) — prefer the arg that actually
        // references an EDGE_CURVE (writers shuffle the * placeholders).
        const edgeRefArg = oeArgs.find((s) => refId(s) !== null && entities.get(refId(s)!)?.type === 'EDGE_CURVE');
        const edgeId = edgeRefArg ? refId(edgeRefArg) : null;
        if (edgeId === null) continue;
        const verts = edgeCurves.get(edgeId);
        if (!verts) continue;
        const forward = !oeArgs.some((s) => s === '.F.');
        loopPts.push(vertexPoint.get(forward ? verts[0]! : verts[1]!)!);
      }
    }
    if (loopPts.length < 3) continue;
    // Consecutive edges share their vertex — dedupe before triangulating.
    const dedup: Vec3[] = [];
    for (const p of loopPts) {
      const last = dedup[dedup.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > 1e-9) dedup.push(p);
    }
    if (dedup.length < 3) continue;
    faces.push({ id: `face_step_${nextId++}`, vertices: dedup, normal: normalOf(dedup) });
  }

  if (faces.length === 0) {
    throw new Error('No faceted faces found in STEP file (curved B-rep STEP is not supported yet)');
  }

  const vertices: Vec3[] = [];
  for (const f of faces) vertices.push(...f.vertices);
  return {
    id: `body_step_${nextId}`,
    name: bodyName,
    vertices,
    faces,
    edges: buildEdgesFromFaces(faces),
  };
}
