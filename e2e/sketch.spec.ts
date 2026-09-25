import { test, expect, type Page } from '@playwright/test';

/**
 * Sketch-workspace flows: entering a sketch on a datum plane, the trim tool,
 * and the extrude dialog's numeric-expression field. The default locale is
 * English (src/lib/i18n.ts falls back to 'en'), so footer/button labels are
 * asserted in English.
 *
 * Sketch entry has no keyboard shortcut that creates a sketch document — the
 * real UI path is clicking one of the three datum planes that fill the model
 * viewport at boot (ViewportCanvas handleClick → setCurrentSketch). A click at
 * the viewport centre always lands on one of them; whichever plane wins, the
 * camera then snaps normal-to it, and the drawing gestures below are
 * screen-relative, so they work for any of the three planes.
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

/** Read the sketch "Entities: N" counter from the status bar (-1 if absent). */
async function countEntities(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Entities:\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

/** Click the datum plane at the viewport centre → sketch mode on that plane. */
async function enterSketchAtCentre(page: Page): Promise<{ cx: number; cy: number }> {
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // The entity counter only renders while a sketch document is active; a fresh
  // sketch has zero entities.
  await expect.poll(() => countEntities(page), { timeout: 5_000 }).toBe(0);
  // Let the camera finish snapping normal-to the plane.
  await page.waitForTimeout(300);
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

test('trim removes one piece of a crossed line and a single Ctrl+Z restores it', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);
  const { cx, cy } = await enterSketchAtCentre(page);

  // The line tool commits on press-drag-release (drawStart on mousedown,
  // addSketchLine on mouseup). First line: horizontal, through the view centre
  // (grid snap keeps it on the y=0 row). 2 endpoints + 1 line = 3 entities.
  await page.keyboard.press('l');
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 200, cy, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countEntities(page)).toBe(3);

  // Second line starts exactly on the first line's midpoint — endpoint/
  // midpoint snapping (0.4mm radius) grabs it when the press lands at the view
  // centre — and drops away perpendicular. It crosses the first line at its
  // own start point, so the crossing is an existing sketch point.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 150, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countEntities(page)).toBe(6);

  // Arm Trim (aria-labelled toolbar button, aria-pressed reflects the tool).
  const trimBtn = page.getByRole('button', { name: 'Trim', exact: true });
  await expect(trimBtn).toHaveAttribute('aria-pressed', 'false');
  await trimBtn.click();
  await expect(trimBtn).toHaveAttribute('aria-pressed', 'true');

  // Click the crossed line well left of the crossing: that piece is removed.
  // The surviving piece reuses the existing crossing + endpoint points, so the
  // entity count drops by exactly one (the removed piece's outer endpoint is
  // orphaned away with its line).
  await page.mouse.click(cx - 150, cy);
  await expect.poll(() => countEntities(page)).toBe(5);

  // Sketch-scoped undo: one Ctrl+Z brings the trimmed piece back.
  await page.keyboard.press('Control+z');
  await expect.poll(() => countEntities(page)).toBe(6);
});

test('extrude dialog evaluates a numeric expression (20/2 → 10 mm feature)', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);
  const { cx, cy } = await enterSketchAtCentre(page);

  // Rectangle tool (R): one drag, committed on release as a closed profile of
  // 4 corner points + 4 line edges = 8 entities.
  await page.keyboard.press('r');
  await page.mouse.move(cx - 120, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countEntities(page)).toBe(8);

  // E opens the extrude dialog for the active sketch.
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#extrude-distance').fill('20/2');
  // Expressions get a live "= value" preview before committing.
  await expect(dialog.getByText('= 10')).toBeVisible();
  await dialog.getByRole('button', { name: 'Extrude' }).click();

  // Extruding returns to the model workspace with two features on the
  // timeline — the bar only renders when features exist.
  const timeline = page.getByRole('toolbar', { name: 'Timeline' });
  await expect(timeline).toBeVisible();
  await expect(timeline.getByText('Sketch')).toBeVisible();
  await expect(timeline.getByText('Extrude')).toBeVisible();
  // The extrude chip's summary shows the EVALUATED distance, proving the
  // expression was computed (not rejected, not committed as text).
  await expect(timeline.getByText('10mm')).toBeVisible();

  // The extruded solid exists (status-bar object counter, like smoke) …
  const countObjects = (): Promise<number> =>
    page.evaluate(() => {
      const m = /Objects:\s*(\d+)/.exec(document.body.textContent ?? '');
      return m ? +m[1]! : -1;
    });
  await expect.poll(countObjects).toBe(1);

  // … and clicking the timeline chip selects the body it produced, so the
  // properties panel reports it (BBox line, as in the smoke suite).
  await timeline.getByRole('button', { name: /extrude/i }).click();
  await expect
    .poll(async () => page.evaluate(() => {
      const panels = [...document.querySelectorAll('[role=complementary]')].map((p) => p.textContent ?? '');
      return panels.some((t) => t.includes('BBox Center:'));
    }), { timeout: 10_000 }).toBe(true);
});
