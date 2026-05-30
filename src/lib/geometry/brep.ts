import type { Vec3, SolidBody, Face, Edge, ExtrudeParams, RevolveParams } from './types';

let nextId = 1;
function genId(prefix: string): string {
  return `${prefix}_${nextId++}`;
}

/**
 * Reverse each face's vertex order where it disagrees with the (outward) face
 * normal, so the whole mesh is consistently CCW-outward. This makes the vector
 * areas sum to zero, which is what keeps computeVolume correct and
 * translation-invariant.
 */
function alignWindingToNormal(faces: Face[]): void {
  for (const f of faces) {
    if (f.vertices.length < 3) continue;
    const a = f.vertices[0]!;
    const b = f.vertices[1]!;
    const c = f.vertices[2]!;
    const gx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const gy = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const gz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (gx * f.normal.x + gy * f.normal.y + gz * f.normal.z < 0) {
      f.vertices.reverse();
    }
  }
}

export function createExtrude(params: ExtrudeParams): SolidBody {
  const { profile, direction, distance, symmetric } = params;
  const n = profile.length;
  if (n < 3) throw new Error('Profile must have at least 3 points');
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('Distance must be positive');

  // Validate direction vector is not zero
  const dirLen = Math.sqrt(direction.x ** 2 + direction.y ** 2 + direction.z ** 2);
  if (dirLen < 1e-10) throw new Error('Direction vector cannot be zero');

  // The top face is always the full `distance` away from the bottom along the
  // direction. For a symmetric extrude both faces are then shifted back by half
  // the distance so the profile plane ends up centered between them.
  const halfDist = distance / 2;
  const offset = distance;

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];

  // Bottom face vertices
  const bottomVerts: Vec3[] = profile.map((p) => ({ ...p }));
  // Top face vertices
  const topVerts: Vec3[] = profile.map((p) => ({
    x: p.x + direction.x * offset,
    y: p.y + direction.y * offset,
    z: p.z + direction.z * offset,
  }));

  if (symmetric) {
    for (const v of bottomVerts) {
      v.x -= direction.x * halfDist;
      v.y -= direction.y * halfDist;
      v.z -= direction.z * halfDist;
    }
    for (const v of topVerts) {
      v.x -= direction.x * halfDist;
      v.y -= direction.y * halfDist;
      v.z -= direction.z * halfDist;
    }
  }

  vertices.push(...bottomVerts, ...topVerts);

  // Centroid of the prism, used to orient side normals outward regardless of
  // the profile's winding direction.
  const center: Vec3 = { x: 0, y: 0, z: 0 };
  for (const v of vertices) {
    center.x += v.x;
    center.y += v.y;
    center.z += v.z;
  }
  center.x /= vertices.length;
  center.y /= vertices.length;
  center.z /= vertices.length;

  // Bottom face
  const bottomNormal: Vec3 = {
    x: -direction.x,
    y: -direction.y,
    z: -direction.z,
  };
  faces.push({
    id: genId('face'),
    vertices: [...bottomVerts],
    normal: normalize(bottomNormal),
  });

  // Top face
  faces.push({
    id: genId('face'),
    vertices: [...topVerts],
    normal: normalize({ ...direction }),
  });

  // Side faces
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const b1 = bottomVerts[i]!;
    const b2 = bottomVerts[next]!;
    const t1 = topVerts[i]!;
    const t2 = topVerts[next]!;

    const sideNormal = computeFaceNormal(b1, b2, t2);
    // Flip to point away from the centroid (outward) if computeFaceNormal
    // produced an inward normal for this winding.
    const fc = {
      x: (b1.x + b2.x + t2.x + t1.x) / 4 - center.x,
      y: (b1.y + b2.y + t2.y + t1.y) / 4 - center.y,
      z: (b1.z + b2.z + t2.z + t1.z) / 4 - center.z,
    };
    if (sideNormal.x * fc.x + sideNormal.y * fc.y + sideNormal.z * fc.z < 0) {
      sideNormal.x = -sideNormal.x;
      sideNormal.y = -sideNormal.y;
      sideNormal.z = -sideNormal.z;
    }
    faces.push({
      id: genId('face'),
      vertices: [b1, b2, t2, t1],
      normal: sideNormal,
    });

    // Bottom edge
    edges.push({ id: genId('edge'), start: b1, end: b2 });
    // Top edge
    edges.push({ id: genId('edge'), start: t1, end: t2 });
    // Vertical edge
    edges.push({ id: genId('edge'), start: b1, end: t1 });
  }

  alignWindingToNormal(faces);

  return {
    id: genId('body'),
    name: 'Extrude',
    vertices,
    faces,
    edges,
  };
}

export function createRevolve(params: RevolveParams): SolidBody {
  const { profile, axis, angle } = params;
  const n = profile.length;
  if (n < 2) throw new Error('Profile must have at least 2 points');
  if (Math.abs(angle) < 1e-10) throw new Error('Revolve angle cannot be zero');

  // Validate axis direction is not zero
  const dirLen = Math.sqrt(axis.direction.x ** 2 + axis.direction.y ** 2 + axis.direction.z ** 2);
  if (dirLen < 1e-10) throw new Error('Axis direction vector cannot be zero');

  const segments = Math.max(8, Math.round((Math.abs(angle) / (Math.PI * 2)) * 32));
  const angleStep = angle / segments;
  const dir = normalize(axis.direction);
  const origin = axis.origin;

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];

  // A full turn wraps onto itself, so the final ring must reuse ring 0 instead
  // of a coincident duplicate — otherwise the seam edges are used by one face
  // each and the mesh is non-manifold (not watertight). Partial revolves keep
  // the extra end ring so the open ends can be capped.
  const fullTurn = Math.abs(Math.abs(angle) - Math.PI * 2) < 1e-9;
  const ringCount = fullTurn ? segments : segments + 1;

  // Generate vertices by rotating profile around axis
  const rings: Vec3[][] = [];
  for (let s = 0; s < ringCount; s++) {
    const a = angleStep * s;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const ring: Vec3[] = [];

    for (const p of profile) {
      // Translate point relative to axis origin
      const rel = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
      // Project onto axis to get parallel component
      const dot = dir.x * rel.x + dir.y * rel.y + dir.z * rel.z;
      const parallel = { x: dir.x * dot, y: dir.y * dot, z: dir.z * dot };
      // Perpendicular component
      const perp = { x: rel.x - parallel.x, y: rel.y - parallel.y, z: rel.z - parallel.z };
      // Cross product of axis and perpendicular
      const cross = {
        x: dir.y * perp.z - dir.z * perp.y,
        y: dir.z * perp.x - dir.x * perp.z,
        z: dir.x * perp.y - dir.y * perp.x,
      };
      // Rotate perpendicular component
      const rotated = {
        x: perp.x * cos + cross.x * sin,
        y: perp.y * cos + cross.y * sin,
        z: perp.z * cos + cross.z * sin,
      };
      ring.push({
        x: origin.x + parallel.x + rotated.x,
        y: origin.y + parallel.y + rotated.y,
        z: origin.z + parallel.z + rotated.z,
      });
    }
    rings.push(ring);
  }

  // Flatten rings into vertices array
  for (const ring of rings) {
    vertices.push(...ring);
  }

  // Side faces, wrapping the profile loop (pNext) so the cross-section closes.
  // On a full turn the band after the last ring wraps back to ring 0.
  for (let s = 0; s < segments; s++) {
    const nextRing = (s + 1) % ringCount;
    for (let p = 0; p < n; p++) {
      const pNext = (p + 1) % n;
      const v0 = vertices[s * n + p]!;
      const v1 = vertices[s * n + pNext]!;
      const v2 = vertices[nextRing * n + pNext]!;
      const v3 = vertices[nextRing * n + p]!;
      faces.push({ id: genId('face'), vertices: [v0, v1, v2, v3], normal: computeFaceNormal(v0, v1, v2) });
      edges.push({ id: genId('edge'), start: v0, end: v1 });
      edges.push({ id: genId('edge'), start: v0, end: v3 });
    }
  }

  // For a partial revolution the two ends are open — cap them with the profile
  // polygon at the start and end rings (a full turn wraps and needs no caps).
  if (!fullTurn && n >= 3) {
    const center = { x: 0, y: 0, z: 0 };
    for (const v of vertices) {
      center.x += v.x / vertices.length;
      center.y += v.y / vertices.length;
      center.z += v.z / vertices.length;
    }
    const capFace = (ringOffset: number) => {
      const loop = vertices.slice(ringOffset, ringOffset + n);
      const gn = computeFaceNormal(loop[0]!, loop[1]!, loop[2]!);
      const fc = { x: 0, y: 0, z: 0 };
      for (const v of loop) {
        fc.x += v.x / n;
        fc.y += v.y / n;
        fc.z += v.z / n;
      }
      const outward =
        gn.x * (fc.x - center.x) + gn.y * (fc.y - center.y) + gn.z * (fc.z - center.z) < 0
          ? { x: -gn.x, y: -gn.y, z: -gn.z }
          : gn;
      faces.push({ id: genId('face'), vertices: loop, normal: outward });
    };
    capFace(0);
    capFace(segments * n);
  }

  alignWindingToNormal(faces);

  return {
    id: genId('body'),
    name: 'Revolve',
    vertices,
    faces,
    edges,
  };
}

export function createBox(width: number, height: number, depth: number): SolidBody {
  if (![width, height, depth].every((d) => Number.isFinite(d) && d > 0)) {
    throw new Error('Box dimensions must be positive');
  }
  const hw = width / 2;
  const hd = depth / 2;

  const profile: Vec3[] = [
    { x: -hw, y: 0, z: -hd },
    { x: hw, y: 0, z: -hd },
    { x: hw, y: 0, z: hd },
    { x: -hw, y: 0, z: hd },
  ];

  return {
    ...createExtrude({
      profile,
      direction: { x: 0, y: 1, z: 0 },
      distance: height,
      symmetric: false,
    }),
    name: 'Box',
  };
}

/** Axis-aligned stock block enclosing a body's bounding box, with optional margin. */
export function createBoundingBoxBody(body: SolidBody, margin = 0): SolidBody {
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative');
  if (body.vertices.length === 0) throw new Error('Body has no geometry');
  const bb = computeBoundingBox(body);
  const y0 = bb.min.y - margin;
  const profile: Vec3[] = [
    { x: bb.min.x - margin, y: y0, z: bb.min.z - margin },
    { x: bb.max.x + margin, y: y0, z: bb.min.z - margin },
    { x: bb.max.x + margin, y: y0, z: bb.max.z + margin },
    { x: bb.min.x - margin, y: y0, z: bb.max.z + margin },
  ];
  return {
    ...createExtrude({
      profile,
      direction: { x: 0, y: 1, z: 0 },
      distance: bb.max.y - bb.min.y + 2 * margin,
      symmetric: false,
    }),
    name: 'Stock',
  };
}

/** Circular cylinder along +Y, approximated by an `segments`-gon prism. */
export function createCylinder(radius: number, height: number, segments = 32): SolidBody {
  if (radius <= 0) throw new Error('Radius must be positive');
  if (height <= 0) throw new Error('Height must be positive');
  if (segments < 3) throw new Error('Cylinder needs at least 3 segments');

  const profile: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    profile.push({ x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius });
  }

  return {
    ...createExtrude({
      profile,
      direction: { x: 0, y: 1, z: 0 },
      distance: height,
      symmetric: false,
    }),
    name: 'Cylinder',
  };
}

/** UV sphere centred at the origin. Normals come straight from position. */
export function createSphere(radius: number, segments = 16): SolidBody {
  if (radius <= 0) throw new Error('Radius must be positive');
  if (segments < 3) throw new Error('Sphere needs at least 3 segments');

  const lon = segments;
  const lat = Math.max(3, Math.round(segments / 2));

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  const unit = (v: Vec3): Vec3 => {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };

  const top = vertices.length; // index 0
  vertices.push({ x: 0, y: radius, z: 0 });

  // Middle latitude rings i = 1 .. lat-1.
  const ringStart = (i: number) => 1 + (i - 1) * lon;
  for (let i = 1; i < lat; i++) {
    const theta = (i / lat) * Math.PI;
    const y = Math.cos(theta) * radius;
    const r = Math.sin(theta) * radius;
    for (let j = 0; j < lon; j++) {
      const phi = (j / lon) * Math.PI * 2;
      vertices.push({ x: r * Math.cos(phi), y, z: r * Math.sin(phi) });
    }
  }
  const bottom = vertices.length;
  vertices.push({ x: 0, y: -radius, z: 0 });

  const v = (idx: number) => vertices[idx]!;

  // Top cap triangles.
  for (let j = 0; j < lon; j++) {
    const a = ringStart(1) + j;
    const b = ringStart(1) + ((j + 1) % lon);
    faces.push({ id: genId('face'), vertices: [v(top), v(a), v(b)], normal: unit(v(a)) });
  }
  // Middle quads.
  for (let i = 1; i < lat - 1; i++) {
    for (let j = 0; j < lon; j++) {
      const a = ringStart(i) + j;
      const b = ringStart(i + 1) + j;
      const c = ringStart(i + 1) + ((j + 1) % lon);
      const d = ringStart(i) + ((j + 1) % lon);
      faces.push({ id: genId('face'), vertices: [v(a), v(b), v(c), v(d)], normal: unit(v(a)) });
      edges.push({ id: genId('edge'), start: v(a), end: v(d) });
      edges.push({ id: genId('edge'), start: v(a), end: v(b) });
    }
  }
  // Bottom cap triangles.
  for (let j = 0; j < lon; j++) {
    const a = ringStart(lat - 1) + ((j + 1) % lon);
    const b = ringStart(lat - 1) + j;
    faces.push({ id: genId('face'), vertices: [v(bottom), v(a), v(b)], normal: unit(v(a)) });
  }

  alignWindingToNormal(faces);
  return { id: genId('body'), name: 'Sphere', vertices, faces, edges };
}

