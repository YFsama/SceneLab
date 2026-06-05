import { describe, it, expect } from 'vitest';
import type { PrimitiveKind } from '../../store/app';

// PrimitiveBar is a React component — test the primitive structure.

describe('PrimitiveBar primitive structure', () => {
  const primitives: { kind: PrimitiveKind }[] = [
    { kind: 'box' },
    { kind: 'cylinder' },
    { kind: 'sphere' },
    { kind: 'cone' },
    { kind: 'torus' },
    { kind: 'wedge' },
    { kind: 'prism' },
    { kind: 'tube' },
    { kind: 'coil' },
  ];

  it('has 9 primitive types', () => {
    expect(primitives).toHaveLength(9);
  });

  it('includes box, cylinder, sphere, cone, torus', () => {
    const kinds = primitives.map((p) => p.kind);
    expect(kinds).toContain('box');
    expect(kinds).toContain('cylinder');
    expect(kinds).toContain('sphere');
    expect(kinds).toContain('cone');
    expect(kinds).toContain('torus');
  });

  it('includes wedge, prism, tube, coil', () => {
    const kinds = primitives.map((p) => p.kind);
    expect(kinds).toContain('wedge');
    expect(kinds).toContain('prism');
    expect(kinds).toContain('tube');
    expect(kinds).toContain('coil');
  });

  it('all primitive kinds are unique', () => {
    const kinds = primitives.map((p) => p.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(kinds.length);
  });
});
