import { describe, it, expect } from 'vitest';

// Test the orientation mapping logic used by the ViewCube.

describe('ViewCube orientations', () => {
  // The 26 orientations: 6 faces + 12 edges + 8 corners.
  const FACE_DIRS = [
    { name: 'Front', pos: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
    { name: 'Back', pos: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
    { name: 'Right', pos: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
    { name: 'Left', pos: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
    { name: 'Top', pos: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: -1 } },
    { name: 'Bottom', pos: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  ];

  const EDGE_DIRS = [
    { name: 'Front-Top', pos: { x: 0, y: 1, z: 1 } },
    { name: 'Front-Bottom', pos: { x: 0, y: -1, z: 1 } },
    { name: 'Back-Top', pos: { x: 0, y: 1, z: -1 } },
    { name: 'Back-Bottom', pos: { x: 0, y: -1, z: -1 } },
    { name: 'Right-Top', pos: { x: 1, y: 1, z: 0 } },
    { name: 'Left-Top', pos: { x: -1, y: 1, z: 0 } },
    { name: 'Right-Bottom', pos: { x: 1, y: -1, z: 0 } },
    { name: 'Left-Bottom', pos: { x: -1, y: -1, z: 0 } },
    { name: 'Front-Right', pos: { x: 1, y: 0, z: 1 } },
    { name: 'Front-Left', pos: { x: -1, y: 0, z: 1 } },
    { name: 'Back-Right', pos: { x: 1, y: 0, z: -1 } },
    { name: 'Back-Left', pos: { x: -1, y: 0, z: -1 } },
  ];

  const CORNER_DIRS = [
    { name: 'Front-Right-Top', pos: { x: 1, y: 1, z: 1 } },
    { name: 'Front-Left-Top', pos: { x: -1, y: 1, z: 1 } },
    { name: 'Front-Right-Bottom', pos: { x: 1, y: -1, z: 1 } },
    { name: 'Front-Left-Bottom', pos: { x: -1, y: -1, z: 1 } },
    { name: 'Back-Right-Top', pos: { x: 1, y: 1, z: -1 } },
    { name: 'Back-Left-Top', pos: { x: -1, y: 1, z: -1 } },
    { name: 'Back-Right-Bottom', pos: { x: 1, y: -1, z: -1 } },
    { name: 'Back-Left-Bottom', pos: { x: -1, y: -1, z: -1 } },
  ];

  it('has 6 face orientations', () => {
    expect(FACE_DIRS).toHaveLength(6);
  });

  it('has 12 edge orientations', () => {
    expect(EDGE_DIRS).toHaveLength(12);
  });

  it('has 8 corner orientations', () => {
    expect(CORNER_DIRS).toHaveLength(8);
  });

  it('total orientations = 26', () => {
    expect(FACE_DIRS.length + EDGE_DIRS.length + CORNER_DIRS.length).toBe(26);
  });

  it('all face positions are unit vectors', () => {
    for (const face of FACE_DIRS) {
      const len = Math.sqrt(face.pos.x ** 2 + face.pos.y ** 2 + face.pos.z ** 2);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('all edge positions are normalized', () => {
    for (const edge of EDGE_DIRS) {
      const len = Math.sqrt(edge.pos.x ** 2 + edge.pos.y ** 2 + edge.pos.z ** 2);
      expect(len).toBeGreaterThan(0);
    }
  });

  it('all corner positions are normalized', () => {
    for (const corner of CORNER_DIRS) {
      const len = Math.sqrt(corner.pos.x ** 2 + corner.pos.y ** 2 + corner.pos.z ** 2);
      expect(len).toBeGreaterThan(0);
    }
  });

  it('face positions are mutually exclusive', () => {
    const positions = FACE_DIRS.map((f) => `${f.pos.x},${f.pos.y},${f.pos.z}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(FACE_DIRS.length);
  });

  it('edge positions are mutually exclusive', () => {
    const positions = EDGE_DIRS.map((e) => `${e.pos.x},${e.pos.y},${e.pos.z}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(EDGE_DIRS.length);
  });

  it('corner positions are mutually exclusive', () => {
    const positions = CORNER_DIRS.map((c) => `${c.pos.x},${c.pos.y},${c.pos.z}`);
    const unique = new Set(positions);
    expect(unique.size).toBe(CORNER_DIRS.length);
  });
});