/** Cone / frustum along +Y. radiusTop = 0 gives a pointed cone. */
export function createCone(
  radiusBottom: number,
  radiusTop: number,
  height: number,
  segments = 32,
): SolidBody {
  if (radiusBottom < 0 || radiusTop < 0) throw new Error('Radius cannot be negative');
  if (radiusBottom < 1e-9 && radiusTop < 1e-9) throw new Error('At least one radius must be positive');
  if (height <= 0) throw new Error('Height must be positive');
  if (segments < 3) throw new Error('Cone needs at least 3 segments');

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];
  const pointed = radiusTop < 1e-9;

  const bottom: Vec3[] = [];
  const top: Vec3[] = [];
  for (let j = 0; j < segments; j++) {
    const a = (j / segments) * Math.PI * 2;
    bottom.push({ x: radiusBottom * Math.cos(a), y: 0, z: radiusBottom * Math.sin(a) });
    if (!pointed) top.push({ x: radiusTop * Math.cos(a), y: height, z: radiusTop * Math.sin(a) });
  }
  const apex: Vec3 = { x: 0, y: height, z: 0 };
  vertices.push(...bottom, ...top, apex);

  // Bottom cap (faces down).
  faces.push({ id: genId('face'), vertices: [...bottom].reverse(), normal: { x: 0, y: -1, z: 0 } });
  // Top cap (frustum only).
  if (!pointed) faces.push({ id: genId('face'), vertices: [...top], normal: { x: 0, y: 1, z: 0 } });

  // Side faces, normals oriented radially outward.
  const orientOut = (verts: Vec3[]): Vec3 => {
    const n = computeFaceNormal(verts[0]!, verts[1]!, verts[2]!);
    const c = verts.reduce((s, v) => ({ x: s.x + v.x, y: s.y + v.y, z: s.z + v.z }), { x: 0, y: 0, z: 0 });
    const cx = c.x / verts.length;
    const cz = c.z / verts.length;
    // Radial direction in XZ from the axis to the face centroid.
    if (n.x * cx + n.z * cz < 0) return { x: -n.x, y: -n.y, z: -n.z };
    return n;
  };

  for (let j = 0; j < segments; j++) {
    const next = (j + 1) % segments;
    if (pointed) {
      const verts = [bottom[j]!, bottom[next]!, apex];
      faces.push({ id: genId('face'), vertices: verts, normal: orientOut(verts) });
    } else {
      const verts = [bottom[j]!, bottom[next]!, top[next]!, top[j]!];
      faces.push({ id: genId('face'), vertices: verts, normal: orientOut(verts) });
      edges.push({ id: genId('edge'), start: top[j]!, end: top[next]! });
    }
    edges.push({ id: genId('edge'), start: bottom[j]!, end: bottom[next]! });
  }

  alignWindingToNormal(faces);
  return { id: genId('body'), name: 'Cone', vertices, faces, edges };
}

/** Ring torus around the +Y axis, lying in the XZ plane. */
export function createTorus(
  majorRadius: number,
  minorRadius: number,
  segments = 32,
  sides = 16,
): SolidBody {
  if (majorRadius <= 0 || minorRadius <= 0) throw new Error('Radius must be positive');
  if (minorRadius > majorRadius) throw new Error('minorRadius must not exceed majorRadius');
  if (segments < 3 || sides < 3) throw new Error('Torus needs at least 3 segments and sides');

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const edges: Edge[] = [];

  // Grid of segments × sides vertices, plus their normals.
  const grid: Vec3[][] = [];
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const ring: Vec3[] = [];
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      const p = {
        x: (majorRadius + minorRadius * cv) * cu,
        y: minorRadius * sv,
        z: (majorRadius + minorRadius * cv) * su,
      };
      ring.push(p);
      vertices.push(p);
    }
    grid.push(ring);
  }

  const normalAt = (i: number, j: number): Vec3 => {
    const u = (i / segments) * Math.PI * 2;
    const v = (j / sides) * Math.PI * 2;
    return { x: Math.cos(v) * Math.cos(u), y: Math.sin(v), z: Math.cos(v) * Math.sin(u) };
  };

  for (let i = 0; i < segments; i++) {
    const ni = (i + 1) % segments;
    for (let j = 0; j < sides; j++) {
      const nj = (j + 1) % sides;
      faces.push({
        id: genId('face'),
        vertices: [grid[i]![j]!, grid[ni]![j]!, grid[ni]![nj]!, grid[i]![nj]!],
        normal: normalAt(i, j),
      });
      edges.push({ id: genId('edge'), start: grid[i]![j]!, end: grid[ni]![j]! });
      edges.push({ id: genId('edge'), start: grid[i]![j]!, end: grid[i]![nj]! });
    }
  }

  alignWindingToNormal(faces);
  return { id: genId('body'), name: 'Torus', vertices, faces, edges };
}

/** Right-triangular-prism wedge: full height at -x, sloping to 0 at +x. */
export function createWedge(width: number, height: number, depth: number): SolidBody {
  if (width <= 0 || height <= 0 || depth <= 0) throw new Error('Dimensions must be positive');
  const hw = width / 2;
  const hd = depth / 2;
  // Front triangle (z = -hd) and back triangle (z = +hd).
  const A = { x: -hw, y: 0, z: -hd };
  const B = { x: hw, y: 0, z: -hd };
  const C = { x: -hw, y: height, z: -hd };
  const D = { x: -hw, y: 0, z: hd };
  const E = { x: hw, y: 0, z: hd };
  const F = { x: -hw, y: height, z: hd };
  const vertices: Vec3[] = [A, B, C, D, E, F];

  const center = { x: 0, y: 0, z: 0 };
  for (const v of vertices) {
    center.x += v.x / 6;
    center.y += v.y / 6;
    center.z += v.z / 6;
  }

  const faceLoops: Vec3[][] = [
    [A, B, E, D], // bottom (y = 0)
    [C, A, D, F], // vertical back (x = -hw)
    [B, E, F, C], // slope (hypotenuse)
    [A, C, B], // front triangle (z = -hd)
    [D, E, F], // back triangle (z = +hd)
  ];

  const faces: Face[] = faceLoops.map((loop) => {
    const gn = computeFaceNormal(loop[0]!, loop[1]!, loop[2]!);
    const fc = { x: 0, y: 0, z: 0 };
    for (const v of loop) {
      fc.x += v.x / loop.length;
      fc.y += v.y / loop.length;
      fc.z += v.z / loop.length;
    }
    const outward = gn.x * (fc.x - center.x) + gn.y * (fc.y - center.y) + gn.z * (fc.z - center.z) < 0
      ? { x: -gn.x, y: -gn.y, z: -gn.z }
      : gn;
    return { id: genId('face'), vertices: loop, normal: outward };
  });

  const edges: Edge[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      edges.push({ id: genId('edge'), start: f.vertices[i]!, end: f.vertices[(i + 1) % f.vertices.length]! });
    }
  }

  alignWindingToNormal(faces);
  return { id: genId('body'), name: 'Wedge', vertices, faces, edges };
}

/**
 * Regular n-sided prism: a regular polygon (circumradius `radius`, `sides`
 * corners) extruded `height` along +Y. Useful for nuts, standoffs, knobs and
 * other faceted parts. The base sits on y = 0.
 */
export function createPrism(sides: number, radius: number, height: number): SolidBody {
  if (!Number.isInteger(sides) || sides < 3) throw new Error('Prism must have at least 3 sides');
  if (![radius, height].every((d) => Number.isFinite(d) && d > 0)) {
    throw new Error('Prism radius and height must be positive');
  }
  const profile: Vec3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    profile.push({ x: radius * Math.cos(a), y: 0, z: radius * Math.sin(a) });
  }
  return {
    ...createExtrude({ profile, direction: { x: 0, y: 1, z: 0 }, distance: height, symmetric: false }),
    name: `Prism${sides}`,
  };
}

/**
 * Hollow cylinder (tube/pipe): an annular ring of outer radius `outerRadius`
 * and inner radius `innerRadius`, `height` tall along +Y, base on y = 0.
 * Watertight (outer wall, inner wall, and top/bottom annular caps). Common for
 * rings, bushings, spacers and nozzles.
 */
export function createTube(outerRadius: number, innerRadius: number, height: number, segments = 32): SolidBody {
  if (!(outerRadius > 0) || !(innerRadius > 0) || !(height > 0)) {
    throw new Error('Tube radii and height must be positive');
  }
  if (innerRadius >= outerRadius) throw new Error('Inner radius must be smaller than outer radius');
  if (segments < 3) throw new Error('Tube needs at least 3 segments');

  const ob: Vec3[] = [];
  const ot: Vec3[] = [];
  const ib: Vec3[] = [];
  const it: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ob.push({ x: c * outerRadius, y: 0, z: s * outerRadius });
    ot.push({ x: c * outerRadius, y: height, z: s * outerRadius });
    ib.push({ x: c * innerRadius, y: 0, z: s * innerRadius });
    it.push({ x: c * innerRadius, y: height, z: s * innerRadius });
  }
  const vertices: Vec3[] = [...ob, ...ot, ...ib, ...it];

  const faces: Face[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const am = ((i + 0.5) / segments) * Math.PI * 2;
    const nx = Math.cos(am);
    const nz = Math.sin(am);
    // Outer wall (normal points out), inner wall (points into the hole),
    // bottom and top annular caps. Winding is fixed by alignWindingToNormal.
    faces.push({ id: genId('face'), vertices: [ob[i]!, ob[j]!, ot[j]!, ot[i]!], normal: { x: nx, y: 0, z: nz } });
    faces.push({ id: genId('face'), vertices: [ib[i]!, ib[j]!, it[j]!, it[i]!], normal: { x: -nx, y: 0, z: -nz } });
    faces.push({ id: genId('face'), vertices: [ob[i]!, ob[j]!, ib[j]!, ib[i]!], normal: { x: 0, y: -1, z: 0 } });
    faces.push({ id: genId('face'), vertices: [ot[i]!, ot[j]!, it[j]!, it[i]!], normal: { x: 0, y: 1, z: 0 } });
  }

  const edges: Edge[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.vertices.length; i++) {
      edges.push({ id: genId('edge'), start: f.vertices[i]!, end: f.vertices[(i + 1) % f.vertices.length]! });
    }
  }

  alignWindingToNormal(faces);
  return { id: genId('body'), name: 'Tube', vertices, faces, edges };
}

export function computeBoundingBox(body: SolidBody): { min: Vec3; max: Vec3 } {
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (const v of body.vertices) {
    min.x = Math.min(min.x, v.x);
    min.y = Math.min(min.y, v.y);
    min.z = Math.min(min.z, v.z);
    max.x = Math.max(max.x, v.x);
    max.y = Math.max(max.y, v.y);
    max.z = Math.max(max.z, v.z);
  }

  return { min, max };
}

/** Enclosing sphere centered at the bounding-box center (exact for symmetric shapes). */
export function computeBoundingSphere(body: SolidBody): { center: Vec3; radius: number } {
  const bb = computeBoundingBox(body);
  const center: Vec3 = {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  };
  let radius = 0;
  for (const v of body.vertices) {
    const dx = v.x - center.x;
    const dy = v.y - center.y;
    const dz = v.z - center.z;
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return { center, radius };
}

export function computeBoundingBoxCenter(body: SolidBody): Vec3 {
  const bb = computeBoundingBox(body);
  return {
    x: (bb.min.x + bb.max.x) / 2,
    y: (bb.min.y + bb.max.y) / 2,
    z: (bb.min.z + bb.max.z) / 2,
  };
}

export function computeCentroid(body: SolidBody): Vec3 {
  if (body.vertices.length === 0) return { x: 0, y: 0, z: 0 };
  let cx = 0, cy = 0, cz = 0;
  for (const v of body.vertices) {
    cx += v.x;
    cy += v.y;
    cz += v.z;
  }
  const n = body.vertices.length;
  return { x: cx / n, y: cy / n, z: cz / n };
}

/**
 * Volume-weighted centroid (true center of mass for a uniform-density solid),
 * via signed tetrahedra from the origin. Falls back to the vertex centroid for
 * degenerate (near-zero-volume) meshes.
 */
export function computeVolumetricCentroid(body: SolidBody): Vec3 {
  let vol = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0]!;
      const b = verts[i]!;
      const c = verts[i + 1]!;
      const tv =
        (a.x * (b.y * c.z - b.z * c.y) -
          a.y * (b.x * c.z - b.z * c.x) +
          a.z * (b.x * c.y - b.y * c.x)) /
        6;
      vol += tv;
      cx += (tv * (a.x + b.x + c.x)) / 4;
      cy += (tv * (a.y + b.y + c.y)) / 4;
      cz += (tv * (a.z + b.z + c.z)) / 4;
    }
  }
  if (Math.abs(vol) < 1e-9) return computeCentroid(body);
  return { x: cx / vol, y: cy / vol, z: cz / vol };
}

export function computeVolume(body: SolidBody): number {
  // Signed volume using divergence theorem
  let volume = 0;
  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 1; i < verts.length - 1; i++) {
      const v0 = verts[0]!;
      const v1 = verts[i]!;
      const v2 = verts[i + 1]!;
      volume += signedTriangleVolume(v0, v1, v2);
    }
  }
  return Math.abs(volume / 6);
}

function signedTriangleVolume(a: Vec3, b: Vec3, c: Vec3): number {
  return (
    a.x * (b.y * c.z - c.y * b.z) -
    b.x * (a.y * c.z - c.y * a.z) +
    c.x * (a.y * b.z - b.y * a.z)
  );
}

export interface MassProperties {
  density: number;
  volume: number;
  mass: number;
  centerOfMass: Vec3;
  /**
   * Mass-weighted inertia tensor about the center of mass (symmetric):
   * ixx = ∫ρ(y²+z²)dV, etc.; products of inertia ixy = -∫ρ·xy·dV, etc.
   */
  inertia: { ixx: number; iyy: number; izz: number; ixy: number; iyz: number; ixz: number };
}

/**
 * Rigid-body mass properties of a closed mesh: volume, mass, center of mass,
 * and the inertia tensor about the center of mass (for the given uniform
 * density). Uses the canonical-tetrahedron covariance method — each triangle
 * forms a tetrahedron with the origin, and the covariance of the canonical
 * simplex C = (1/120)[[2,1,1],[1,2,1],[1,1,2]] is mapped through the tet's
 * vertex matrix; signed contributions cancel the interior automatically.
 */
