import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './app';
import { FeatureTree } from '../lib/features/tree';
import { computeBoundingBox } from '../lib/geometry';

describe('store — parts library', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [],
      directBodies: [],
      objectIds: [],
      selectedIds: [],
      undoStack: [],
      redoStack: [],
      recentPartIds: [],
      onboardingSteps: [],
      showPartsLibrary: false,
    });
  });

  it('insertLibraryPart inserts, selects and credits the insert step', () => {
    const id = useStore.getState().insertLibraryPart('plate');
    expect(id).toBeTruthy();
    const st = useStore.getState();
    expect(st.directBodies).toHaveLength(1);
    expect(st.selectedIds).toContain(id);
    expect(st.onboardingSteps).toContain('insert');
  });

  it('returns null for an unknown part id', () => {
    expect(useStore.getState().insertLibraryPart('nope')).toBeNull();
    expect(useStore.getState().directBodies).toHaveLength(0);
  });

  it('staggers successive inserts so parts never stack at the origin', () => {
    const a = useStore.getState().insertLibraryPart('plate')!;
    const b = useStore.getState().insertLibraryPart('gear')!;
    const boxA = computeBoundingBox(useStore.getState().directBodies.find((x) => x.id === a)!);
    const boxB = computeBoundingBox(useStore.getState().directBodies.find((x) => x.id === b)!);
    expect(boxB.min.x).toBeGreaterThan(boxA.min.x - 1e-9);
  });

  it('records recently used parts (most recent first, deduped, capped)', () => {
    useStore.getState().insertLibraryPart('plate');
    useStore.getState().insertLibraryPart('gear');
    useStore.getState().insertLibraryPart('plate');
    const recent = useStore.getState().recentPartIds;
    expect(recent[0]).toBe('plate');
    expect(recent.filter((x) => x === 'plate')).toHaveLength(1);
    expect(recent).toContain('gear');
    expect(recent.length).toBeLessThanOrEqual(6);
  });

  it('togglePartsLibrary flips the panel and persists', () => {
    useStore.getState().togglePartsLibrary();
    expect(useStore.getState().showPartsLibrary).toBe(true);
    expect(localStorage.getItem('scenelab.showPartsLibrary')).toBe('true');
  });
});

describe('store — onboarding', () => {
  beforeEach(() => {
    useStore.setState({ onboardingSteps: [], welcomeDismissed: false, welcomeSessionHidden: false });
    localStorage.removeItem('scenelab.onboarding');
    localStorage.removeItem('scenelab.welcomeDismissed');
  });

  it('markOnboardingStep dedupes and persists', () => {
    useStore.getState().markOnboardingStep('move');
    useStore.getState().markOnboardingStep('move');
    const st = useStore.getState();
    expect(st.onboardingSteps).toEqual(['move']);
    expect(JSON.parse(localStorage.getItem('scenelab.onboarding')!)).toEqual(['move']);
  });

  it('dismissWelcome persists; showWelcome brings the card back', () => {
    useStore.getState().dismissWelcome();
    expect(useStore.getState().welcomeDismissed).toBe(true);
    expect(localStorage.getItem('scenelab.welcomeDismissed')).toBe('true');
    useStore.getState().hideWelcomeForSession();
    useStore.getState().showWelcome();
    const st = useStore.getState();
    expect(st.welcomeDismissed).toBe(false);
    expect(st.welcomeSessionHidden).toBe(false);
  });

  it('nudge move completes the move step exactly once', () => {
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [], directBodies: [], objectIds: [], selectedIds: [], undoStack: [], redoStack: [],
    });
    useStore.getState().addPrimitive('box');
    useStore.setState({ selectedIds: [useStore.getState().directBodies[0]!.id] });
    expect(useStore.getState().nudgeSelected(1, 0, 0)).toBe(1);
    expect(useStore.getState().onboardingSteps).toContain('move');
  });
});

describe('store — viewport drag-move (existing API, onboarding credit)', () => {
  beforeEach(() => {
    useStore.setState({
      featureTree: new FeatureTree(),
      bodies: [], directBodies: [], objectIds: [], selectedIds: [], undoStack: [], redoStack: [],
      onboardingSteps: [],
    });
  });

  it('a real drag moves the body once in history and credits move', () => {
    const id = useStore.getState().addPrimitive('box');
    useStore.getState().selectObject(id);
    const before = computeBoundingBox(useStore.getState().directBodies[0]!);
    useStore.getState().beginSelectionDrag();
    const undoLen = useStore.getState().undoStack.length;
    expect(useStore.getState().dragSelectionBy(5, 0, 0)).toBe(1);
    expect(useStore.getState().dragSelectionBy(5, 0, 0)).toBe(1);
    expect(useStore.getState().undoStack.length).toBe(undoLen); // still one entry
    useStore.getState().endSelectionDrag();
    const after = computeBoundingBox(useStore.getState().directBodies[0]!);
    expect(after.min.x - before.min.x).toBeCloseTo(10, 6);
    expect(useStore.getState().onboardingSteps).toContain('move');
    // A single undo restores the pre-drag position.
    useStore.getState().undo();
    const restored = computeBoundingBox(useStore.getState().directBodies[0]!);
    expect(restored.min.x).toBeCloseTo(before.min.x, 6);
  });

  it('a press without motion drops the no-op undo entry', () => {
    useStore.getState().addPrimitive('box');
    const undoLen = useStore.getState().undoStack.length; // addPrimitive pushed one
    useStore.getState().beginSelectionDrag();
    useStore.getState().endSelectionDrag();
    expect(useStore.getState().undoStack.length).toBe(undoLen);
    expect(useStore.getState().onboardingSteps).not.toContain('move');
  });
  it('cancelSelectionDrag restores the pre-drag position', () => {
    const id = useStore.getState().addPrimitive('box');
    useStore.getState().selectObject(id);
    const before = computeBoundingBox(useStore.getState().directBodies[0]!);
    useStore.getState().beginSelectionDrag();
    useStore.getState().dragSelectionBy(7, 0, 0);
    useStore.getState().cancelSelectionDrag();
    const restored = computeBoundingBox(useStore.getState().directBodies[0]!);
    expect(restored.min.x).toBeCloseTo(before.min.x, 6);
  });
});
