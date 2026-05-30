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
}

/** Project a 3D body onto a 2D plane for drawing */
export function projectBody(
  body: SolidBody,
  viewDir: Vec3,
  upDir: Vec3,
  scale = 1,
): DrawingView {
  // Screen right-axis for a right-handed view frame (right × up = viewDir,
  // i.e. +Z out of the screen toward the viewer). Using cross(viewDir, up)
  // instead would flip the drawing horizontally — a front view of +X would
  // project to the left.
  const right = cross(upDir, viewDir);
  const lines: DrawingLine[] = [];
  const arcs: DrawingArc[] = [];

  // Project all edges
  for (const edge of body.edges) {
    const p1 = projectPoint(edge.start, viewDir, right, upDir, scale);
    const p2 = projectPoint(edge.end, viewDir, right, upDir, scale);
    lines.push({ start: p1, end: p2 });
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.start.x, line.end.x);
    minY = Math.min(minY, line.start.y, line.end.y);
    maxX = Math.max(maxX, line.start.x, line.end.x);
    maxY = Math.max(maxY, line.start.y, line.end.y);
  }

  // Generate auto-dimensions
  const dimensions = generateDimensions(body, viewDir, right, upDir, scale);

  return {
    name: `${body.name} - ${getViewName(viewDir)}`,
    lines,
    arcs,
    dimensions,
    bounds: {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
    },
  };
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

function generateDimensions(
  body: SolidBody,
  viewDir: Vec3,
  right: Vec3,
  up: Vec3,
  scale: number,
): DrawingDimension[] {
  const dims: DrawingDimension[] = [];
  const bb = computeProjectedBounds(body, viewDir, right, up, scale);

  // Overall width dimension
  dims.push({
    type: 'linear',
    start: { x: bb.min.x, y: bb.min.y - 10 },
    end: { x: bb.max.x, y: bb.min.y - 10 },
    value: (bb.max.x - bb.min.x) / scale,
    offset: 10,
  });

  // Overall height dimension
  dims.push({
    type: 'linear',
    start: { x: bb.max.x + 10, y: bb.min.y },
    end: { x: bb.max.x + 10, y: bb.max.y },
    value: (bb.max.y - bb.min.y) / scale,
    offset: 10,
  });

  return dims;
}

function computeProjectedBounds(
  body: SolidBody,
  viewDir: Vec3,
  right: Vec3,
  up: Vec3,
  scale: number,
): { min: { x: number; y: number }; max: { x: number; y: number } } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const v of body.vertices) {
    const p = projectPoint(v, viewDir, right, up, scale);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
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

/** Export drawing as SVG */
export function exportDrawingSVG(view: DrawingView, width = 800, height = 600): string {
  const padding = 40;
  const viewWidth = view.bounds.max.x - view.bounds.min.x;
  const viewHeight = view.bounds.max.y - view.bounds.min.y;
  const scaleX = (width - padding * 2) / (viewWidth || 1);
  const scaleY = (height - padding * 2) / (viewHeight || 1);
  const scale = Math.min(scaleX, scaleY);
  const offsetX = padding + (width - padding * 2 - viewWidth * scale) / 2;
  const offsetY = padding + (height - padding * 2 - viewHeight * scale) / 2;

  const transform = (p: { x: number; y: number }) => ({
    x: (p.x - view.bounds.min.x) * scale + offsetX,
    y: height - ((p.y - view.bounds.min.y) * scale + offsetY),
  });

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="white" />
  <g stroke="black" stroke-width="1" fill="none">
`;

  // Lines
  for (const line of view.lines) {
    const p1 = transform(line.start);
    const p2 = transform(line.end);
    svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" />\n`;
  }

  // Arcs
  for (const arc of view.arcs) {
    const c = transform(arc.center);
    svg += `    <circle cx="${c.x}" cy="${c.y}" r="${arc.radius * scale}" />\n`;
  }

  svg += '  </g>\n';

  // Dimensions
  svg += '  <g stroke="red" stroke-width="0.5" fill="red" font-size="10">\n';
  for (const dim of view.dimensions) {
    const p1 = transform(dim.start);
    const p2 = transform(dim.end);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke-dasharray="2,2" />\n`;
    svg += `    <text x="${mx}" y="${my - 4}" text-anchor="middle">${dim.value.toFixed(2)} mm</text>\n`;
  }
  svg += '  </g>\n';

  // Title
  svg += `  <text x="${width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(view.name)}</text>\n`;

  svg += '</svg>';
  return svg;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