export function computeMassProperties(body: SolidBody, density = 1): MassProperties {
  // Canonical simplex second-moment matrix (times 120).
  const M = [
    [2, 1, 1],
    [1, 2, 1],
    [1, 1, 2],
  ];

  let det6 = 0; // Σ det = 6·volume
  let comX = 0;
  let comY = 0;
  let comZ = 0;
  // Covariance about the origin (unit density), accumulated ×120.
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 1; i < verts.length - 1; i++) {
      const a = verts[0]!;
      const b = verts[i]!;
      const cc = verts[i + 1]!;
      const det = signedTriangleVolume(a, b, cc); // det[a b c] = 6·V_tet
      det6 += det;
      comX += det * (a.x + b.x + cc.x);
      comY += det * (a.y + b.y + cc.y);
      comZ += det * (a.z + b.z + cc.z);

      // A has columns a, b, cc. Accumulate det · (A · M · Aᵀ).
      const A = [
        [a.x, b.x, cc.x],
        [a.y, b.y, cc.y],
        [a.z, b.z, cc.z],
      ];
      // AM = A · M
      const AM = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 3; k++) {
          AM[r]![k] = A[r]![0]! * M[0]![k]! + A[r]![1]! * M[1]![k]! + A[r]![2]! * M[2]![k]!;
        }
      }
      // C += det · (AM · Aᵀ)
      for (let r = 0; r < 3; r++) {
        for (let s = 0; s < 3; s++) {
          const amat = AM[r]![0]! * A[s]![0]! + AM[r]![1]! * A[s]![1]! + AM[r]![2]! * A[s]![2]!;
          c[r]![s]! += det * amat;
        }
      }
    }
  }

  const volume = Math.abs(det6) / 6;
  if (volume < 1e-12) {
    const centroid = computeCentroid(body);
    return {
      density,
      volume: 0,
      mass: 0,
      centerOfMass: centroid,
      inertia: { ixx: 0, iyy: 0, izz: 0, ixy: 0, iyz: 0, ixz: 0 },
    };
  }

  // Center of mass: Σ(V_tet · tetCentroid) / V, tetCentroid = (a+b+cc+0)/4.
  const com: Vec3 = { x: comX / (4 * det6), y: comY / (4 * det6), z: comZ / (4 * det6) };

  // Covariance about origin, mass-weighted. Sign tracks winding so the
  // diagonal stays positive regardless of inward/outward orientation.
  const sign = det6 >= 0 ? 1 : -1;
  const k = (sign * density) / 120;
  const cxx = c[0]![0]! * k;
  const cyy = c[1]![1]! * k;
  const czz = c[2]![2]! * k;
  const cxy = c[0]![1]! * k;
  const cyz = c[1]![2]! * k;
  const cxz = c[0]![2]! * k;

  const mass = volume * density;
  // Shift covariance to the center of mass (parallel-axis theorem).
  const dxx = cxx - mass * com.x * com.x;
  const dyy = cyy - mass * com.y * com.y;
  const dzz = czz - mass * com.z * com.z;
  const dxy = cxy - mass * com.x * com.y;
  const dyz = cyz - mass * com.y * com.z;
  const dxz = cxz - mass * com.x * com.z;

  return {
    density,
    volume,
    mass,
    centerOfMass: com,
    inertia: {
      ixx: dyy + dzz,
      iyy: dxx + dzz,
      izz: dxx + dyy,
      ixy: -dxy,
      iyz: -dyz,
      ixz: -dxz,
    },
  };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-10) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function computeFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return normalize({
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  });
}

export function computeSurfaceArea(body: SolidBody): number {
  let area = 0;
  for (const face of body.faces) {
    const verts = face.vertices;
    // Triangulate face using fan from first vertex
    for (let i = 1; i < verts.length - 1; i++) {
      const v0 = verts[0]!;
      const v1 = verts[i]!;
      const v2 = verts[i + 1]!;
      area += triangleArea(v0, v1, v2);
    }
  }
  return area;
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  return Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z) / 2;
}

export function computeEdgeLength(edge: Edge): number {
  const dx = edge.end.x - edge.start.x;
  const dy = edge.end.y - edge.start.y;
  const dz = edge.end.z - edge.start.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function computeTotalEdgeLength(body: SolidBody): number {
  let total = 0;
  for (const edge of body.edges) {
    total += computeEdgeLength(edge);
  }
  return total;
}

export function computeAngleBetweenEdges(edge1: Edge, edge2: Edge): number {
  const d1 = {
    x: edge1.end.x - edge1.start.x,
    y: edge1.end.y - edge1.start.y,
    z: edge1.end.z - edge1.start.z,
  };
  const d2 = {
    x: edge2.end.x - edge2.start.x,
    y: edge2.end.y - edge2.start.y,
    z: edge2.end.z - edge2.start.z,
  };

  const dot = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
  const len1 = Math.sqrt(d1.x * d1.x + d1.y * d1.y + d1.z * d1.z);
  const len2 = Math.sqrt(d2.x * d2.x + d2.y * d2.y + d2.z * d2.z);

  if (len1 < 1e-10 || len2 < 1e-10) return 0;

  const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
  return Math.acos(cosAngle) * (180 / Math.PI); // Return in degrees
}

export function computeBoundingBoxDiagonal(body: SolidBody): number {
  const bb = computeBoundingBox(body);
  const dx = bb.max.x - bb.min.x;
  const dy = bb.max.y - bb.min.y;
  const dz = bb.max.z - bb.min.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface MeshStatistics {
  vertexCount: number;
  faceCount: number;
  edgeCount: number;
  triangleCount: number;
  averageEdgeLength: number;
  minEdgeLength: number;
  maxEdgeLength: number;
}

export function computeMeshStatistics(body: SolidBody): MeshStatistics {
  let totalEdgeLength = 0;
  let minEdgeLength = Infinity;
  let maxEdgeLength = 0;
  let triangleCount = 0;

  for (const edge of body.edges) {
    const len = computeEdgeLength(edge);
    totalEdgeLength += len;
    minEdgeLength = Math.min(minEdgeLength, len);
    maxEdgeLength = Math.max(maxEdgeLength, len);
  }

  for (const face of body.faces) {
    // Each face with n vertices produces n-2 triangles
    triangleCount += Math.max(0, face.vertices.length - 2);
  }

  return {
    vertexCount: body.vertices.length,
    faceCount: body.faces.length,
    edgeCount: body.edges.length,
    triangleCount,
    averageEdgeLength: body.edges.length > 0 ? totalEdgeLength / body.edges.length : 0,
    minEdgeLength: body.edges.length > 0 ? minEdgeLength : 0,
    maxEdgeLength,
  };
}

export function computeVertexDegrees(body: SolidBody): Map<number, number> {
  const degrees = new Map<number, number>();

  for (const edge of body.edges) {
    const startIdx = body.vertices.findIndex((v) =>
      Math.abs(v.x - edge.start.x) < 1e-6 &&
      Math.abs(v.y - edge.start.y) < 1e-6 &&
      Math.abs(v.z - edge.start.z) < 1e-6,
    );
    const endIdx = body.vertices.findIndex((v) =>
      Math.abs(v.x - edge.end.x) < 1e-6 &&
      Math.abs(v.y - edge.end.y) < 1e-6 &&
      Math.abs(v.z - edge.end.z) < 1e-6,
    );

    if (startIdx >= 0) degrees.set(startIdx, (degrees.get(startIdx) ?? 0) + 1);
    if (endIdx >= 0) degrees.set(endIdx, (degrees.get(endIdx) ?? 0) + 1);
  }

  return degrees;
}

export function computeAverageVertexDegree(body: SolidBody): number {
  const degrees = computeVertexDegrees(body);
  if (degrees.size === 0) return 0;
  let total = 0;
  for (const d of degrees.values()) total += d;
  return total / degrees.size;
}

export function computeFaceArea(face: Face): number {
  let area = 0;
  const verts = face.vertices;
  for (let i = 1; i < verts.length - 1; i++) {
    area += triangleArea(verts[0]!, verts[i]!, verts[i + 1]!);
  }
  return area;
}

export function computeFaceAreas(body: SolidBody): Array<{ faceId: string; area: number }> {
  return body.faces.map((face) => ({
    faceId: face.id,
    area: computeFaceArea(face),
  }));
}

export function computeLargestFace(body: SolidBody): { faceId: string; area: number } | null {
  const areas = computeFaceAreas(body);
  if (areas.length === 0) return null;
  return areas.reduce((max, curr) => curr.area > max.area ? curr : max);
}

export interface ManifoldCheck {
  isManifold: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  isolatedVertices: number;
}

export function checkManifold(body: SolidBody): ManifoldCheck {
  // Count how many faces each edge belongs to
  const edgeFaceCount = new Map<string, number>();

  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      // Create a canonical edge key (sorted)
      const key = v1.x < v2.x || (v1.x === v2.x && v1.y < v2.y) || (v1.x === v2.x && v1.y === v2.y && v1.z < v2.z)
        ? `${v1.x},${v1.y},${v1.z}-${v2.x},${v2.y},${v2.z}`
        : `${v2.x},${v2.y},${v2.z}-${v1.x},${v1.y},${v1.z}`;
      edgeFaceCount.set(key, (edgeFaceCount.get(key) ?? 0) + 1);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;

  for (const count of edgeFaceCount.values()) {
    if (count === 1) boundaryEdges++;
    if (count > 2) nonManifoldEdges++;
  }

  // Count isolated vertices (vertices used by no face). Checking faces — not the
  // edge list — avoids false positives for apex/pole vertices whose cap-face
  // edges aren't enumerated in body.edges.
  const usedVertices = new Set<string>();
  for (const face of body.faces) {
    for (const v of face.vertices) usedVertices.add(`${v.x},${v.y},${v.z}`);
  }
  const isolatedVertices = body.vertices.filter(
    (v) => !usedVertices.has(`${v.x},${v.y},${v.z}`),
  ).length;

  return {
    isManifold: boundaryEdges === 0 && nonManifoldEdges === 0,
    boundaryEdges,
    nonManifoldEdges,
    isolatedVertices,
  };
}

export interface TopologyInfo {
  eulerCharacteristic: number;
  genus: number; // Number of "handles" (0 for sphere, 1 for torus, etc.)
  isSphereLike: boolean;
}

export function computeTopology(body: SolidBody): TopologyInfo {
  // Euler characteristic: V - E + F
  const v = body.vertices.length;
  const e = body.edges.length;
  const f = body.faces.length;
  const chi = v - e + f;

  // For a closed orientable surface: chi = 2 - 2g
  // So g = (2 - chi) / 2
  const genus = (2 - chi) / 2;

  return {
    eulerCharacteristic: chi,
    genus: Math.max(0, Math.round(genus)),
    isSphereLike: chi === 2, // Sphere has chi=2
  };
}

export interface MeshQuality {
  aspectRatioAvg: number;
  aspectRatioMax: number;
  skewnessAvg: number;
  skewnessMax: number;
}

export function computeMeshQuality(body: SolidBody): MeshQuality {
  let totalAspectRatio = 0;
  let maxAspectRatio = 0;
  let totalSkewness = 0;
  let maxSkewness = 0;
  let faceCount = 0;

  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;

    // For each triangle in the face
    for (let i = 1; i < verts.length - 1; i++) {
      const v0 = verts[0]!;
      const v1 = verts[i]!;
      const v2 = verts[i + 1]!;

      // Edge lengths
      const a = Math.sqrt((v1.x - v0.x) ** 2 + (v1.y - v0.y) ** 2 + (v1.z - v0.z) ** 2);
      const b = Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2 + (v2.z - v1.z) ** 2);
      const c = Math.sqrt((v0.x - v2.x) ** 2 + (v0.y - v2.y) ** 2 + (v0.z - v2.z) ** 2);

      const minEdge = Math.min(a, b, c);
      const maxEdge = Math.max(a, b, c);

      // Aspect ratio (longest edge / shortest edge)
      const aspectRatio = minEdge > 1e-10 ? maxEdge / minEdge : 0;
      totalAspectRatio += aspectRatio;
      maxAspectRatio = Math.max(maxAspectRatio, aspectRatio);

      // Skewness (0 = equilateral, 1 = degenerate)
      const s = (a + b + c) / 2;
      const area = Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)));
      const idealArea = (Math.sqrt(3) / 4) * ((a + b + c) / 3) ** 2;
      const skewness = idealArea > 1e-10 ? 1 - area / idealArea : 1;
      totalSkewness += skewness;
      maxSkewness = Math.max(maxSkewness, skewness);

      faceCount++;
    }
  }

  return {
    aspectRatioAvg: faceCount > 0 ? totalAspectRatio / faceCount : 0,
    aspectRatioMax: maxAspectRatio,
    skewnessAvg: faceCount > 0 ? totalSkewness / faceCount : 0,
    skewnessMax: maxSkewness,
  };
}

export interface WindingCheck {
  consistentWinding: boolean;
  clockwiseFaces: number;
  counterClockwiseFaces: number;
  degenerateFaces: number;
}

export function checkWindingOrder(body: SolidBody): WindingCheck {
  let clockwise = 0;
  let counterClockwise = 0;
  let degenerate = 0;

  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) {
      degenerate++;
      continue;
    }

    // Use first triangle to determine winding
    const v0 = verts[0]!;
    const v1 = verts[1]!;
    const v2 = verts[2]!;

    // Cross product of edges
    const ax = v1.x - v0.x;
    const ay = v1.y - v0.y;
    const az = v1.z - v0.z;
    const bx = v2.x - v0.x;
    const by = v2.y - v0.y;
    const bz = v2.z - v0.z;

    const crossX = ay * bz - az * by;
    const crossY = az * bx - ax * bz;
    const crossZ = ax * by - ay * bx;

    // Dot with face normal
    const dot = crossX * face.normal.x + crossY * face.normal.y + crossZ * face.normal.z;

    if (Math.abs(dot) < 1e-10) {
      degenerate++;
    } else if (dot > 0) {
      counterClockwise++;
    } else {
      clockwise++;
    }
  }

  return {
    consistentWinding: clockwise === 0 || counterClockwise === 0,
    clockwiseFaces: clockwise,
    counterClockwiseFaces: counterClockwise,
    degenerateFaces: degenerate,
  };
}

export interface AdjacencyInfo {
  vertexToEdges: Map<number, number[]>;
  vertexToFaces: Map<number, number[]>;
  edgeToFaces: Map<number, number[]>;
  faceToEdges: Map<number, number[]>;
}

