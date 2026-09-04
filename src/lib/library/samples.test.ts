import { describe, it, expect } from 'vitest';
import { SAMPLE_PROJECTS, findSampleProject } from './samples';
import { computeVolume } from '../geometry';
import { translations } from '../i18n';

describe('starter sample projects', () => {
  it('every sample builds at least one positive-volume body', () => {
    for (const s of SAMPLE_PROJECTS) {
      const bodies = s.build();
      expect(bodies.length, s.id).toBeGreaterThan(0);
      for (const b of bodies) {
        expect(computeVolume(b), `${s.id}: ${b.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('has a localized name in both locales', () => {
    for (const s of SAMPLE_PROJECTS) {
      expect(translations.en![`sample.${s.id}`], `en missing sample.${s.id}`).toBeTruthy();
      expect(translations.zh![`sample.${s.id}`], `zh missing sample.${s.id}`).toBeTruthy();
    }
  });

  it('bodies inside a sample have readable names (never default Box spam)', () => {
    for (const s of SAMPLE_PROJECTS) {
      const names = s.build().map((b) => b.name);
      expect(names.every((n) => n && n.trim().length > 0), s.id).toBe(true);
      // Multi-body samples need at least two distinct names so the browser
      // tree reads meaningfully; single-body samples trivially pass.
      expect(new Set(names).size, s.id).toBeGreaterThanOrEqual(Math.min(2, names.length));
    }
  });
});

describe('findSampleProject', () => {
  it('finds by id', () => {
    expect(findSampleProject('phoneStand')).toBeDefined();
  });
  it('returns undefined for unknown ids', () => {
    expect(findSampleProject('death-star')).toBeUndefined();
  });
});
