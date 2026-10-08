import { test, expect } from '@playwright/test';

/**
 * Canvas backing-store resize flows: the WebGL viewport and the 2D drawing
 * sheet both re-apply their backing-store size when the viewport (and thus
 * the container CSS size) changes. Runs headless at deviceScaleFactor 1, so
 * a correctly-sized canvas has width attribute ≈ its CSS width.
 *
 * The first-run welcome card is dismissed up front (it overlays the viewport
 * and would shadow toolbar buttons).
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

test('the WebGL viewport canvas re-sizes its backing store on viewport resize', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  }, { timeout: 10_000 }).toBe(true);

  const read = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLCanvasElement>('#viewport-canvas')!;
      return { attr: el.width, client: el.clientWidth };
    });
  const before = await read();
  // dpr = 1 in this project's chromium device: backing == client size.
  expect(Math.abs(before.attr - before.client)).toBeLessThanOrEqual(8);

  // Shrink the viewport; ResizeObserver must re-apply the renderer size.
  // (The canvas may end up WIDER than before — the side panels collapse on
  // narrow windows — so the contract checked is "backing store followed the
  // new container size", not monotonic shrink.)
  await page.setViewportSize({ width: 900, height: 640 });
  await expect
    .poll(async () => (await read()).attr, { timeout: 10_000 })
    .not.toBe(before.attr);

  const after = await read();
  expect(Math.abs(after.attr - after.client)).toBeLessThanOrEqual(8);
});

test('the drawing sheet canvas follows the container at native resolution', async ({ page }) => {
  await page.goto('/');

  // The sheet only mounts with a body present: insert a box through the
  // context menu (the smoke-suite flow).
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await menu.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  // D switches to the drawing workspace; the sheet canvas mounts.
  await page.keyboard.press('d');
  const sheet = page.getByRole('img', { name: 'Drawing view' });
  await expect(sheet).toBeVisible();

  // The sheet used to be a FIXED 800×600 attribute canvas stretched by CSS;
  // now the backing store tracks the container (CSS × dpr).
  const read = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLCanvasElement>('canvas[role="img"][aria-label="Drawing view"]');
      if (!el) throw new Error('drawing sheet canvas not mounted');
      return { attr: el.width, client: el.clientWidth };
    });

  const before = await read();
  expect(Math.abs(before.attr - before.client)).toBeLessThanOrEqual(8);

  await page.setViewportSize({ width: 900, height: 640 });
  await expect
    .poll(async () => (await read()).attr, { timeout: 10_000 })
    .not.toBe(before.attr);

  const after = await read();
  expect(Math.abs(after.attr - after.client)).toBeLessThanOrEqual(8);
});
