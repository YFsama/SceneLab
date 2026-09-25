import { test, expect, type Page } from '@playwright/test';

/**
 * Measure-tool flows: arming with M (the toolbar toggle reflects it via
 * aria-pressed), the three-point angle readout in the HUD, and the Area mode
 * face measurement. The HUD is the font-mono panel the viewport overlays at
 * its top-left while measure is armed; its mode switcher buttons are labelled
 * Distance/Angle/Area in the default English locale.
 *
 * The 20 mm box is inserted through the same context-menu flow the smoke
 * suite uses, then framed with F so its silhouette sits centred in the
 * viewport under an isometric-ish camera. Measure clicks land on the body
 * (inside the silhouette) and snap to the nearest corner / edge midpoint /
 * face centre within 10% of the body diagonal — the three clicks are spread
 * around the silhouette so they snap to three DISTINCT features and the angle
 * at the middle vertex is well-defined.
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

/** Wait for the WebGL canvas to be mounted and usefully sized (as smoke does). */
async function awaitCanvas(page: Page) {
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  }, { timeout: 10_000 }).toBe(true);
  return canvas;
}

test('measure: three-point angle readout, then Area mode reads the picked face', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);

  // Insert a Box through the context menu (20 mm cube at the origin).
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.press('Enter');
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  // Frame the cube so it sits centred in the viewport under the cursor.
  await page.keyboard.press('f');
  await page.waitForTimeout(300);

  // Plain M arms measure (SolidWorks/Onshape muscle memory): the toolbar
  // toggle reflects the armed state via aria-pressed, and the HUD mounts at
  // the viewport's top-left with its Distance/Angle/Area mode switcher.
  const measureToggle = page.getByRole('button', { name: /measure/i }).first();
  await expect(measureToggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('m');
  await expect(measureToggle).toHaveAttribute('aria-pressed', 'true');

  const hud = page.locator('div.absolute.top-12.left-2');
  await expect(hud).toBeVisible();
  const areaBtn = hud.getByRole('button', { name: 'Area', exact: true });
  await expect(areaBtn).toBeVisible();
  // Distance is the default mode on arming.
  await expect(hud.getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Three points on the cube — near the silhouette's top, right and bottom —
  // each snaps to a distinct corner/edge feature, so the readout after the
  // third click is the angle at the middle vertex.
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const cx = vb.x + vb.width / 2;
  const cy = vb.y + vb.height / 2;
  const r = 0.22 * Math.min(vb.width, vb.height);
  await page.mouse.click(cx, cy - r);
  await page.mouse.click(cx + r, cy);
  await page.mouse.click(cx, cy + r);

  // The HUD's angle readout is a real number of degrees (a degenerate pick
  // would render NaN, and three distinct corners give a substantial angle).
  await expect.poll(async () => /Angle:\s*([-\d.]+)°/.exec(await hud.textContent() ?? '')?.[1] ?? '', { timeout: 5_000 })
    .toMatch(/^\d+(\.\d+)?$/);
  const angle = Number(/Angle:\s*([-\d.]+)°/.exec(await hud.textContent() ?? '')?.[1]);
  expect(angle).toBeGreaterThan(5);

  // Switch the HUD to Area mode: the mode button flips aria-pressed and any
  // in-progress point picks reset. The click is dispatched at the DOM level
  // because the HUD's mode row sits underneath the floating primitive bar at
  // the viewport's top-centre — a coordinate click there would hit the bar.
  await areaBtn.dispatchEvent('click');
  await expect(areaBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(hud.getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute('aria-pressed', 'false');

  // Click the cube's front: the ray picks the face under the cursor and the
  // HUD reports its area — every face of the 20 mm cube is 400.00 mm².
  await page.mouse.click(cx, cy);
  await expect.poll(async () => /Area:\s*([\d.]+)\s*mm²/.exec(await hud.textContent() ?? '')?.[1] ?? '', { timeout: 5_000 })
    .toBe('400.00');

  // M disarms the tool again; the HUD leaves with it.
  await page.keyboard.press('m');
  await expect(measureToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(hud).toHaveCount(0);
});
