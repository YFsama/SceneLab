import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * STEP export round-trip oracle — proves the files exportSTEP writes are
 * readable by the REAL OpenCASCADE kernel, in the real browser, from a body
 * made through the real UI.
 *
 * Route (the cleanest real-UI path found):
 *  1. Insert a 20 mm Box via the viewport context menu (smoke-suite pattern).
 *  2. Drill a ⌀4 through-all Hole via right-click → Feature → Hole with the
 *     two-step numeric prompt and top-view placement (hole-suite pattern) —
 *     a "holed plate" whose exported file must weigh 8000 − π·2²·20 mm³.
 *  3. Export through the body context menu's Export → STEP item — the same
 *     downloadFile path the ViewportCanvas export button uses — and capture
 *     the browser download.
 *  4. Kernel leg: page.evaluate dynamically imports the app's own
 *     /src/lib/io/stepOCCT.ts module (the same lazy occt-import-js chunk +
 *     wasm the curved-import smoke test loads through the UI) and runs
 *     importSTEPWithOCCT on the downloaded bytes. Asserts meshes came back
 *     with faces > 0 and a volume within 2.5% of the drilled ideal.
 *  5. UI leg: feed the downloaded file back through the visible mesh-import
 *     input (the curved smoke test's entry point) — our own faceted importer
 *     must still read the new writer format, so the object count goes 1 → 2.
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

/** Wait for the WebGL canvas to be mounted and usefully sized (as smoke does). */
async function awaitCanvas(page: import('@playwright/test').Page) {
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect
    .poll(async () => {
      const box = await canvas.boundingBox();
      return box !== null && box.width > 100 && box.height > 100;
    }, { timeout: 10_000 })
    .toBe(true);
  return canvas;
}

/** Read the status-bar "Objects: N" counter (as the smoke suite does). */
function countObjects(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Objects:\s*(\d+)/.exec(document.body.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

test('export a holed box as STEP and round-trip it through the real OCCT kernel', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await awaitCanvas(page);

  // -- 1. Insert a Box through the context menu (20mm cube at the origin). --
  await page.locator('#viewport-canvas').click({ button: 'right' });
  let menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);

  // -- 2. Drill a ⌀4 through-all hole (hole-suite's direct-body flow). -----
  // Frame the box so the viewport centre is its centre, then right-click it
  // → Feature → Hole; answer ⌀4 and depth 0 (through-all), and place the
  // hole with a TOP view so the centre click lands on the top face centre.
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const center = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };

  await page.mouse.click(center.x, center.y, { button: 'right' });
  menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const featureItem = menu.getByRole('menuitem', { name: /^Feature\b/ });
  await featureItem.hover();
  await featureItem.click();
  await page.getByRole('menuitem', { name: 'Hole', exact: true }).click();
  const input = page.locator('#numeric-prompt-input');
  await expect(input).toBeVisible();
  await input.fill('4');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.fill('0');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Click the body where the hole should start')).toBeVisible();
  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  await page.mouse.click(center.x, center.y);
  // The drilled body is still exactly one object.
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);

  // -- 3. Export STEP through the body context menu; capture the download. -
  // Oblique view first: in the top view a centre right-click would shoot
  // down the new through-hole shaft and miss the body.
  await page.keyboard.press('4');
  await page.waitForTimeout(400);
  await page.mouse.click(center.x, center.y, { button: 'right' });
  menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const exportItem = menu.getByRole('menuitem', { name: 'Export' });
  await exportItem.hover();
  await exportItem.click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'STEP', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.stp$/);
  // download.path() is an extensionless temp file; the app's importer
  // classifies by extension, so materialise the download under its real
  // .stp name first.
  const path = join(tmpdir(), `scenelab-roundtrip-${Date.now()}.stp`);
  await download.saveAs(path);

  // -- 4. Kernel leg: the real occt-import-js wasm, in the real browser. ---
  const stepText = readFileSync(path, 'utf8');
  const kernel = await page.evaluate(async (text) => {
    const occtMod = await import('/src/lib/io/stepOCCT.ts');
    const brepMod = await import('/src/lib/geometry/brep.ts');
    const bytes = new TextEncoder().encode(text);
    const bodies = await occtMod.importSTEPWithOCCT(bytes, 'roundtrip-probe');
    let faces = 0;
    let volume = 0;
    for (const b of bodies) {
      faces += b.faces.length;
      volume += brepMod.computeVolume(b);
    }
    return { count: bodies.length, faces, volume };
  }, stepText);

  expect(kernel.count).toBeGreaterThanOrEqual(1);
  // The holed box has far more than the 6 original facets (cylinder wall +
  // pierced caps).
  expect(kernel.faces).toBeGreaterThan(10);
  // 20³ − π·2²·20 ≈ 7748.7 mm³, within 2.5% (chorded cylinder walls remove
  // slightly less than the ideal cylinder; an undrilled 8000 mm³ box would
  // fail this window).
  const ideal = 20 ** 3 - Math.PI * 2 * 2 * 20;
  expect(kernel.volume).toBeGreaterThan(ideal * 0.975);
  expect(kernel.volume).toBeLessThan(ideal * 1.025);

  // -- 5. UI leg: re-import through the visible file input. ---------------
  // Our faceted parser must still read the new writer format through the
  // same entry point the curved smoke test uses.
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect.poll(() => countObjects(page), { timeout: 30_000 }).toBe(2);
});
