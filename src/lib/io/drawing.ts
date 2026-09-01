import type { SolidBody, Vec3 } from '../geometry/types';

export interface DrawingLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface DrawingArc {
  center: { x: number; y: number };
  radius: number;
  startAngle: number;
  endAngle: number;
}

export interface DrawingDimension {
  type: 'linear' | 'angular' | 'radius';
  start: { x: number; y: number };
  end: { x: number; y: number };
  value: number;
  offset: number;
}

export interface DrawingView {
  name: string;
  lines: DrawingLine[];
  arcs: DrawingArc[];
  dimensions: DrawingDimension[];
  bounds: { min: { x: number; y: number }; max: { x: number; y: number } };
  /** Section-view cut faces (planar polygons on the cutting plane), hatched. */
  sectionFaces?: { x: number; y: number }[][];
}

/** Half-space section clip: keep the geometry on the negative side of the plane. */
export interface SectionPlane {
  /** Plane normal (unit-ish); the positive side is removed. */
  normal: Vec3;
  /** Plane offset: the plane is the set {p : p·normal = offset}. */
  offset: number;
}

/** Project a 3D body onto a 2D plane for drawing */
export function projectBody(
  body: SolidBody,
  viewDir: Vec3,
  upDir: Vec3,
  scale = 1,
): DrawingView {
  return projectBodies([body], viewDir, upDir, scale, `${body.name} - ${getViewName(viewDir)}`);
}

/**
 * Project a multi-body scene onto a 2D plane, merging every body's edges into
 * one view (like Fusion 360's "Project Full View" of the whole design). The
 * auto-dimensions span the combined bounds, not the first body's.
 */
export function projectBodies(
  bodies: SolidBody[],
  viewDir: Vec3,
  upDir: Vec3,
  scale = 1,
  name = getViewName(viewDir),
  section?: SectionPlane,
): DrawingView {
  // Screen right-axis for a right-handed view frame (right × up = viewDir,
  // i.e. +Z out of the screen toward the viewer). Using cross(viewDir, up)
  // instead would flip the drawing horizontally — a front view of +X would
  // project to the left.
  const right = cross(upDir, viewDir);
  const lines: DrawingLine[] = [];
  const points: Vec3[] = [];
  const sectionFaces: { x: number; y: number }[][] = [];

  const sd = (p: Vec3): number =>
    section ? p.x * section.normal.x + p.y * section.normal.y + p.z * section.normal.z - section.offset : -1;
  // Clip a segment to the kept half-space (n·p <= offset); null when fully cut.
  const clipSeg = (a: Vec3, b: Vec3): [Vec3, Vec3] | null => {
    if (!section) return [a, b];
    const da = sd(a);
    const db = sd(b);
    if (da > 0 && db > 0) return null;
    if (da <= 0 && db <= 0) return [a, b];
    const t = da / (da - db);
    const cut: Vec3 = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
    return da <= 0 ? [a, cut] : [cut, b];
  };

  for (const body of bodies) {
    points.push(...body.vertices);
    for (const edge of body.edges) {
      const seg = clipSeg(edge.start, edge.end);
      if (!seg) continue;
      const p1 = projectPoint(seg[0], viewDir, right, upDir, scale);
      const p2 = projectPoint(seg[1], viewDir, right, upDir, scale);
      lines.push({ start: p1, end: p2 });
    }
    // Section cut faces: clip each face polygon to the kept side and collect
    // the edges the clip created ON the plane; chain those into closed loops —
    // the cross-section outline(s) of the cut.
    if (section) {
      const segs: [Vec3, Vec3][] = [];
      for (const face of body.faces) {
        const poly = clipPolygonToHalfSpace(face.vertices, section.normal, section.offset);
        if (poly.length < 3) continue;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i]!;
          const b = poly[(i + 1) % poly.length]!;
          if (Math.abs(sd(a)) < 1e-6 && Math.abs(sd(b)) < 1e-6) {
            segs.push([a, b]);
          }
        }
      }
      for (const loop of chainOnPlaneLoops(segs)) {
        sectionFaces.push(loop.map((p) => projectPoint(p, viewDir, right, upDir, scale)));
      }
    }
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.start.x, line.end.x);
    minY = Math.min(minY, line.start.y, line.end.y);
    maxX = Math.max(maxX, line.start.x, line.end.x);
    maxY = Math.max(maxY, line.start.y, line.end.y);
  }
  if (lines.length === 0) { minX = minY = maxX = maxY = 0; }

  // Generate auto-dimensions spanning the whole scene
  const projected = points.map((v) => projectPoint(v, viewDir, right, upDir, scale));
  const dimensions = dimensionsFromPoints(projected, scale);

  return {
    name,
    lines,
    arcs: [],
    dimensions,
    sectionFaces: sectionFaces.length > 0 ? sectionFaces : undefined,
    bounds: {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
    },
  };
}

/** Sutherland–Hodgman: clip a polygon to {p : p·n <= offset}. */
function clipPolygonToHalfSpace(poly: Vec3[], n: Vec3, offset: number): Vec3[] {
  if (poly.length < 3) return [];
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = a.x * n.x + a.y * n.y + a.z * n.z - offset;
    const db = b.x * n.x + b.y * n.y + b.z * n.z - offset;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      });
    }
  }
  return out;
}

