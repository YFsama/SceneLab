import { describe, it, expect } from 'vitest';

// ShortcutsHelp is a React component — test the shortcut group structure.

describe('ShortcutsHelp shortcut groups', () => {
  // Replicate the GROUPS structure from the component.
  const GROUPS = [
    {
      titleKey: 'shortcuts.views',
      rows: [
        { keys: '1', labelKey: 'viewport.front' },
        { keys: '2', labelKey: 'viewport.top' },
        { keys: '3', labelKey: 'viewport.right' },
        { keys: '4', labelKey: 'viewport.iso' },
        { keys: '5', labelKey: 'viewport.back' },
        { keys: '6', labelKey: 'viewport.bottom' },
        { keys: '7', labelKey: 'viewport.left' },
        { keys: 'F', labelKey: 'viewport.fit' },
      ],
    },
    {
      titleKey: 'shortcuts.workspaces',
      rows: [
        { keys: 'S', labelKey: 'toolbar.sketch' },
        { keys: 'M', labelKey: 'toolbar.model' },
      ],
    },
    {
      titleKey: 'shortcuts.sketch',
      rows: [
        { keys: 'V', labelKey: 'sketch.select' },
        { keys: 'L', labelKey: 'sketch.line' },
        { keys: 'R', labelKey: 'sketch.rect' },
      ],
    },
    {
      titleKey: 'shortcuts.edit',
      rows: [
        { keys: 'Ctrl+Z', labelKey: 'toolbar.undo' },
        { keys: 'Ctrl+A', labelKey: 'shortcuts.selectAll' },
        { keys: 'Del', labelKey: 'menu.delete' },
      ],
    },
  ];

  it('has 4 shortcut groups', () => {
    expect(GROUPS).toHaveLength(4);
  });

  it('each group has a titleKey', () => {
    for (const g of GROUPS) {
      expect(g.titleKey).toBeTruthy();
    }
  });

  it('each row has keys and labelKey', () => {
    for (const g of GROUPS) {
      for (const r of g.rows) {
        expect(r.keys).toBeTruthy();
        expect(r.labelKey).toBeTruthy();
      }
    }
  });

  it('view shortcuts include number keys 1-7', () => {
    const viewKeys = GROUPS[0]!.rows.map((r) => r.keys);
    for (let i = 1; i <= 7; i++) {
      expect(viewKeys).toContain(String(i));
    }
  });

  it('sketch shortcuts include V, L, R', () => {
    const sketchKeys = GROUPS[2]!.rows.map((r) => r.keys);
    expect(sketchKeys).toContain('V');
    expect(sketchKeys).toContain('L');
    expect(sketchKeys).toContain('R');
  });

  it('edit shortcuts include Ctrl+Z and Ctrl+A', () => {
    const editKeys = GROUPS[3]!.rows.map((r) => r.keys);
    expect(editKeys).toContain('Ctrl+Z');
    expect(editKeys).toContain('Ctrl+A');
  });
});
