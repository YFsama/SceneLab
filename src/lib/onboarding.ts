// Onboarding state rules shared by the welcome card, its tests and the store
// step call-sites ('insert' | 'move' | 'ai' | 'save').

export const ONBOARDING_STEPS = ['insert', 'move', 'ai', 'save'] as const;

/** Pure visibility rule for the welcome card (exported for tests). */
export function shouldShowWelcome(s: {
  workspace: string;
  bodyCount: number;
  featureCount: number;
  sketchActive: boolean;
  welcomeDismissed: boolean;
  welcomeSessionHidden: boolean;
}): boolean {
  return (
    s.workspace === 'model' && s.bodyCount === 0 && s.featureCount === 0 && !s.sketchActive &&
    !s.welcomeDismissed && !s.welcomeSessionHidden
  );
}