export function computeAdjacency(body: SolidBody): AdjacencyInfo {
  const vertexToEdges = new Map<number, number[]>();
  const vertexToFaces = new Map<number, number[]>();
  const edgeToFaces = new Map<number, number[]>();
  const faceToEdges = new Map<number, number[]>();

  // Build vertex-to-edge adjacency
  for (let ei = 0; ei < body.edges.length; ei++) {
    const edge = body.edges[ei]!;
    const startIdx = findVertexIndex(body, edge.start);
    const endIdx = findVertexIndex(body, edge.end);

    if (startIdx >= 0) {
      if (!vertexToEdges.has(startIdx)) vertexToEdges.set(startIdx, []);
      vertexToEdges.get(startIdx)!.push(ei);
    }
    if (endIdx >= 0) {
      if (!vertexToEdges.has(endIdx)) vertexToEdges.set(endIdx, []);
      vertexToEdges.get(endIdx)!.push(ei);
    }
  }

  // Build vertex-to-face adjacency
  for (let fi = 0; fi < body.faces.length; fi++) {
    const face = body.faces[fi]!;
    for (const v of face.vertices) {
      const idx = findVertexIndex(body, v);
      if (idx >= 0) {
        if (!vertexToFaces.has(idx)) vertexToFaces.set(idx, []);
        vertexToFaces.get(idx)!.push(fi);
      }
    }
  }

  // Build edge-to-face and face-to-edge adjacency
  for (let fi = 0; fi < body.faces.length; fi++) {
    const face = body.faces[fi]!;
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const edgeIdx = findEdgeIndex(body, verts[i]!, verts[next]!);
      if (edgeIdx >= 0) {
        if (!edgeToFaces.has(edgeIdx)) edgeToFaces.set(edgeIdx, []);
        edgeToFaces.get(edgeIdx)!.push(fi);

        if (!faceToEdges.has(fi)) faceToEdges.set(fi, []);
        faceToEdges.get(fi)!.push(edgeIdx);
      }
    }
  }

  return { vertexToEdges, vertexToFaces, edgeToFaces, faceToEdges };
}

function findVertexIndex(body: SolidBody, v: Vec3): number {
  return body.vertices.findIndex(
    (nv) => Math.abs(nv.x - v.x) < 1e-6 && Math.abs(nv.y - v.y) < 1e-6 && Math.abs(nv.z - v.z) < 1e-6,
  );
}

function findEdgeIndex(body: SolidBody, v1: Vec3, v2: Vec3): number {
  return body.edges.findIndex(
    (e) =>
      (Math.abs(e.start.x - v1.x) < 1e-6 && Math.abs(e.start.y - v1.y) < 1e-6 && Math.abs(e.start.z - v1.z) < 1e-6 &&
       Math.abs(e.end.x - v2.x) < 1e-6 && Math.abs(e.end.y - v2.y) < 1e-6 && Math.abs(e.end.z - v2.z) < 1e-6) ||
      (Math.abs(e.start.x - v2.x) < 1e-6 && Math.abs(e.start.y - v2.y) < 1e-6 && Math.abs(e.start.z - v2.z) < 1e-6 &&
       Math.abs(e.end.x - v1.x) < 1e-6 && Math.abs(e.end.y - v1.y) < 1e-6 && Math.abs(e.end.z - v1.z) < 1e-6),
  );
}

export interface ValenceDistribution {
  minValence: number;
  maxValence: number;
  avgValence: number;
  valenceHistogram: Map<number, number>; // valence -> count
}

export function computeValenceDistribution(body: SolidBody): ValenceDistribution {
  const degrees = computeVertexDegrees(body);
  const histogram = new Map<number, number>();

  let minVal = Infinity;
  let maxVal = 0;
  let total = 0;

  for (const val of degrees.values()) {
    histogram.set(val, (histogram.get(val) ?? 0) + 1);
    minVal = Math.min(minVal, val);
    maxVal = Math.max(maxVal, val);
    total += val;
  }

  return {
    minValence: degrees.size > 0 ? minVal : 0,
    maxValence: maxVal,
    avgValence: degrees.size > 0 ? total / degrees.size : 0,
    valenceHistogram: histogram,
  };
}

export interface CurvatureInfo {
  gaussianCurvatureAvg: number;
  gaussianCurvatureMin: number;
  gaussianCurvatureMax: number;
  meanCurvatureAvg: number;
}

export function computeCurvature(body: SolidBody): CurvatureInfo {
  // Approximate Gaussian curvature using angle defect method
  // K(v) = 2π - Σ θ_i (sum of angles around vertex)
  const vertexAngles = new Map<number, number>();

  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const prev = (i - 1 + verts.length) % verts.length;
      const next = (i + 1) % verts.length;
      const v0 = verts[prev]!;
      const v1 = verts[i]!;
      const v2 = verts[next]!;

      const idx = body.vertices.findIndex(
        (v) => Math.abs(v.x - v1.x) < 1e-6 && Math.abs(v.y - v1.y) < 1e-6 && Math.abs(v.z - v1.z) < 1e-6,
      );
      if (idx < 0) continue;

      // Compute angle at v1
      const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
      const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      const lenA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const lenB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
      if (lenA < 1e-10 || lenB < 1e-10) continue;

      const cosAngle = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const angle = Math.acos(cosAngle);

      vertexAngles.set(idx, (vertexAngles.get(idx) ?? 0) + angle);
    }
  }

  let totalGaussian = 0;
  let minGaussian = Infinity;
  let maxGaussian = -Infinity;
  let count = 0;

  for (const [, angleSum] of vertexAngles) {
    const gaussian = 2 * Math.PI - angleSum;
    totalGaussian += gaussian;
    minGaussian = Math.min(minGaussian, gaussian);
    maxGaussian = Math.max(maxGaussian, gaussian);
    count++;
  }

  return {
    gaussianCurvatureAvg: count > 0 ? totalGaussian / count : 0,
    gaussianCurvatureMin: count > 0 ? minGaussian : 0,
    gaussianCurvatureMax: count > 0 ? maxGaussian : 0,
    meanCurvatureAvg: 0, // Would need more complex computation
  };
}

export interface DihedralInfo {
  minDihedral: number;
  maxDihedral: number;
  avgDihedral: number;
  sharpEdges: number; // Edges with dihedral > 150°
}

export function computeDihedralAngles(body: SolidBody): DihedralInfo {
  const edgeFaceCount = new Map<string, { faces: typeof body.faces; edge: typeof body.edges[0] }>();

  // Group faces by edge
  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      const key = edgeKey(v1, v2);

      if (!edgeFaceCount.has(key)) {
        edgeFaceCount.set(key, { faces: [], edge: { id: '', start: v1, end: v2 } });
      }
      edgeFaceCount.get(key)!.faces.push(face);
    }
  }

  let minDihedral = Infinity;
  let maxDihedral = 0;
  let totalDihedral = 0;
  let sharpEdges = 0;
  let count = 0;

  for (const { faces } of edgeFaceCount.values()) {
    if (faces.length !== 2) continue;

    const [f1, f2] = faces;
    if (!f1 || !f2) continue;

    const dot = f1.normal.x * f2.normal.x + f1.normal.y * f2.normal.y + f1.normal.z * f2.normal.z;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);

    minDihedral = Math.min(minDihedral, angle);
    maxDihedral = Math.max(maxDihedral, angle);
    totalDihedral += angle;
    count++;

    if (angle > 150) sharpEdges++;
  }

  return {
    minDihedral: count > 0 ? minDihedral : 0,
    maxDihedral: count > 0 ? maxDihedral : 0,
    avgDihedral: count > 0 ? totalDihedral / count : 0,
    sharpEdges,
  };
}

function edgeKey(v1: Vec3, v2: Vec3): string {
  if (v1.x < v2.x || (v1.x === v2.x && v1.y < v2.y) || (v1.x === v2.x && v1.y === v2.y && v1.z < v2.z)) {
    return `${v1.x},${v1.y},${v1.z}-${v2.x},${v2.y},${v2.z}`;
  }
  return `${v2.x},${v2.y},${v2.z}-${v1.x},${v1.y},${v1.z}`;
}

export interface FaceAspectRatio {
  faceId: string;
  aspectRatio: number;
  perimeter: number;
  area: number;
}

export function computeFaceAspectRatios(body: SolidBody): FaceAspectRatio[] {
  return body.faces.map((face) => {
    const verts = face.vertices;
    let perimeter = 0;
    let minEdge = Infinity;
    let maxEdge = 0;

    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      const len = Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2 + (v2.z - v1.z) ** 2);
      perimeter += len;
      minEdge = Math.min(minEdge, len);
      maxEdge = Math.max(maxEdge, len);
    }

    const area = computeFaceArea(face);
    const aspectRatio = minEdge > 1e-10 ? maxEdge / minEdge : 0;

    return {
      faceId: face.id,
      aspectRatio,
      perimeter,
      area,
    };
  });
}

export function computeWorstFaceAspectRatio(body: SolidBody): FaceAspectRatio | null {
  const ratios = computeFaceAspectRatios(body);
  if (ratios.length === 0) return null;
  return ratios.reduce((worst, curr) => curr.aspectRatio > worst.aspectRatio ? curr : worst);
}

export interface EdgeCurvature {
  edgeId: string;
  length: number;
  curvature: number; // 1/radius approximation
}

export function computeEdgeCurvatures(body: SolidBody): EdgeCurvature[] {
  return body.edges.map((edge) => {
    const length = computeEdgeLength(edge);
    // Approximate curvature as inverse of edge length (shorter edges = higher curvature)
    const curvature = length > 1e-10 ? 1 / length : 0;
    return {
      edgeId: edge.id,
      length,
      curvature,
    };
  });
}

export function computeMaxEdgeCurvature(body: SolidBody): EdgeCurvature | null {
  const curvatures = computeEdgeCurvatures(body);
  if (curvatures.length === 0) return null;
  return curvatures.reduce((max, curr) => curr.curvature > max.curvature ? curr : max);
}

export interface NormalConsistency {
  consistent: boolean;
  inwardFaces: number;
  outwardFaces: number;
  flippedFaces: number;
}

export function checkNormalConsistency(body: SolidBody): NormalConsistency {
  // Orientation is consistent iff no directed edge is traversed the same way by
  // two faces (a properly oriented closed mesh shares each edge in opposite
  // directions). This is correct for non-convex shapes too — unlike a
  // centroid-based heuristic, which mislabels e.g. a torus's inner walls.
  const q = (n: number) => Math.round(n / 1e-6) * 1e-6;
  const key = (v: Vec3) => `${q(v.x)},${q(v.y)},${q(v.z)}`;
  const directed = new Map<string, number>();
  let degenerate = 0;

  for (const face of body.faces) {
    const vs = face.vertices;
    if (vs.length < 3) {
      degenerate++;
      continue;
    }
    for (let i = 0; i < vs.length; i++) {
      const dk = `${key(vs[i]!)}>${key(vs[(i + 1) % vs.length]!)}`;
      directed.set(dk, (directed.get(dk) ?? 0) + 1);
    }
  }

  let sameDirectionEdges = 0;
  for (const count of directed.values()) if (count > 1) sameDirectionEdges += count - 1;
  const consistent = sameDirectionEdges === 0;

  // Signed volume sign tells whether the consistent winding faces outward.
  let signed = 0;
  for (const face of body.faces) {
    const vs = face.vertices;
    for (let i = 1; i < vs.length - 1; i++) {
      signed += signedTriangleVolume(vs[0]!, vs[i]!, vs[i + 1]!);
    }
  }
  const faceCount = body.faces.length - degenerate;
  const outward = signed >= 0 ? faceCount : 0;
  const inward = signed >= 0 ? 0 : faceCount;

  return {
    consistent,
    inwardFaces: inward,
    outwardFaces: outward,
    flippedFaces: degenerate,
  };
}

export interface EdgeAngleDistribution {
  minAngle: number;
  maxAngle: number;
  avgAngle: number;
  acuteEdges: number; // < 90°
  obtuseEdges: number; // > 90°
  rightEdges: number; // ≈ 90°
}

export function computeEdgeAngleDistribution(body: SolidBody): EdgeAngleDistribution {
  let minAngle = Infinity;
  let maxAngle = 0;
  let totalAngle = 0;
  let acute = 0;
  let obtuse = 0;
  let right = 0;
  let count = 0;

  // Compute angles between adjacent edges at each vertex
  const vertexEdges = new Map<string, typeof body.edges>();

  for (const edge of body.edges) {
    const startKey = `${edge.start.x},${edge.start.y},${edge.start.z}`;
    const endKey = `${edge.end.x},${edge.end.y},${edge.end.z}`;

    if (!vertexEdges.has(startKey)) vertexEdges.set(startKey, []);
    vertexEdges.get(startKey)!.push(edge);

    if (!vertexEdges.has(endKey)) vertexEdges.set(endKey, []);
    vertexEdges.get(endKey)!.push(edge);
  }

  for (const edges of vertexEdges.values()) {
    if (edges.length < 2) continue;

    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const e1 = edges[i]!;
        const e2 = edges[j]!;

        const d1 = {
          x: e1.end.x - e1.start.x,
          y: e1.end.y - e1.start.y,
          z: e1.end.z - e1.start.z,
        };
        const d2 = {
          x: e2.end.x - e2.start.x,
          y: e2.end.y - e2.start.y,
          z: e2.end.z - e2.start.z,
        };

        const dot = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
        const len1 = Math.sqrt(d1.x * d1.x + d1.y * d1.y + d1.z * d1.z);
        const len2 = Math.sqrt(d2.x * d2.x + d2.y * d2.y + d2.z * d2.z);

        if (len1 < 1e-10 || len2 < 1e-10) continue;

        const cosAngle = Math.max(-1, Math.min(1, dot / (len1 * len2)));
        const angle = Math.acos(cosAngle) * (180 / Math.PI);

        minAngle = Math.min(minAngle, angle);
        maxAngle = Math.max(maxAngle, angle);
        totalAngle += angle;
        count++;

        if (angle < 85) acute++;
        else if (angle > 95) obtuse++;
        else right++;
      }
    }
  }

  return {
    minAngle: count > 0 ? minAngle : 0,
    maxAngle: count > 0 ? maxAngle : 0,
    avgAngle: count > 0 ? totalAngle / count : 0,
    acuteEdges: acute,
    obtuseEdges: obtuse,
    rightEdges: right,
  };
}

export interface FaceRegularity {
  faceId: string;
  isRegular: boolean;
  edgeLengthVariance: number;
  angleVariance: number;
  sideCount: number;
}