/** Chain coplanar segments sharing endpoints into closed loops (>= 3 points). */
function chainOnPlaneLoops(segs: [Vec3, Vec3][]): Vec3[][] {
  const key = (p: Vec3) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
  const adj = new Map<string, { seg: number; other: Vec3 }[]>();
  segs.forEach(([a, b], i) => {
    (adj.get(key(a)) ?? adj.set(key(a), []).get(key(a))!).push({ seg: i, other: b });
    (adj.get(key(b)) ?? adj.set(key(b), []).get(key(b))!).push({ seg: i, other: a });
  });

  const loops: Vec3[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const start = segs[i]![0];
    const loop: Vec3[] = [start, segs[i]![1]];
    let cur = segs[i]![1];
    for (let guard = 0; guard <= segs.length; guard++) {
      if (key(cur) === key(start)) {
        loop.pop(); // drop the duplicated closing point
        break;
      }
      const next = (adj.get(key(cur)) ?? []).find((c) => !used.has(c.seg));
      if (!next) break;
      used.add(next.seg);
      cur = next.other;
      loop.push(cur);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function projectPoint(
  p: Vec3,
  _viewDir: Vec3,
  right: Vec3,
  up: Vec3,
  scale: number,
): { x: number; y: number } {
  return {
    x: (p.x * right.x + p.y * right.y + p.z * right.z) * scale,
    y: (p.x * up.x + p.y * up.y + p.z * up.z) * scale,
  };
}

function dimensionsFromPoints(
  projected: { x: number; y: number }[],
  scale: number,
): DrawingDimension[] {
  const dims: DrawingDimension[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of projected) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (projected.length === 0) return dims;

  // Overall width dimension
  dims.push({
    type: 'linear',
    start: { x: minX, y: minY - 10 },
    end: { x: maxX, y: minY - 10 },
    value: (maxX - minX) / scale,
    offset: 10,
  });

  // Overall height dimension
  dims.push({
    type: 'linear',
    start: { x: maxX + 10, y: minY },
    end: { x: maxX + 10, y: maxY },
    value: (maxY - minY) / scale,
    offset: 10,
  });

  return dims;
}

function getViewName(dir: Vec3): string {
  const { x, y, z } = dir;
  if (Math.abs(y) > 0.9) return y > 0 ? 'Top' : 'Bottom';
  if (Math.abs(z) > 0.9) return z > 0 ? 'Front' : 'Back';
  if (Math.abs(x) > 0.9) return x > 0 ? 'Right' : 'Left';
  return 'Iso';
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** Export one or more drawing views as SVG, laid out in a grid like the canvas */
export function exportDrawingSVG(
  views: DrawingView | DrawingView[],
  width = 800,
  height = 600,
): string {
  const list = Array.isArray(views) ? views : [views];
  const cols = Math.min(2, Math.max(1, list.length));
  const rows = Math.ceil(list.length / cols) || 1;
  const cellW = width / cols;
  const cellH = height / rows;
  const padding = 40;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <pattern id="sectionHatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#555" stroke-width="0.5" />
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="white" />
`;

  for (let i = 0; i < list.length; i++) {
    const view = list[i]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ox = col * cellW;
    const oy = row * cellH;

    const viewWidth = view.bounds.max.x - view.bounds.min.x;
    const viewHeight = view.bounds.max.y - view.bounds.min.y;
    const scaleX = (cellW - padding * 2) / (viewWidth || 1);
    const scaleY = (cellH - padding * 2 - 20) / (viewHeight || 1);
    const scale = Math.min(scaleX, scaleY);
    const offsetX = ox + padding + (cellW - padding * 2 - viewWidth * scale) / 2;
    const offsetY = oy + 20 + padding + (cellH - padding * 2 - 20 - viewHeight * scale) / 2;

    const transform = (p: { x: number; y: number }) => ({
      x: (p.x - view.bounds.min.x) * scale + offsetX,
      y: cellH - ((p.y - view.bounds.min.y) * scale + offsetY) + oy,
    });

    svg += `  <g stroke="black" stroke-width="1" fill="none">\n`;
    for (const line of view.lines) {
      const p1 = transform(line.start);
      const p2 = transform(line.end);
      svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" />\n`;
    }
    for (const arc of view.arcs) {
      const c = transform(arc.center);
      svg += `    <circle cx="${c.x}" cy="${c.y}" r="${arc.radius * scale}" />\n`;
    }
    svg += '  </g>\n';

    // Section cut faces: hatched with the SVG pattern (45° drafting lines).
    if (view.sectionFaces && view.sectionFaces.length > 0) {
      svg += `  <g fill="url(#sectionHatch)" stroke="#555" stroke-width="0.5">\n`;
      for (const face of view.sectionFaces) {
        const pts = face.map(transform);
        if (pts.length < 3) continue;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ') + ' Z';
        svg += `    <path d="${d}" />\n`;
      }
      svg += '  </g>\n';
    }

    svg += `  <g stroke="red" stroke-width="0.5" fill="red" font-size="10">\n`;
    for (const dim of view.dimensions) {
      const p1 = transform(dim.start);
      const p2 = transform(dim.end);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke-dasharray="2,2" />\n`;
      svg += `    <text x="${mx}" y="${my - 4}" text-anchor="middle">${dim.value.toFixed(2)} mm</text>\n`;
    }
    svg += '  </g>\n';

    // View title (top-centre of the cell)
    svg += `  <text x="${ox + cellW / 2}" y="${oy + 20}" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(view.name)}</text>\n`;
  }

  svg += '</svg>';
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
