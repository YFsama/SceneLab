import { describe, it, expect } from 'vitest';
import { useStore } from './app';

describe('app store', () => {
  it('should have default theme', () => {
    const theme = useStore.getState().theme;
    expect(theme).toBe('dark');
  });

  it('should have default locale', () => {
    const locale = useStore.getState().locale;
    expect(locale).toBe('en');
  });

  it('should have default workspace', () => {
    const workspace = useStore.getState().workspace;
    expect(workspace).toBe('model');
  });

  it('should set theme', () => {
    useStore.getState().setTheme('light');
    expect(useStore.getState().theme).toBe('light');
    useStore.getState().setTheme('dark');
  });

  it('should set locale', () => {
    useStore.getState().setLocale('zh');
    expect(useStore.getState().locale).toBe('zh');
    useStore.getState().setLocale('en');
  });

  it('should set workspace', () => {
    useStore.getState().setWorkspace('sketch');
    expect(useStore.getState().workspace).toBe('sketch');
    useStore.getState().setWorkspace('model');
  });

  it('should set view direction', () => {
    useStore.getState().setViewDirection('top');
    expect(useStore.getState().viewDirection).toBe('top');
    useStore.getState().setViewDirection('iso');
  });

  it('should toggle browser tree', () => {
    const initial = useStore.getState().showBrowserTree;
    useStore.getState().toggleBrowserTree();
    expect(useStore.getState().showBrowserTree).toBe(!initial);
    useStore.getState().toggleBrowserTree();
  });

  it('should toggle properties', () => {
    const initial = useStore.getState().showProperties;
    useStore.getState().toggleProperties();
    expect(useStore.getState().showProperties).toBe(!initial);
    useStore.getState().toggleProperties();
  });

  it('should add and select objects', () => {
    useStore.getState().addObject('test-1');
    expect(useStore.getState().objectIds).toContain('test-1');

    useStore.getState().selectObject('test-1');
    expect(useStore.getState().selectedIds).toEqual(['test-1']);

    useStore.getState().deselectAll();
    expect(useStore.getState().selectedIds).toEqual([]);
  });

  it('should set sketch tool', () => {
    useStore.getState().setSketchTool('line');
    expect(useStore.getState().sketchTool).toBe('line');
    useStore.getState().setSketchTool('select');
  });

  it('should set sketch active', () => {
    useStore.getState().setSketchActive(true);
    expect(useStore.getState().sketchActive).toBe(true);
    useStore.getState().setSketchActive(false);
  });

  it('should set project name', () => {
    useStore.getState().setProjectName('Test Project');
    expect(useStore.getState().projectName).toBe('Test Project');
    useStore.getState().setProjectName('Untitled');
  });

  it('should set project dirty', () => {
    useStore.getState().setProjectDirty(true);
    expect(useStore.getState().projectDirty).toBe(true);
    useStore.getState().setProjectDirty(false);
  });
});
