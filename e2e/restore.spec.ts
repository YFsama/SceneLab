import { test, expect, type Page } from '@playwright/test';

/**
 * Crash-recovery restore banner: a previous session's autosave is seeded into
 * localStorage BEFORE load (page.addInitScript), exactly where the store's
 * autosave() put it — a serializeProject() JSON (src/lib/io/studio3d.ts) with
 * a tiny direct-body box crafted by hand: version/name/features/bodies plus
 * the full directBodies SolidBody mesh (vertices + faces + edges), and a
 * metadata.modified timestamp five minutes in the past so the banner can show
 * the age phrase. The app must OFFER it (never auto-restore), and Discard /
 * Restore must do what they say on the footer's object counter.
 */

/** A 10×10×10 mm box SolidBody sitting on the floor, mesh built by hand. */
function boxBody() {
  const v = (x: number, y: number, z: number) => ({ x, y, z });
  const vertices = [
    v(-5, 0, -5), v(5, 0, -5), v(5, 0, 5), v(-5, 0, 5), // bottom ring
    v(-5, 10, -5), v(5, 10, -5), v(5, 10, 5), v(-5, 10, 5), // top ring
  ];
  const faces = [
    { id: 'f-bottom', vertices: [vertices[0]!, vertices[1]!, vertices[2]!, vertices[3]!], normal: v(0, -1, 0) },
    { id: 'f-top', vertices: [vertices[4]!, vertices[7]!, vertices[6]!, vertices[5]!], normal: v(0, 1, 0) },
    { id: 'f-front', vertices: [vertices[3]!, vertices[2]!, vertices[6]!, vertices[7]!], normal: v(0, 0, 1) },
    { id: 'f-back', vertices: [vertices[1]!, vertices[0]!, vertices[4]!, vertices[5]!], normal: v(0, 0, -1) },
    { id: 'f-right', vertices: [vertices[2]!, vertices[1]!, vertices[5]!, vertices[6]!], normal: v(1, 0, 0) },
    { id: 'f-left', vertices: [vertices[0]!, vertices[3]!, vertices[7]!, vertices[4]!], normal: v(-1, 0, 0) },
  ];
  const edges = [
    ['e1', 0, 1], ['e2', 1, 2], ['e3', 2, 3], ['e4', 3, 0], // bottom
    ['e5', 4, 5], ['e6', 5, 6], ['e7', 6, 7], ['e8', 7, 4], // top
    ['e9', 0, 4], ['e10', 1, 5], ['e11', 2, 6], ['e12', 3, 7], // verticals
  ].map(([id, a, b]) => ({ id: id as string, start: vertices[a as number]!, end: vertices[b as number]! }));
  return { id: 'e2e-box', name: 'Box', vertices, faces, edges };
}

/** The exact JSON shape autosave() → serializeProject() writes. */
function autosaveJson(name: string): string {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    name,
    features: [],
    bodies: [],
    directBodies: [boxBody()],
    referenceGeometry: { planes: [], axes: [], points: [], coordSystems: [], annotations: [] },
    metadata: {
      created: new Date(now - 60_000).toISOString(),
      // Five minutes old → the banner reports "… from 5 min ago".
      modified: new Date(now - 5 * 60_000).toISOString(),
      appVersion: '0.16.0',
    },
  });
}

test.beforeEach(({ page }) => {
  // Seed the crashed session's autosave before any app script runs, and keep
  // the welcome card from shadowing the banner.
  page.addInitScript((json) => {
    localStorage.setItem('scenelab.autosave', json);
    localStorage.setItem('scenelab.welcomeDismissed', 'true');
  }, autosaveJson('E2E Crash Part'));
});

/** The status-bar object counter (workhorse assertion, as in smoke). */
async function countObjects(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Objects:\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

test('boot offers the stored autosave; Discard clears banner and localStorage key', async ({ page }) => {
  await page.goto('/');

  // The banner offers the crashed project by name, with its age — the probe
  // never consumed the stored copy.
  const banner = page.getByTestId('restore-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('E2E Crash Part');
  await expect(banner).toContainText('min ago');
  expect(await page.evaluate(() => localStorage.getItem('scenelab.autosave'))).not.toBeNull();

  // Nothing was auto-restored while the offer was up.
  await expect.poll(() => countObjects(page)).toBe(0);

  // Discard: the banner closes and the stored autosave is gone for good.
  await banner.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(banner).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('scenelab.autosave')))
    .toBeNull();
  // …and the scene stays empty afterwards.
  await expect.poll(() => countObjects(page)).toBe(0);
});

test('Restore reloads the autosaved project — the box is back in the scene', async ({ page }) => {
  await page.goto('/');

  const banner = page.getByTestId('restore-banner');
  await expect(banner).toBeVisible();

  await banner.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(banner).toBeHidden();

  // The seeded direct-body box reappears: one object in the status bar…
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);
  // …the restored project name is in the footer (dirty: it was never saved)…
  const footer = page.locator('footer[role=status]');
  await expect(footer).toContainText('E2E Crash Part');
  // …and the box shows up in the browser tree by name.
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});