export function computeFaceRegularity(body: SolidBody): FaceRegularity[] {
  return body.faces.map((face) => {
    const verts = face.vertices;
    const n = verts.length;

    if (n < 3) {
      return { faceId: face.id, isRegular: false, edgeLengthVariance: 0, angleVariance: 0, sideCount: n };
    }

    // Compute edge lengths
    const edgeLengths: number[] = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      edgeLengths.push(Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2 + (v2.z - v1.z) ** 2));
    }

    // Compute angles
    const angles: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      const v0 = verts[prev]!;
      const v1 = verts[i]!;
      const v2 = verts[next]!;

      const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
      const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      const lenA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const lenB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);

      if (lenA > 1e-10 && lenB > 1e-10) {
        angles.push(Math.acos(Math.max(-1, Math.min(1, dot / (lenA * lenB)))) * (180 / Math.PI));
      }
    }

    // Compute variance
    const avgLen = edgeLengths.reduce((s, l) => s + l, 0) / n;
    const lenVariance = edgeLengths.reduce((s, l) => s + (l - avgLen) ** 2, 0) / n;

    const avgAngle = angles.length > 0 ? angles.reduce((s, a) => s + a, 0) / angles.length : 0;
    const angleVariance = angles.length > 0 ? angles.reduce((s, a) => s + (a - avgAngle) ** 2, 0) / angles.length : 0;

    const isRegular = lenVariance < 0.01 && angleVariance < 1;

    return {
      faceId: face.id,
      isRegular,
      edgeLengthVariance: lenVariance,
      angleVariance,
      sideCount: n,
    };
  });
}

export function computeRegularFaceCount(body: SolidBody): number {
  return computeFaceRegularity(body).filter((f) => f.isRegular).length;
}

export interface EdgeLengthDistribution {
  minLength: number;
  maxLength: number;
  avgLength: number;
  medianLength: number;
  stdDeviation: number;
  histogram: Map<number, number>; // bucket -> count
}

export function computeEdgeLengthDistribution(body: SolidBody): EdgeLengthDistribution {
  const lengths = body.edges.map((e) => computeEdgeLength(e)).sort((a, b) => a - b);

  if (lengths.length === 0) {
    return { minLength: 0, maxLength: 0, avgLength: 0, medianLength: 0, stdDeviation: 0, histogram: new Map() };
  }

  const min = lengths[0]!;
  const max = lengths[lengths.length - 1]!;
  const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
  const median = lengths.length % 2 === 0
    ? (lengths[lengths.length / 2 - 1]! + lengths[lengths.length / 2]!) / 2
    : lengths[Math.floor(lengths.length / 2)]!;

  const variance = lengths.reduce((s, l) => s + (l - avg) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);

  // Create histogram with 10 buckets
  const bucketSize = (max - min) / 10 || 1;
  const histogram = new Map<number, number>();
  for (const len of lengths) {
    const bucket = Math.min(9, Math.floor((len - min) / bucketSize));
    histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
  }

  return {
    minLength: min,
    maxLength: max,
    avgLength: avg,
    medianLength: median,
    stdDeviation: stdDev,
    histogram,
  };
}

export interface FaceAngleDistribution {
  minAngle: number;
  maxAngle: number;
  avgAngle: number;
  acuteFaces: number;
  obtuseFaces: number;
  rightFaces: number;
}

export function computeFaceAngleDistribution(body: SolidBody): FaceAngleDistribution {
  let minAngle = Infinity;
  let maxAngle = 0;
  let totalAngle = 0;
  let acute = 0;
  let obtuse = 0;
  let right = 0;
  let count = 0;

  for (const face of body.faces) {
    const verts = face.vertices;
    const n = verts.length;
    if (n < 3) continue;

    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      const v0 = verts[prev]!;
      const v1 = verts[i]!;
      const v2 = verts[next]!;

      const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
      const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      const lenA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const lenB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);

      if (lenA < 1e-10 || lenB < 1e-10) continue;

      const cosAngle = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const angle = Math.acos(cosAngle) * (180 / Math.PI);

      minAngle = Math.min(minAngle, angle);
      maxAngle = Math.max(maxAngle, angle);
      totalAngle += angle;
      count++;

      if (angle < 85) acute++;
      else if (angle > 95) obtuse++;
      else right++;
    }
  }

  return {
    minAngle: count > 0 ? minAngle : 0,
    maxAngle: count > 0 ? maxAngle : 0,
    avgAngle: count > 0 ? totalAngle / count : 0,
    acuteFaces: acute,
    obtuseFaces: obtuse,
    rightFaces: right,
  };
}

export interface EdgeLengthRatio {
  shortestEdgeId: string;
  longestEdgeId: string;
  ratio: number; // shortest / longest
  normalizedRatio: number; // 0-1, 1 = all edges same length
}

export function computeEdgeLengthRatio(body: SolidBody): EdgeLengthRatio {
  if (body.edges.length === 0) {
    return { shortestEdgeId: '', longestEdgeId: '', ratio: 0, normalizedRatio: 0 };
  }

  let shortest = Infinity;
  let longest = 0;
  let shortestId = '';
  let longestId = '';

  for (const edge of body.edges) {
    const len = computeEdgeLength(edge);
    if (len < shortest) {
      shortest = len;
      shortestId = edge.id;
    }
    if (len > longest) {
      longest = len;
      longestId = edge.id;
    }
  }

  const ratio = longest > 1e-10 ? shortest / longest : 0;
  const normalizedRatio = 1 - ratio; // 0 = all same, 1 = very different

  return {
    shortestEdgeId: shortestId,
    longestEdgeId: longestId,
    ratio,
    normalizedRatio,
  };
}

export interface FaceTypeCount {
  triangles: number;
  quads: number;
  pentagons: number;
  hexagons: number;
  other: number;
}

export function computeFaceTypeCount(body: SolidBody): FaceTypeCount {
  let triangles = 0;
  let quads = 0;
  let pentagons = 0;
  let hexagons = 0;
  let other = 0;

  for (const face of body.faces) {
    const n = face.vertices.length;
    if (n === 3) triangles++;
    else if (n === 4) quads++;
    else if (n === 5) pentagons++;
    else if (n === 6) hexagons++;
    else other++;
  }

  return { triangles, quads, pentagons, hexagons, other };
}

export interface EdgeTypeCount {
  boundary: number;
  interior: number;
  nonManifold: number;
  smooth: number;
  sharp: number;
}

export function computeEdgeTypeCount(body: SolidBody): EdgeTypeCount {
  const edgeFaceCount = new Map<string, number>();

  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      const key = edgeKey(v1, v2);
      edgeFaceCount.set(key, (edgeFaceCount.get(key) ?? 0) + 1);
    }
  }

  let boundary = 0;
  let interior = 0;
  let nonManifold = 0;

  for (const count of edgeFaceCount.values()) {
    if (count === 1) boundary++;
    else if (count === 2) interior++;
    else nonManifold++;
  }

  // Classify by dihedral angle
  let smooth = 0;
  let sharp = 0;
  for (const edge of body.edges) {
    const key = edgeKey(edge.start, edge.end);
    const faceCount = edgeFaceCount.get(key) ?? 0;
    if (faceCount === 2) {
      // Find the two faces and compute dihedral
      const faces = body.faces.filter((f) => {
        const verts = f.vertices;
        for (let i = 0; i < verts.length; i++) {
          const next = (i + 1) % verts.length;
          if (edgeKey(verts[i]!, verts[next]!) === key) return true;
        }
        return false;
      });
      if (faces.length === 2) {
        const f1 = faces[0]!;
        const f2 = faces[1]!;
        const dot = f1.normal.x * f2.normal.x + f1.normal.y * f2.normal.y + f1.normal.z * f2.normal.z;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
        if (angle > 30) sharp++;
        else smooth++;
      }
    }
  }

  return { boundary, interior, nonManifold, smooth, sharp };
}

export interface VertexTypeCount {
  regular: number; // valence 6 for interior, 4 for boundary
  irregular: number;
  corner: number; // valence <= 3
  dart: number; // valence 4 on boundary
  crease: number; // valence 4 with 2 boundary edges
}

export function computeVertexTypeCount(body: SolidBody): VertexTypeCount {
  const degrees = computeVertexDegrees(body);
  const adjacency = computeAdjacency(body);

  let regular = 0;
  let irregular = 0;
  let corner = 0;
  let dart = 0;
  let crease = 0;

  for (const [idx, deg] of degrees) {
    const edgeIndices = adjacency.vertexToEdges.get(idx) ?? [];

    // Count boundary edges for this vertex
    let boundaryEdgeCount = 0;
    for (const ei of edgeIndices) {
      const faces = adjacency.edgeToFaces.get(ei) ?? [];
      if (faces.length === 1) boundaryEdgeCount++;
    }

    const isBoundary = boundaryEdgeCount > 0;

    if (isBoundary) {
      if (deg <= 3) corner++;
      else if (deg === 4 && boundaryEdgeCount === 1) dart++;
      else if (deg === 4 && boundaryEdgeCount === 2) crease++;
      else if (deg === 4) regular++;
      else irregular++;
    } else {
      if (deg === 6) regular++;
      else if (deg <= 3) corner++;
      else irregular++;
    }
  }

  return { regular, irregular, corner, dart, crease };
}

export interface MeshGenus {
  genus: number;
  eulerCharacteristic: number;
  handles: number; // Same as genus for orientable surfaces
  crossCaps: number; // For non-orientable surfaces
  isOrientable: boolean;
}

export function computeMeshGenus(body: SolidBody): MeshGenus {
  const topo = computeTopology(body);

  // For a closed orientable surface: χ = 2 - 2g
  // g = (2 - χ) / 2
  const genus = Math.max(0, Math.round((2 - topo.eulerCharacteristic) / 2));

  // For non-orientable surfaces: χ = 2 - k (where k is cross-cap number)
  const crossCaps = Math.max(0, 2 - topo.eulerCharacteristic);

  // A surface is orientable if it has no cross-caps
  // In practice, we check if the winding is consistent
  const winding = checkWindingOrder(body);
  const isOrientable = winding.consistentWinding;

  return {
    genus: isOrientable ? genus : 0,
    eulerCharacteristic: topo.eulerCharacteristic,
    handles: genus,
    crossCaps: isOrientable ? 0 : crossCaps,
    isOrientable,
  };
}

export interface SymmetryInfo {
  hasXSymmetry: boolean;
  hasYSymmetry: boolean;
  hasZSymmetry: boolean;
  symmetryScore: number; // 0-1, 1 = perfectly symmetric
}

export function computeSymmetry(body: SolidBody): SymmetryInfo {
  const center = computeCentroid(body);

  // Mirror symmetry across the centre plane perpendicular to `axis`: every
  // vertex should have a partner whose `axis` coordinate is reflected and whose
  // other two coordinates match.
  const others: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  const checkAxisSymmetry = (axis: 'x' | 'y' | 'z'): boolean => {
    const tolerance = 1e-3;
    const rest = others.filter((a) => a !== axis);
    let symmetricCount = 0;

    for (const v of body.vertices) {
      const mirrored = 2 * center[axis] - v[axis];
      const hasMatch = body.vertices.some(
        (o) =>
          Math.abs(o[axis] - mirrored) < tolerance &&
          rest.every((a) => Math.abs(o[a] - v[a]) < tolerance),
      );
      if (hasMatch) symmetricCount++;
    }

    return body.vertices.length > 0 && symmetricCount / body.vertices.length > 0.95;
  };

  const hasX = checkAxisSymmetry('x');
  const hasY = checkAxisSymmetry('y');
  const hasZ = checkAxisSymmetry('z');

  const symmetryScore = (Number(hasX) + Number(hasY) + Number(hasZ)) / 3;

  return {
    hasXSymmetry: hasX,
    hasYSymmetry: hasY,
    hasZSymmetry: hasZ,
    symmetryScore,
  };
}

export interface CompactnessInfo {
  compactness: number; // 36π * V² / A³ (1 for sphere)
  sphericity: number; // Similar to compactness, normalized
  efficiency: number; // Volume / Surface area ratio
  isCompact: boolean; // compactness > 0.5
}

export function computeCompactness(body: SolidBody): CompactnessInfo {
  const volume = computeVolume(body);
  const area = computeSurfaceArea(body);

  if (area < 1e-10 || volume < 1e-10) {
    return { compactness: 0, sphericity: 0, efficiency: 0, isCompact: false };
  }

  // Compactness: 36π * V² / A³ (equals 1 for a perfect sphere)
  const compactness = (36 * Math.PI * volume * volume) / (area * area * area);

  // Sphericity: cube root of compactness
  const sphericity = Math.cbrt(compactness);

  // Efficiency: volume to surface area ratio
  const efficiency = volume / area;

  return {
    compactness,
    sphericity,
    efficiency,
    isCompact: compactness > 0.5,
  };
}

export interface ElongationInfo {
  elongation: number; // Longest axis / Shortest axis
  flatness: number; // Middle axis / Shortest axis
  principalAxes: { x: number; y: number; z: number };
  isElongated: boolean;
  isFlat: boolean;
}

export function computeElongation(body: SolidBody): ElongationInfo {
  const bb = computeBoundingBox(body);
  const dx = bb.max.x - bb.min.x;
  const dy = bb.max.y - bb.min.y;
  const dz = bb.max.z - bb.min.z;

  // Sort dimensions
  const dims = [dx, dy, dz].sort((a, b) => a - b);
  const shortest = dims[0] || 1;
  const middle = dims[1] || 1;
  const longest = dims[2] || 1;

  const elongation = longest / shortest;
  const flatness = middle / shortest;

  return {
    elongation,
    flatness,
    principalAxes: { x: dx, y: dy, z: dz },
    isElongated: elongation > 3,
    // Flat = one dimension much smaller than the other two, i.e. a high
    // middle/shortest ratio (a plate/slab). A square-section rod has flatness 1.
    isFlat: flatness > 3,
  };
}

export interface ConvexityInfo {
  convexity: number; // Fraction of faces whose plane keeps all vertices on the inner side
  isConvex: boolean;
  concavity: number; // 1 - convexity
  convexDefect: number; // Number of faces violated by some vertex (0 = convex)
}

