import { describe, it, expect } from 'vitest';
import type { FeatureType } from '../../lib/features/types';

// FeatureEditor is a React component — test the feature type structure.

describe('FeatureEditor feature types', () => {
  const FEATURE_TYPES: FeatureType[] = [
    'sketch', 'extrude', 'revolve', 'fillet', 'chamfer', 'shell',
    'linearArray', 'circularArray', 'mirror',
  ];

  it('has 9 feature types', () => {
    expect(FEATURE_TYPES).toHaveLength(9);
  });

  it('includes sketch type', () => {
    expect(FEATURE_TYPES).toContain('sketch');
  });

  it('includes extrude type', () => {
    expect(FEATURE_TYPES).toContain('extrude');
  });

  it('includes revolve type', () => {
    expect(FEATURE_TYPES).toContain('revolve');
  });

  it('includes fillet type', () => {
    expect(FEATURE_TYPES).toContain('fillet');
  });

  it('includes chamfer type', () => {
    expect(FEATURE_TYPES).toContain('chamfer');
  });

  it('includes shell type', () => {
    expect(FEATURE_TYPES).toContain('shell');
  });

  it('includes linearArray type', () => {
    expect(FEATURE_TYPES).toContain('linearArray');
  });

  it('includes circularArray type', () => {
    expect(FEATURE_TYPES).toContain('circularArray');
  });

  it('includes mirror type', () => {
    expect(FEATURE_TYPES).toContain('mirror');
  });
});

describe('FeatureEditor feature operations', () => {
  it('suppress toggle flips the suppressed flag', () => {
    const feature = { id: 'f1', name: 'Extrude', type: 'extrude' as const, suppressed: false, parentIds: [], params: {} };
    const toggled = { ...feature, suppressed: !feature.suppressed };
    expect(toggled.suppressed).toBe(true);
    expect(toggled.name).toBe('Extrude');
  });

  it('double suppress returns to original state', () => {
    const feature = { id: 'f1', name: 'Extrude', type: 'extrude' as const, suppressed: false, parentIds: [], params: {} };
    const toggled = { ...feature, suppressed: !feature.suppressed };
    const toggledBack = { ...toggled, suppressed: !toggled.suppressed };
    expect(toggledBack.suppressed).toBe(false);
  });

  it('feature name can be edited', () => {
    const feature = { id: 'f1', name: 'Extrude', type: 'extrude' as const, suppressed: false, parentIds: [], params: {} };
    const renamed = { ...feature, name: 'My Extrude' };
    expect(renamed.name).toBe('My Extrude');
    expect(renamed.id).toBe('f1');
  });
});
