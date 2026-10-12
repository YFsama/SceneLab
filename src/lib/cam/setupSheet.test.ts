import { describe, it, expect } from 'vitest';
import { generateSetupSheetHtml, type SetupSheetOp } from './setupSheet';

// Pure string generator: every assertion is on the emitted document — no DOM,
// no locale, deterministic via the injected generatedAt stamp.

const ops: SetupSheetOp[] = [
  {
    name: 'Pocket — Bracket', type: 'pocket', toolName: '⌀6 2F end mill',
    toolNumber: 1, diameter: 6, timeMin: 4.25, feedRate: 1000, spindleSpeed: 10000,
    enabled: true,
  },
  {
    name: 'Drill — Bracket', type: 'drill', toolName: '⌀3 drill',
    toolNumber: 2, diameter: 3, timeMin: 0, feedRate: 300, spindleSpeed: 8000,
    enabled: false,
  },
];

const base = {
  projectName: 'Bracket rev A',
  profile: 'grbl',
  stock: 'bbox +2 mm',
  safeZ: 15.5,
  totalTimeMin: 4.25,
  generatedAt: '2026-10-12T08:00:00.000Z',
};

describe('generateSetupSheetHtml', () => {
  it('renders the header block: project, profile, stock, safe Z, total time', () => {
    const html = generateSetupSheetHtml({ ...base, ops });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Bracket rev A');
    expect(html).toContain('grbl');
    expect(html).toContain('bbox +2 mm');
    expect(html).toContain('15.5 mm');
    expect(html).toContain('4.25 min');
    expect(html).toContain('2026-10-12T08:00:00.000Z');
  });

  it('renders one row per operation with tool number, diameter and params', () => {
    const html = generateSetupSheetHtml({ ...base, ops });
    expect(html).toContain('Pocket — Bracket');
    expect(html).toContain('Drill — Bracket');
    // Tool column carries the post-processor T number plus the tool name.
    expect(html).toContain('T1 ⌀6 2F end mill');
    expect(html).toContain('T2 ⌀3 drill');
    // Numeric cells: diameter, feed, spindle.
    expect(html).toContain('>6</td>');
    expect(html).toContain('>1000</td>');
    expect(html).toContain('>8000</td>');
    // A disabled op with no cached toolpath shows the em-dash time cell and
    // the disabled row class (strike-through in the stylesheet).
    expect(html).toContain('—</td>');
    expect(html).toContain('class="off"');
  });

  it('is self-contained: inline styles, print rules, no scripts or external refs', () => {
    const html = generateSetupSheetHtml({ ...base, ops });
    expect(html).toContain('<style>');
    expect(html).toContain('@media print');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('emits a valid skeleton for an empty operation list', () => {
    const html = generateSetupSheetHtml({ ...base, ops: [] });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    // The OPS table (the one after its thead) renders no rows.
    const opsTable = html.split('</thead>')[1]!;
    expect(opsTable).toContain('<tbody>');
    expect(opsTable.split('<tbody>')[1]!.split('</tbody>')[0]!.trim()).toBe('');
  });

  it('escapes user-controlled strings (a body named <script> stays text)', () => {
    const html = generateSetupSheetHtml({
      ...base,
      projectName: 'Proj <script>alert(1)</script>',
      ops: [{ ...ops[0]!, name: 'Op <script>alert(2)</script>', toolName: '<img src=x onerror=alert(3)>' }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Proj &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Op &lt;script&gt;alert(2)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(3)&gt;');
  });

  it('defaults generatedAt to a fresh timestamp when omitted', () => {
    const before = Date.now();
    const html = generateSetupSheetHtml({ ...base, ops, generatedAt: undefined });
    const stamp = html.match(/Generated ([^ ]+) /)?.[1];
    expect(stamp).toBeDefined();
    expect(Date.parse(stamp!)).toBeGreaterThanOrEqual(before);
  });
});