export function computeConvexity(body: SolidBody): ConvexityInfo {
  // A polyhedron is convex iff it equals the intersection of its face
  // half-spaces — i.e. every vertex lies on the inner side of every (outward)
  // face plane. This needs no convex-hull construction, only correct normals.
  const faces = body.faces;
  if (faces.length === 0 || body.vertices.length === 0) {
    return { convexity: 0, isConvex: false, concavity: 1, convexDefect: 0 };
  }

  const bb = computeBoundingBox(body);
  const scale = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
  const tol = scale * 1e-4;

  let convexFaces = 0;
  for (const f of faces) {
    if (f.vertices.length < 3) {
      convexFaces++;
      continue;
    }
    const p = f.vertices[0]!;
    // Use the geometric (true) face-plane normal, oriented to match the stored
    // outward normal — stored normals can be per-vertex approximations (sphere).
    const gn = computeFaceNormal(p, f.vertices[1]!, f.vertices[2]!);
    const sign = gn.x * f.normal.x + gn.y * f.normal.y + gn.z * f.normal.z < 0 ? -1 : 1;
    const nx = gn.x * sign;
    const ny = gn.y * sign;
    const nz = gn.z * sign;
    let convex = true;
    for (const v of body.vertices) {
      // Distance in front of the outward face plane; > tol means it protrudes.
      if ((v.x - p.x) * nx + (v.y - p.y) * ny + (v.z - p.z) * nz > tol) {
        convex = false;
        break;
      }
    }
    if (convex) convexFaces++;
  }

  const convexity = convexFaces / faces.length;
  return {
    convexity,
    isConvex: convexity > 0.999,
    concavity: 1 - convexity,
    convexDefect: faces.length - convexFaces,
  };
}

export interface SolidityInfo {
  solidity: number; // Volume / Convex hull volume
  isSolid: boolean;
  voidRatio: number; // 1 - solidity
  internalCavities: number; // Estimated number of internal voids
}

export function computeSolidity(body: SolidBody): SolidityInfo {
  const volume = computeVolume(body);
  if (volume < 1e-10) {
    return { solidity: 0, isSolid: false, voidRatio: 1, internalCavities: 0 };
  }

  // Solidity is volume / convex-hull volume. A convex solid equals its own
  // hull, so its solidity is exactly 1 — short-circuit those (a sphere/
  // cylinder/cone otherwise read ~0.5 against a bounding-box hull proxy and
  // were wrongly flagged as full of voids).
  if (computeConvexity(body).isConvex) {
    return { solidity: 1, isSolid: true, voidRatio: 0, internalCavities: 0 };
  }

  // Non-convex: approximate the hull with the bounding box. The box is at least
  // as big as the hull, so this under-estimates solidity (clamp to ≤ 1).
  const bb = computeBoundingBox(body);
  const hullVolume = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) * (bb.max.z - bb.min.z);

  const solidity = hullVolume > 1e-10 ? Math.min(1, volume / hullVolume) : 0;
  const voidRatio = 1 - solidity;

  // Estimate internal cavities based on void ratio
  const internalCavities = voidRatio > 0.3 ? Math.ceil(voidRatio * 5) : 0;

  return {
    solidity,
    isSolid: solidity > 0.8,
    voidRatio,
    internalCavities,
  };
}

export interface RoughnessInfo {
  roughness: number; // Average deviation from smooth surface
  smoothness: number; // 1 - roughness
  isSmooth: boolean;
  roughFaces: number;
  smoothFaces: number;
}

export function computeRoughness(body: SolidBody): RoughnessInfo {
  const centroid = computeCentroid(body);
  let totalDeviation = 0;
  let roughFaces = 0;
  let smoothFaces = 0;
  let faceCount = 0;

  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;

    // Compute face centroid
    let fx = 0, fy = 0, fz = 0;
    for (const v of verts) {
      fx += v.x;
      fy += v.y;
      fz += v.z;
    }
    fx /= verts.length;
    fy /= verts.length;
    fz /= verts.length;

    // Distance from body centroid to face centroid
    const dist = Math.sqrt(
      (fx - centroid.x) ** 2 +
      (fy - centroid.y) ** 2 +
      (fz - centroid.z) ** 2,
    );

    // Average vertex distance from face centroid
    let avgVertexDist = 0;
    for (const v of verts) {
      avgVertexDist += Math.sqrt(
        (v.x - fx) ** 2 +
        (v.y - fy) ** 2 +
        (v.z - fz) ** 2,
      );
    }
    avgVertexDist /= verts.length;

    // Roughness is deviation from expected smooth distance
    const expectedDist = dist * 0.1; // Rough heuristic
    const deviation = Math.abs(avgVertexDist - expectedDist) / (expectedDist || 1);
    totalDeviation += deviation;

    if (deviation > 0.5) roughFaces++;
    else smoothFaces++;
    faceCount++;
  }

  const roughness = faceCount > 0 ? totalDeviation / faceCount : 0;
  const smoothness = 1 - Math.min(1, roughness);

  return {
    roughness,
    smoothness,
    isSmooth: roughness < 0.3,
    roughFaces,
    smoothFaces,
  };
}

export interface ThicknessInfo {
  minThickness: number;
  maxThickness: number;
  avgThickness: number;
  isThin: boolean;
  thinRegions: number;
}

/** Möller–Trumbore ray/triangle intersection; returns the positive hit distance or null. */
function rayTriangleDistance(orig: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const ex1 = b.x - a.x, ey1 = b.y - a.y, ez1 = b.z - a.z;
  const ex2 = c.x - a.x, ey2 = c.y - a.y, ez2 = c.z - a.z;
  const px = dir.y * ez2 - dir.z * ey2;
  const py = dir.z * ex2 - dir.x * ez2;
  const pz = dir.x * ey2 - dir.y * ex2;
  const det = ex1 * px + ey1 * py + ez1 * pz;
  if (Math.abs(det) < 1e-12) return null; // parallel
  const inv = 1 / det;
  const tx = orig.x - a.x, ty = orig.y - a.y, tz = orig.z - a.z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * ez1 - tz * ey1;
  const qy = tz * ex1 - tx * ez1;
  const qz = tx * ey1 - ty * ex1;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (ex2 * qx + ey2 * qy + ez2 * qz) * inv;
  return t > 1e-9 ? t : null;
}

/**
 * Wall thickness by inward ray casting: from each face, shoot a ray along the
 * inward normal and measure the distance to the opposite wall (the standard
 * thickness probe used by slicers). Unlike a bounding-box proxy this reports the
 * true wall thickness of hollow/shelled parts — the case that actually matters
 * for printability. O(faces × triangles); faces are sampled when the mesh is
 * large to bound the cost.
 */
export function computeThickness(body: SolidBody): ThicknessInfo {
  const bb = computeBoundingBox(body);
  const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
  const eps = diag * 1e-5;

  // Pre-triangulate all faces once for ray targets.
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (const f of body.faces) {
    for (let i = 1; i < f.vertices.length - 1; i++) {
      tris.push([f.vertices[0]!, f.vertices[i]!, f.vertices[i + 1]!]);
    }
  }

  // Sample faces to keep the O(F²) probe bounded on large meshes.
  const faces = body.faces.filter((f) => f.vertices.length >= 3);
  const step = Math.max(1, Math.floor(faces.length / 400));

  const samples: number[] = [];
  for (let fi = 0; fi < faces.length; fi += step) {
    const face = faces[fi]!;
    const n = normalize(face.normal);
    if (n.x === 0 && n.y === 0 && n.z === 0) continue;
    // Centroid, nudged just inside the surface so we don't hit our own face.
    let cx = 0, cy = 0, cz = 0;
    for (const v of face.vertices) {
      cx += v.x / face.vertices.length;
      cy += v.y / face.vertices.length;
      cz += v.z / face.vertices.length;
    }
    const dir = { x: -n.x, y: -n.y, z: -n.z }; // inward
    const orig = { x: cx + dir.x * eps, y: cy + dir.y * eps, z: cz + dir.z * eps };

    let nearest = Infinity;
    for (const [a, b, c] of tris) {
      const t = rayTriangleDistance(orig, dir, a, b, c);
      if (t !== null && t < nearest) nearest = t;
    }
    if (nearest < Infinity) samples.push(nearest + eps);
  }

  if (samples.length === 0) {
    const fallback = Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    return { minThickness: fallback, maxThickness: fallback, avgThickness: fallback, isThin: false, thinRegions: 0 };
  }

  const minThickness = Math.min(...samples);
  const maxThickness = Math.max(...samples);
  const avgThickness = samples.reduce((s, t) => s + t, 0) / samples.length;
  // Thin if the minimum wall is a small fraction of the part's overall size.
  const thinLimit = diag * 0.02;
  const thinRegions = samples.filter((t) => t < thinLimit).length;

  return {
    minThickness,
    maxThickness,
    avgThickness,
    isThin: minThickness < thinLimit,
    thinRegions,
  };
}

/**
 * Eigenvalues of a symmetric 3×3 matrix, returned in descending order. Uses
 * the closed-form trigonometric solution (Smith 1961); falls back to the
 * diagonal when the off-diagonal terms vanish.
 */
function symmetricEigenvalues3(a: number[][]): [number, number, number] {
  const a11 = a[0]![0]!;
  const a22 = a[1]![1]!;
  const a33 = a[2]![2]!;
  const a12 = a[0]![1]!;
  const a13 = a[0]![2]!;
  const a23 = a[1]![2]!;

  const p1 = a12 * a12 + a13 * a13 + a23 * a23;
  if (p1 < 1e-18) {
    const e = [a11, a22, a33].sort((x, y) => y - x);
    return [e[0]!, e[1]!, e[2]!];
  }

  const q = (a11 + a22 + a33) / 3;
  const p2 = (a11 - q) ** 2 + (a22 - q) ** 2 + (a33 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);

  // B = (1/p)(A - qI); r = det(B)/2.
  const b11 = (a11 - q) / p;
  const b22 = (a22 - q) / p;
  const b33 = (a33 - q) / p;
  const b12 = a12 / p;
  const b13 = a13 / p;
  const b23 = a23 / p;
  const detB =
    b11 * (b22 * b33 - b23 * b23) -
    b12 * (b12 * b33 - b23 * b13) +
    b13 * (b12 * b23 - b22 * b13);
  let r = detB / 2;
  r = Math.max(-1, Math.min(1, r));

  const phi = Math.acos(r) / 3;
  const eig1 = q + 2 * p * Math.cos(phi); // largest
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3); // smallest
  const eig2 = 3 * q - eig1 - eig3;
  return [eig1, eig2, eig3];
}

export interface PrincipalMoments {
  /** Principal moments of inertia about the center of mass, descending. */
  moments: [number, number, number];
  /** Radii of gyration k = sqrt(I / mass) for each principal moment. */
  radiiOfGyration: [number, number, number];
}

/**
 * Principal moments of inertia (eigenvalues of the inertia tensor about the
 * center of mass) and the corresponding radii of gyration. These are the
 * body's natural rotation axes — the smallest principal moment is the axis it
 * most readily spins about.
 */
export function computePrincipalMoments(body: SolidBody, density = 1): PrincipalMoments {
  const mp = computeMassProperties(body, density);
  const i = mp.inertia;
  const tensor = [
    [i.ixx, i.ixy, i.ixz],
    [i.ixy, i.iyy, i.iyz],
    [i.ixz, i.iyz, i.izz],
  ];
  const moments = symmetricEigenvalues3(tensor);
  const m = mp.mass;
  const k = (v: number): number => (m > 1e-12 ? Math.sqrt(Math.max(0, v) / m) : 0);
  return { moments, radiiOfGyration: [k(moments[0]), k(moments[1]), k(moments[2])] };
}

export interface CenterOfMassInfo {
  centroid: Vec3;
  boundingBoxCenter: Vec3;
  offset: Vec3;
  offsetDistance: number;
  isCentered: boolean;
}

export function computeCenterOfMassOffset(body: SolidBody): CenterOfMassInfo {
  // Use the true (volume-weighted) center of mass, not the vertex average.
  const centroid = computeVolumetricCentroid(body);
  const bbCenter = computeBoundingBoxCenter(body);

  const offset = {
    x: centroid.x - bbCenter.x,
    y: centroid.y - bbCenter.y,
    z: centroid.z - bbCenter.z,
  };

  const offsetDistance = Math.sqrt(offset.x ** 2 + offset.y ** 2 + offset.z ** 2);
  const bb = computeBoundingBox(body);
  const bbSize = Math.sqrt(
    (bb.max.x - bb.min.x) ** 2 +
    (bb.max.y - bb.min.y) ** 2 +
    (bb.max.z - bb.min.z) ** 2,
  );

  return {
    centroid,
    boundingBoxCenter: bbCenter,
    offset,
    offsetDistance,
    isCentered: bbSize > 1e-10 ? offsetDistance / bbSize < 0.1 : true,
  };
}

export interface VolumeRatioInfo {
  volumeToSurfaceRatio: number;
  volumeToBoundingBoxRatio: number;
  surfaceToBoundingBoxRatio: number;
  isVolumetricallyEfficient: boolean;
}

export function computeVolumeRatios(body: SolidBody): VolumeRatioInfo {
  const volume = computeVolume(body);
  const surface = computeSurfaceArea(body);
  const bb = computeBoundingBox(body);
  const bbVolume = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y) * (bb.max.z - bb.min.z);

  const volumeToSurfaceRatio = surface > 1e-10 ? volume / surface : 0;
  const volumeToBoundingBoxRatio = bbVolume > 1e-10 ? volume / bbVolume : 0;
  const surfaceToBoundingBoxRatio = bbVolume > 1e-10 ? surface / bbVolume : 0;

  return {
    volumeToSurfaceRatio,
    volumeToBoundingBoxRatio,
    surfaceToBoundingBoxRatio,
    isVolumetricallyEfficient: volumeToBoundingBoxRatio > 0.5,
  };
}

export interface AspectRatioDistribution {
  minAspectRatio: number;
  maxAspectRatio: number;
  avgAspectRatio: number;
  stdDeviation: number;
  goodAspectRatioFaces: number; // AR < 3
  poorAspectRatioFaces: number; // AR >= 3
}

export function computeAspectRatioDistribution(body: SolidBody): AspectRatioDistribution {
  const ratios: number[] = [];

  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;

    // Compute edge lengths
    const edgeLengths: number[] = [];
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      edgeLengths.push(Math.sqrt((v2.x - v1.x) ** 2 + (v2.y - v1.y) ** 2 + (v2.z - v1.z) ** 2));
    }

    const minEdge = Math.min(...edgeLengths);
    const maxEdge = Math.max(...edgeLengths);
    const ar = minEdge > 1e-10 ? maxEdge / minEdge : 0;
    ratios.push(ar);
  }

  if (ratios.length === 0) {
    return { minAspectRatio: 0, maxAspectRatio: 0, avgAspectRatio: 0, stdDeviation: 0, goodAspectRatioFaces: 0, poorAspectRatioFaces: 0 };
  }

  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  const avg = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const variance = ratios.reduce((s, r) => s + (r - avg) ** 2, 0) / ratios.length;
  const stdDev = Math.sqrt(variance);

  const good = ratios.filter((r) => r < 3).length;
  const poor = ratios.length - good;

  return {
    minAspectRatio: min,
    maxAspectRatio: max,
    avgAspectRatio: avg,
    stdDeviation: stdDev,
    goodAspectRatioFaces: good,
    poorAspectRatioFaces: poor,
  };
}

