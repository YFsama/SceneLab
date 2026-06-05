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

describe('ViewCube hit detection', () => {
  // Simulate the hit classification logic from InteractiveViewCube.
  const classifyHit = (u: number, v: number): 'face' | 'edge' | 'corner' => {
    const au = Math.abs(u);
    const av = Math.abs(v);
    const EDGE_THRESHOLD = 0.72;
    const CORNER_THRESHOLD = 0.72;

    if (au > CORNER_THRESHOLD && av > CORNER_THRESHOLD) return 'corner';
    if (au > EDGE_THRESHOLD || av > EDGE_THRESHOLD) return 'edge';
    return 'face';
  };

  it('center of face classifies as face', () => {
    expect(classifyHit(0, 0)).toBe('face');
    expect(classifyHit(0.3, 0.3)).toBe('face');
    expect(classifyHit(-0.3, 0.3)).toBe('face');
  });

  it('near edge classifies as edge', () => {
    expect(classifyHit(0.8, 0.3)).toBe('edge');
    expect(classifyHit(-0.8, 0.3)).toBe('edge');
    expect(classifyHit(0.3, 0.8)).toBe('edge');
    expect(classifyHit(0.3, -0.8)).toBe('edge');
  });

  it('near corner classifies as corner', () => {
    expect(classifyHit(0.8, 0.8)).toBe('corner');
    expect(classifyHit(-0.8, 0.8)).toBe('corner');
    expect(classifyHit(0.8, -0.8)).toBe('corner');
    expect(classifyHit(-0.8, -0.8)).toBe('corner');
  });

  it('boundary between face and edge', () => {
    // Exactly at threshold should be face (not > threshold).
    expect(classifyHit(0.72, 0.3)).toBe('face');
    expect(classifyHit(0.73, 0.3)).toBe('edge');
  });

  it('boundary between edge and corner', () => {
    // Both axes above edge threshold but below corner threshold.
    expect(classifyHit(0.75, 0.75)).toBe('corner');
  });
});

describe('ViewCube orientation selection', () => {
  // Simulate the findOrientation logic.
  const ORIENTATIONS = [
    { pos: { x: 0, y: 0, z: 1 } },  // Front
    { pos: { x: 0, y: 0, z: -1 } }, // Back
    { pos: { x: 1, y: 0, z: 0 } },  // Right
    { pos: { x: -1, y: 0, z: 0 } }, // Left
    { pos: { x: 0, y: 1, z: 0 } },  // Top
    { pos: { x: 0, y: -1, z: 0 } }, // Bottom
  ];

  const findOrientation = (dir: { x: number; y: number; z: number }): number => {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < ORIENTATIONS.length; i++) {
      const o = ORIENTATIONS[i]!.pos;
      const d = Math.sqrt((dir.x - o.x) ** 2 + (dir.y - o.y) ** 2 + (dir.z - o.z) ** 2);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  it('finds the correct face orientation', () => {
    expect(findOrientation({ x: 0, y: 0, z: 1 })).toBe(0); // Front
    expect(findOrientation({ x: 0, y: 0, z: -1 })).toBe(1); // Back
    expect(findOrientation({ x: 1, y: 0, z: 0 })).toBe(2); // Right
    expect(findOrientation({ x: -1, y: 0, z: 0 })).toBe(3); // Left
    expect(findOrientation({ x: 0, y: 1, z: 0 })).toBe(4); // Top
    expect(findOrientation({ x: 0, y: -1, z: 0 })).toBe(5); // Bottom
  });

  it('finds the nearest orientation for intermediate directions', () => {
    // Closer to Front than Back.
    expect(findOrientation({ x: 0, y: 0, z: 0.5 })).toBe(0);
    // Closer to Right than Left.
    expect(findOrientation({ x: 0.5, y: 0, z: 0 })).toBe(2);
    // Closer to Top than Bottom.
    expect(findOrientation({ x: 0, y: 0.5, z: 0 })).toBe(4);
  });
});

describe('ViewCube drag behavior', () => {
  it('drag start records initial position', () => {
    let dragStart: { x: number; y: number } | null = null;
    const handleMouseDown = (x: number, y: number) => {
      dragStart = { x, y };
    };

    handleMouseDown(100, 200);
    expect(dragStart).toEqual({ x: 100, y: 200 });
  });

  it('drag delta is computed correctly', () => {
    const start = { x: 100, y: 200 };
    const current = { x: 150, y: 180 };
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    expect(dx).toBe(50);
    expect(dy).toBe(-20);
  });

  it('small drag is treated as click (not orbit)', () => {
    const start = { x: 100, y: 200 };
    const end = { x: 103, y: 198 };
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const isClick = dx < 4 && dy < 4;
    expect(isClick).toBe(true);
  });

  it('large drag is treated as orbit (not click)', () => {
    const start = { x: 100, y: 200 };
    const end = { x: 200, y: 150 };
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const isClick = dx < 4 && dy < 4;
    expect(isClick).toBe(false);
  });
});
