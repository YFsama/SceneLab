import { describe, it, expect } from 'vitest';
import { shouldShowWelcome } from '../../lib/onboarding';

describe('shouldShowWelcome (welcome card visibility rule)', () => {
  const base = {
    workspace: 'model',
    bodyCount: 0,
    featureCount: 0,
    sketchActive: false,
    welcomeDismissed: false,
    welcomeSessionHidden: false,
  };

  it('shows on an empty model workspace', () => {
    expect(shouldShowWelcome(base)).toBe(true);
  });

  it('hides once the scene has any body or feature', () => {
    expect(shouldShowWelcome({ ...base, bodyCount: 1 })).toBe(false);
    expect(shouldShowWelcome({ ...base, featureCount: 2 })).toBe(false);
  });

  it('hides outside the model workspace and while sketching', () => {
    expect(shouldShowWelcome({ ...base, workspace: 'drawing' })).toBe(false);
    expect(shouldShowWelcome({ ...base, sketchActive: true })).toBe(false);
  });

  it('hides when dismissed permanently or for the session', () => {
    expect(shouldShowWelcome({ ...base, welcomeDismissed: true })).toBe(false);
    expect(shouldShowWelcome({ ...base, welcomeSessionHidden: true })).toBe(false);
  });
});