export interface SkewnessDistribution {
  minSkewness: number;
  maxSkewness: number;
  avgSkewness: number;
  stdDeviation: number;
  goodSkewnessFaces: number; // skewness < 0.5
  poorSkewnessFaces: number; // skewness >= 0.5
}

export function computeSkewnessDistribution(body: SolidBody): SkewnessDistribution {
  const skewnesses: number[] = [];

  for (const face of body.faces) {
    const verts = face.vertices;
    if (verts.length < 3) continue;

    // Compute face centroid
    let cx = 0, cy = 0, cz = 0;
    for (const v of verts) {
      cx += v.x;
      cy += v.y;
      cz += v.z;
    }
    cx /= verts.length;
    cy /= verts.length;
    cz /= verts.length;

    // Compute distances from centroid to vertices
    const distances = verts.map((v) =>
      Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2 + (v.z - cz) ** 2),
    );

    const minDist = Math.min(...distances);
    const maxDist = Math.max(...distances);
    const skewness = maxDist > 1e-10 ? 1 - minDist / maxDist : 0;
    skewnesses.push(skewness);
  }

  if (skewnesses.length === 0) {
    return { minSkewness: 0, maxSkewness: 0, avgSkewness: 0, stdDeviation: 0, goodSkewnessFaces: 0, poorSkewnessFaces: 0 };
  }

  const min = Math.min(...skewnesses);
  const max = Math.max(...skewnesses);
  const avg = skewnesses.reduce((s, r) => s + r, 0) / skewnesses.length;
  const variance = skewnesses.reduce((s, r) => s + (r - avg) ** 2, 0) / skewnesses.length;
  const stdDev = Math.sqrt(variance);

  const good = skewnesses.filter((r) => r < 0.5).length;
  const poor = skewnesses.length - good;

  return {
    minSkewness: min,
    maxSkewness: max,
    avgSkewness: avg,
    stdDeviation: stdDev,
    goodSkewnessFaces: good,
    poorSkewnessFaces: poor,
  };
}

export interface FaceEdgeCountDistribution {
  minEdges: number;
  maxEdges: number;
  avgEdges: number;
  modeEdges: number; // Most common edge count
  histogram: Map<number, number>; // edgeCount -> faceCount
}

export function computeFaceEdgeCountDistribution(body: SolidBody): FaceEdgeCountDistribution {
  const histogram = new Map<number, number>();

  for (const face of body.faces) {
    const n = face.vertices.length;
    histogram.set(n, (histogram.get(n) ?? 0) + 1);
  }

  if (histogram.size === 0) {
    return { minEdges: 0, maxEdges: 0, avgEdges: 0, modeEdges: 0, histogram };
  }

  const counts = Array.from(histogram.keys());
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const totalEdges = body.faces.reduce((s, f) => s + f.vertices.length, 0);
  const avg = totalEdges / body.faces.length;

  // Mode is the most common edge count
  let mode = min;
  let maxCount = 0;
  for (const [edgeCount, faceCount] of histogram) {
    if (faceCount > maxCount) {
      maxCount = faceCount;
      mode = edgeCount;
    }
  }

  return {
    minEdges: min,
    maxEdges: max,
    avgEdges: avg,
    modeEdges: mode,
    histogram,
  };
}

export interface VertexValenceDistribution {
  minValence: number;
  maxValence: number;
  avgValence: number;
  modeValence: number;
  histogram: Map<number, number>; // valence -> vertexCount
  regularVertices: number; // Valence 6 for interior, 4 for boundary
  irregularVertices: number;
}

export function computeVertexValenceDistribution(body: SolidBody): VertexValenceDistribution {
  const degrees = computeVertexDegrees(body);
  const histogram = new Map<number, number>();

  for (const val of degrees.values()) {
    histogram.set(val, (histogram.get(val) ?? 0) + 1);
  }

  if (degrees.size === 0) {
    return { minValence: 0, maxValence: 0, avgValence: 0, modeValence: 0, histogram, regularVertices: 0, irregularVertices: 0 };
  }

  const values = Array.from(degrees.values());
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;

  // Mode
  let mode = min;
  let maxCount = 0;
  for (const [val, count] of histogram) {
    if (count > maxCount) {
      maxCount = count;
      mode = val;
    }
  }

  // Regular vertices: valence 6 for interior, 4 for boundary
  const adjacency = computeAdjacency(body);
  let regular = 0;
  let irregular = 0;

  for (const [idx, deg] of degrees) {
    const edgeIndices = adjacency.vertexToEdges.get(idx) ?? [];
    let boundaryEdgeCount = 0;
    for (const ei of edgeIndices) {
      const faces = adjacency.edgeToFaces.get(ei) ?? [];
      if (faces.length === 1) boundaryEdgeCount++;
    }

    const isBoundary = boundaryEdgeCount > 0;
    const expectedValence = isBoundary ? 4 : 6;

    if (deg === expectedValence) regular++;
    else irregular++;
  }

  return {
    minValence: min,
    maxValence: max,
    avgValence: avg,
    modeValence: mode,
    histogram,
    regularVertices: regular,
    irregularVertices: irregular,
  };
}

export interface EdgeLengthStatistics {
  minLength: number;
  maxLength: number;
  avgLength: number;
  medianLength: number;
  q1Length: number; // 25th percentile
  q3Length: number; // 75th percentile
  iqrLength: number; // Interquartile range
  outlierCount: number; // Edges outside 1.5*IQR
}

export function computeEdgeLengthStatistics(body: SolidBody): EdgeLengthStatistics {
  const lengths = body.edges.map((e) => computeEdgeLength(e)).sort((a, b) => a - b);

  if (lengths.length === 0) {
    return { minLength: 0, maxLength: 0, avgLength: 0, medianLength: 0, q1Length: 0, q3Length: 0, iqrLength: 0, outlierCount: 0 };
  }

  const min = lengths[0]!;
  const max = lengths[lengths.length - 1]!;
  const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;

  const median = lengths.length % 2 === 0
    ? (lengths[lengths.length / 2 - 1]! + lengths[lengths.length / 2]!) / 2
    : lengths[Math.floor(lengths.length / 2)]!;

  const q1Idx = Math.floor(lengths.length * 0.25);
  const q3Idx = Math.floor(lengths.length * 0.75);
  const q1 = lengths[q1Idx]!;
  const q3 = lengths[q3Idx]!;
  const iqr = q3 - q1;

  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const outliers = lengths.filter((l) => l < lowerBound || l > upperBound).length;

  return {
    minLength: min,
    maxLength: max,
    avgLength: avg,
    medianLength: median,
    q1Length: q1,
    q3Length: q3,
    iqrLength: iqr,
    outlierCount: outliers,
  };
}

export interface FaceAreaStatistics {
  minArea: number;
  maxArea: number;
  avgArea: number;
  medianArea: number;
  totalArea: number;
  smallFaces: number; // Area < avg * 0.1
  largeFaces: number; // Area > avg * 10
}

export function computeFaceAreaStatistics(body: SolidBody): FaceAreaStatistics {
  const areas = body.faces.map((f) => computeFaceArea(f)).sort((a, b) => a - b);

  if (areas.length === 0) {
    return { minArea: 0, maxArea: 0, avgArea: 0, medianArea: 0, totalArea: 0, smallFaces: 0, largeFaces: 0 };
  }

  const min = areas[0]!;
  const max = areas[areas.length - 1]!;
  const total = areas.reduce((s, a) => s + a, 0);
  const avg = total / areas.length;
  const median = areas.length % 2 === 0
    ? (areas[areas.length / 2 - 1]! + areas[areas.length / 2]!) / 2
    : areas[Math.floor(areas.length / 2)]!;

  const small = areas.filter((a) => a < avg * 0.1).length;
  const large = areas.filter((a) => a > avg * 10).length;

  return {
    minArea: min,
    maxArea: max,
    avgArea: avg,
    medianArea: median,
    totalArea: total,
    smallFaces: small,
    largeFaces: large,
  };
}

export interface VertexDistanceStatistics {
  minDistance: number;
  maxDistance: number;
  avgDistance: number;
  medianDistance: number;
  closeVertices: number; // Distance < avg * 0.1
  farVertices: number; // Distance > avg * 5
}

export function computeVertexDistanceStatistics(body: SolidBody): VertexDistanceStatistics {
  const centroid = computeCentroid(body);
  const distances = body.vertices
    .map((v) => Math.sqrt((v.x - centroid.x) ** 2 + (v.y - centroid.y) ** 2 + (v.z - centroid.z) ** 2))
    .sort((a, b) => a - b);

  if (distances.length === 0) {
    return { minDistance: 0, maxDistance: 0, avgDistance: 0, medianDistance: 0, closeVertices: 0, farVertices: 0 };
  }

  const min = distances[0]!;
  const max = distances[distances.length - 1]!;
  const avg = distances.reduce((s, d) => s + d, 0) / distances.length;
  const median = distances.length % 2 === 0
    ? (distances[distances.length / 2 - 1]! + distances[distances.length / 2]!) / 2
    : distances[Math.floor(distances.length / 2)]!;

  const close = distances.filter((d) => d < avg * 0.1).length;
  const far = distances.filter((d) => d > avg * 5).length;

  return {
    minDistance: min,
    maxDistance: max,
    avgDistance: avg,
    medianDistance: median,
    closeVertices: close,
    farVertices: far,
  };
}

export interface EdgeAngleStatistics {
  minAngle: number;
  maxAngle: number;
  avgAngle: number;
  medianAngle: number;
  acuteEdges: number; // < 90°
  rightEdges: number; // ≈ 90°
  obtuseEdges: number; // > 90°
  straightEdges: number; // ≈ 180°
}

export function computeEdgeAngleStatistics(body: SolidBody): EdgeAngleStatistics {
  const angles: number[] = [];

  for (const face of body.faces) {
    const verts = face.vertices;
    const n = verts.length;
    if (n < 3) continue;

    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      const v0 = verts[prev]!;
      const v1 = verts[i]!;
      const v2 = verts[next]!;

      const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
      const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      const lenA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const lenB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);

      if (lenA < 1e-10 || lenB < 1e-10) continue;

      const cosAngle = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const angle = Math.acos(cosAngle) * (180 / Math.PI);
      angles.push(angle);
    }
  }

  if (angles.length === 0) {
    return { minAngle: 0, maxAngle: 0, avgAngle: 0, medianAngle: 0, acuteEdges: 0, rightEdges: 0, obtuseEdges: 0, straightEdges: 0 };
  }

  angles.sort((a, b) => a - b);
  const min = angles[0]!;
  const max = angles[angles.length - 1]!;
  const avg = angles.reduce((s, a) => s + a, 0) / angles.length;
  const median = angles.length % 2 === 0
    ? (angles[angles.length / 2 - 1]! + angles[angles.length / 2]!) / 2
    : angles[Math.floor(angles.length / 2)]!;

  const acute = angles.filter((a) => a < 85).length;
  const right = angles.filter((a) => a >= 85 && a <= 95).length;
  const obtuse = angles.filter((a) => a > 95 && a < 175).length;
  const straight = angles.filter((a) => a >= 175).length;

  return {
    minAngle: min,
    maxAngle: max,
    avgAngle: avg,
    medianAngle: median,
    acuteEdges: acute,
    rightEdges: right,
    obtuseEdges: obtuse,
    straightEdges: straight,
  };
}

export interface FaceNormalStatistics {
  avgNormalX: number;
  avgNormalY: number;
  avgNormalZ: number;
  normalVariance: number;
  upwardFaces: number; // Normal pointing up (Z > 0.5)
  downwardFaces: number; // Normal pointing down (Z < -0.5)
  lateralFaces: number; // Other orientations
}

export function computeFaceNormalStatistics(body: SolidBody): FaceNormalStatistics {
  if (body.faces.length === 0) {
    return { avgNormalX: 0, avgNormalY: 0, avgNormalZ: 0, normalVariance: 0, upwardFaces: 0, downwardFaces: 0, lateralFaces: 0 };
  }

  let sumX = 0, sumY = 0, sumZ = 0;
  let upward = 0, downward = 0, lateral = 0;

  for (const face of body.faces) {
    sumX += face.normal.x;
    sumY += face.normal.y;
    sumZ += face.normal.z;

    if (face.normal.z > 0.5) upward++;
    else if (face.normal.z < -0.5) downward++;
    else lateral++;
  }

  const n = body.faces.length;
  const avgX = sumX / n;
  const avgY = sumY / n;
  const avgZ = sumZ / n;

  // Compute variance of normal directions
  let variance = 0;
  for (const face of body.faces) {
    const dx = face.normal.x - avgX;
    const dy = face.normal.y - avgY;
    const dz = face.normal.z - avgZ;
    variance += dx * dx + dy * dy + dz * dz;
  }
  variance /= n;

  return {
    avgNormalX: avgX,
    avgNormalY: avgY,
    avgNormalZ: avgZ,
    normalVariance: variance,
    upwardFaces: upward,
    downwardFaces: downward,
    lateralFaces: lateral,
  };
}

export interface EdgeNormalStatistics {
  avgTangentX: number;
  avgTangentY: number;
  avgTangentZ: number;
  tangentVariance: number;
  horizontalEdges: number; // Tangent mostly horizontal
  verticalEdges: number; // Tangent mostly vertical
  diagonalEdges: number; // Other orientations
}

export function computeEdgeNormalStatistics(body: SolidBody): EdgeNormalStatistics {
  if (body.edges.length === 0) {
    return { avgTangentX: 0, avgTangentY: 0, avgTangentZ: 0, tangentVariance: 0, horizontalEdges: 0, verticalEdges: 0, diagonalEdges: 0 };
  }

  let sumX = 0, sumY = 0, sumZ = 0;
  let horizontal = 0, vertical = 0, diagonal = 0;

  for (const edge of body.edges) {
    const dx = edge.end.x - edge.start.x;
    const dy = edge.end.y - edge.start.y;
    const dz = edge.end.z - edge.start.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (len < 1e-10) continue;

    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    sumX += nx;
    sumY += ny;
    sumZ += nz;

    // Classify edge orientation
    const absX = Math.abs(nx);
    const absY = Math.abs(ny);
    const absZ = Math.abs(nz);

    if (absZ > 0.8) vertical++;
    else if (absX > 0.5 || absY > 0.5) horizontal++;
    else diagonal++;
  }

  const n = body.edges.length;
  const avgX = sumX / n;
  const avgY = sumY / n;
  const avgZ = sumZ / n;

  // Compute variance of tangent directions
  let variance = 0;
  for (const edge of body.edges) {
    const dx = edge.end.x - edge.start.x;
    const dy = edge.end.y - edge.start.y;
    const dz = edge.end.z - edge.start.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) continue;

    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    const ddx = nx - avgX;
    const ddy = ny - avgY;
    const ddz = nz - avgZ;
    variance += ddx * ddx + ddy * ddy + ddz * ddz;
  }
  variance /= n;

  return {
    avgTangentX: avgX,
    avgTangentY: avgY,
    avgTangentZ: avgZ,
    tangentVariance: variance,
    horizontalEdges: horizontal,
    verticalEdges: vertical,
    diagonalEdges: diagonal,
  };
}

export interface EdgeDihedralStatistics {
  minDihedral: number;
  maxDihedral: number;
  avgDihedral: number;
  medianDihedral: number;
  smoothEdges: number; // Dihedral < 30°
  hardEdges: number; // Dihedral 30° - 150°
  sharpEdges: number; // Dihedral > 150°
}

export function computeEdgeDihedralStatistics(body: SolidBody): EdgeDihedralStatistics {
  const edgeFaceCount = new Map<string, { faces: typeof body.faces }>();

  // Group faces by edge
  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const v1 = verts[i]!;
      const v2 = verts[next]!;
      const key = edgeKey(v1, v2);

      if (!edgeFaceCount.has(key)) {
        edgeFaceCount.set(key, { faces: [] });
      }
      edgeFaceCount.get(key)!.faces.push(face);
    }
  }

  const dihedrals: number[] = [];

  for (const { faces } of edgeFaceCount.values()) {
    if (faces.length !== 2) continue;

    const f1 = faces[0]!;
    const f2 = faces[1]!;
    const dot = f1.normal.x * f2.normal.x + f1.normal.y * f2.normal.y + f1.normal.z * f2.normal.z;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
    dihedrals.push(angle);
  }

  if (dihedrals.length === 0) {
    return { minDihedral: 0, maxDihedral: 0, avgDihedral: 0, medianDihedral: 0, smoothEdges: 0, hardEdges: 0, sharpEdges: 0 };
  }

  dihedrals.sort((a, b) => a - b);
  const min = dihedrals[0]!;
  const max = dihedrals[dihedrals.length - 1]!;
  const avg = dihedrals.reduce((s, a) => s + a, 0) / dihedrals.length;
  const median = dihedrals.length % 2 === 0
    ? (dihedrals[dihedrals.length / 2 - 1]! + dihedrals[dihedrals.length / 2]!) / 2
    : dihedrals[Math.floor(dihedrals.length / 2)]!;

  const smooth = dihedrals.filter((a) => a < 30).length;
  const hard = dihedrals.filter((a) => a >= 30 && a <= 150).length;
  const sharp = dihedrals.filter((a) => a > 150).length;

  return {
    minDihedral: min,
    maxDihedral: max,
    avgDihedral: avg,
    medianDihedral: median,
    smoothEdges: smooth,
    hardEdges: hard,
    sharpEdges: sharp,
  };
}

export interface EdgeLengthPercentiles {
  p5: number; // 5th percentile
  p10: number;
  p25: number; // Q1
  p50: number; // Median
  p75: number; // Q3
  p90: number;
  p95: number;
  iqr: number; // Interquartile range
  whiskerLow: number; // Q1 - 1.5*IQR
  whiskerHigh: number; // Q3 + 1.5*IQR
}

export function computeEdgeLengthPercentiles(body: SolidBody): EdgeLengthPercentiles {
  const lengths = body.edges.map((e) => computeEdgeLength(e)).sort((a, b) => a - b);

  if (lengths.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(lengths.length * p / 100);
    return lengths[Math.min(idx, lengths.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, lengths[0]!),
    whiskerHigh: Math.min(whiskerHigh, lengths[lengths.length - 1]!),
  };
}

export interface FaceAreaPercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeFaceAreaPercentiles(body: SolidBody): FaceAreaPercentiles {
  const areas = body.faces.map((f) => computeFaceArea(f)).sort((a, b) => a - b);

  if (areas.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(areas.length * p / 100);
    return areas[Math.min(idx, areas.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, areas[0]!),
    whiskerHigh: Math.min(whiskerHigh, areas[areas.length - 1]!),
  };
}

export interface VertexDistancePercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeVertexDistancePercentiles(body: SolidBody): VertexDistancePercentiles {
  const centroid = computeCentroid(body);
  const distances = body.vertices
    .map((v) => Math.sqrt((v.x - centroid.x) ** 2 + (v.y - centroid.y) ** 2 + (v.z - centroid.z) ** 2))
    .sort((a, b) => a - b);

  if (distances.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(distances.length * p / 100);
    return distances[Math.min(idx, distances.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, distances[0]!),
    whiskerHigh: Math.min(whiskerHigh, distances[distances.length - 1]!),
  };
}

export interface EdgeDihedralPercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeEdgeDihedralPercentiles(body: SolidBody): EdgeDihedralPercentiles {
  const dihedrals: number[] = [];

  // Group faces by edge
  const edgeFaceMap = new Map<string, typeof body.faces>();
  for (const face of body.faces) {
    const verts = face.vertices;
    for (let i = 0; i < verts.length; i++) {
      const next = (i + 1) % verts.length;
      const key = edgeKey(verts[i]!, verts[next]!);
      if (!edgeFaceMap.has(key)) edgeFaceMap.set(key, []);
      edgeFaceMap.get(key)!.push(face);
    }
  }

  for (const faces of edgeFaceMap.values()) {
    if (faces.length !== 2) continue;
    const f1 = faces[0]!;
    const f2 = faces[1]!;
    const dot = f1.normal.x * f2.normal.x + f1.normal.y * f2.normal.y + f1.normal.z * f2.normal.z;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * (180 / Math.PI);
    dihedrals.push(angle);
  }

  dihedrals.sort((a, b) => a - b);

  if (dihedrals.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(dihedrals.length * p / 100);
    return dihedrals[Math.min(idx, dihedrals.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, dihedrals[0]!),
    whiskerHigh: Math.min(whiskerHigh, dihedrals[dihedrals.length - 1]!),
  };
}

export interface EdgeAnglePercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeEdgeAnglePercentiles(body: SolidBody): EdgeAnglePercentiles {
  const angles: number[] = [];

  for (const face of body.faces) {
    const verts = face.vertices;
    const n = verts.length;
    if (n < 3) continue;

    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const next = (i + 1) % n;
      const v0 = verts[prev]!;
      const v1 = verts[i]!;
      const v2 = verts[next]!;

      const a = { x: v0.x - v1.x, y: v0.y - v1.y, z: v0.z - v1.z };
      const b = { x: v2.x - v1.x, y: v2.y - v1.y, z: v2.z - v1.z };
      const dot = a.x * b.x + a.y * b.y + a.z * b.z;
      const lenA = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      const lenB = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);

      if (lenA < 1e-10 || lenB < 1e-10) continue;

      const cosAngle = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const angle = Math.acos(cosAngle) * (180 / Math.PI);
      angles.push(angle);
    }
  }

  angles.sort((a, b) => a - b);

  if (angles.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(angles.length * p / 100);
    return angles[Math.min(idx, angles.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, angles[0]!),
    whiskerHigh: Math.min(whiskerHigh, angles[angles.length - 1]!),
  };
}

export interface FaceNormalPercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeFaceNormalPercentiles(body: SolidBody): FaceNormalPercentiles {
  const centroid = computeCentroid(body);
  const dotProducts: number[] = [];

  for (const face of body.faces) {
    // Dot product of face normal with direction from centroid to face center
    let fx = 0, fy = 0, fz = 0;
    for (const v of face.vertices) {
      fx += v.x;
      fy += v.y;
      fz += v.z;
    }
    fx /= face.vertices.length;
    fy /= face.vertices.length;
    fz /= face.vertices.length;

    const dir = normalize({
      x: fx - centroid.x,
      y: fy - centroid.y,
      z: fz - centroid.z,
    });

    const dot = face.normal.x * dir.x + face.normal.y * dir.y + face.normal.z * dir.z;
    dotProducts.push(dot);
  }

  dotProducts.sort((a, b) => a - b);

  if (dotProducts.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(dotProducts.length * p / 100);
    return dotProducts[Math.min(idx, dotProducts.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, dotProducts[0]!),
    whiskerHigh: Math.min(whiskerHigh, dotProducts[dotProducts.length - 1]!),
  };
}

export interface EdgeTangentPercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeEdgeTangentPercentiles(body: SolidBody): EdgeTangentPercentiles {
  const centroid = computeCentroid(body);
  const tangents: number[] = [];

  for (const edge of body.edges) {
    const midX = (edge.start.x + edge.end.x) / 2;
    const midY = (edge.start.y + edge.end.y) / 2;
    const midZ = (edge.start.z + edge.end.z) / 2;

    // Tangent direction
    const dx = edge.end.x - edge.start.x;
    const dy = edge.end.y - edge.start.y;
    const dz = edge.end.z - edge.start.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-10) continue;

    // Direction from centroid to edge midpoint
    const dirX = midX - centroid.x;
    const dirY = midY - centroid.y;
    const dirZ = midZ - centroid.z;
    const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    if (dirLen < 1e-10) continue;

    // Dot product of tangent with radial direction
    const dot = (dx * dirX + dy * dirY + dz * dirZ) / (len * dirLen);
    tangents.push(dot);
  }

  tangents.sort((a, b) => a - b);

  if (tangents.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(tangents.length * p / 100);
    return tangents[Math.min(idx, tangents.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, tangents[0]!),
    whiskerHigh: Math.min(whiskerHigh, tangents[tangents.length - 1]!),
  };
}

export interface EdgeCurvaturePercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeEdgeCurvaturePercentiles(body: SolidBody): EdgeCurvaturePercentiles {
  const curvatures: number[] = [];

  for (const edge of body.edges) {
    const len = computeEdgeLength(edge);
    if (len > 1e-10) {
      curvatures.push(1 / len);
    }
  }

  curvatures.sort((a, b) => a - b);

  if (curvatures.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(curvatures.length * p / 100);
    return curvatures[Math.min(idx, curvatures.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, curvatures[0]!),
    whiskerHigh: Math.min(whiskerHigh, curvatures[curvatures.length - 1]!),
  };
}

export interface VertexValencePercentiles {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  iqr: number;
  whiskerLow: number;
  whiskerHigh: number;
}

export function computeVertexValencePercentiles(body: SolidBody): VertexValencePercentiles {
  const degrees = computeVertexDegrees(body);
  const valences: number[] = Array.from(degrees.values());
  valences.sort((a, b) => a - b);

  if (valences.length === 0) {
    return { p5: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, iqr: 0, whiskerLow: 0, whiskerHigh: 0 };
  }

  const getPercentile = (p: number) => {
    const idx = Math.floor(valences.length * p / 100);
    return valences[Math.min(idx, valences.length - 1)]!;
  };

  const p5 = getPercentile(5);
  const p10 = getPercentile(10);
  const p25 = getPercentile(25);
  const p50 = getPercentile(50);
  const p75 = getPercentile(75);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);

  const iqr = p75 - p25;
  const whiskerLow = p25 - 1.5 * iqr;
  const whiskerHigh = p75 + 1.5 * iqr;

  return {
    p5, p10, p25, p50, p75, p90, p95,
    iqr,
    whiskerLow: Math.max(whiskerLow, valences[0]!),
    whiskerHigh: Math.min(whiskerHigh, valences[valences.length - 1]!),
  };
}

export interface BoundaryLoops {
  /** Number of closed boundary loops (holes). */
  holeCount: number;
  /** Total number of boundary edges (edges used by only one face). */
  boundaryEdgeCount: number;
  /** The vertices of each boundary loop, in order. */
  loops: Vec3[][];
}

/**
 * Find the open boundary loops ("holes") of a mesh: edges used by exactly one
 * face, chained into loops. A watertight mesh has none. Useful for diagnosing
 * and repairing imported STLs before printing.
 */
export function findBoundaryLoops(body: SolidBody, tolerance = 1e-6): BoundaryLoops {
  const q = (n: number) => Math.round(n / tolerance) * tolerance;
  const key = (v: Vec3) => `${q(v.x)},${q(v.y)},${q(v.z)}`;

  // Count how many faces use each undirected edge.
  const undirected = new Map<string, number>();
  const undirectedKey = (ka: string, kb: string) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
  for (const f of body.faces) {
    const vs = f.vertices;
    for (let i = 0; i < vs.length; i++) {
      const ka = key(vs[i]!);
      const kb = key(vs[(i + 1) % vs.length]!);
      const uk = undirectedKey(ka, kb);
      undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
    }
  }

  // Collect directed boundary edges and index them by start key.
  interface DirEdge { a: Vec3; kb: string; used: boolean }
  const dirEdges: DirEdge[] = [];
  const startMap = new Map<string, number[]>();
  for (const f of body.faces) {
    const vs = f.vertices;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      const b = vs[(i + 1) % vs.length]!;
      const ka = key(a);
      const kb = key(b);
      if (undirected.get(undirectedKey(ka, kb)) === 1) {
        const idx = dirEdges.length;
        dirEdges.push({ a, kb, used: false });
        const list = startMap.get(ka);
        if (list) list.push(idx);
        else startMap.set(ka, [idx]);
      }
    }
  }

  const loops: Vec3[][] = [];
  for (let s = 0; s < dirEdges.length; s++) {
    if (dirEdges[s]!.used) continue;
    const loop: Vec3[] = [];
    let cur = s;
    let guard = 0;
    while (cur !== -1 && !dirEdges[cur]!.used && guard++ <= dirEdges.length) {
      const e = dirEdges[cur]!;
      e.used = true;
      loop.push(e.a);
      const cands = startMap.get(e.kb) ?? [];
      cur = cands.find((ci) => !dirEdges[ci]!.used) ?? -1;
    }
    if (loop.length > 0) loops.push(loop);
  }

  return { holeCount: loops.length, boundaryEdgeCount: dirEdges.length, loops };
}
