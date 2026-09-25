import { test, expect, type Page } from '@playwright/test';

/**
 * Sketch Offset flow (Fusion's equidistant copy): enter a sketch through the
 * workspace toolbar's Sketch button (which starts a default-plane sketch
 * document), draw a circle by press-drag-release, select it, arm Offset in the
 * sketch toolbar, type the distance into the numeric prompt and commit with
 * Enter, then Ctrl+Z the copy away. The status-bar entity counter is the
 * assertion workhorse, as in the other sketch specs.
 *
 * Entity bookkeeping for this flow: drawing a circle creates its centre point
 * + the circle (2 entities). Offsetting a circle copies BOTH (a fresh centre
 * point + the grown circle), so the committed offset adds 2 entities — the
 * store's offsetSketchProfile calls addCircle, which always creates the centre
 * point alongside the ring (src/lib/sketch/offset.ts + engine.ts).
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

test('offset a drawn circle through the numeric prompt, then Ctrl+Z restores it', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // The workspace toolbar's Sketch button starts (or resumes) a sketch on the
  // default plane — no datum-plane click needed (store setWorkspace('sketch')).
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  // The entity counter only renders while a sketch document is active; the
  // fresh default-plane sketch is empty.
  await expect.poll(() => countEntities(page), { timeout: 5_000 }).toBe(0);

  // Circle tool (O), then press-drag-release: press at the centre, drag out
  // the radius, release to commit. 1 centre point + 1 circle = 2 entities.
  await page.keyboard.press('o');
  const rimX = cx + 150;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(rimX, cy, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countEntities(page)).toBe(2);

  // Select tool (V) and click exactly on the rim point the drag ended at: the
  // projected click lands on the ring (distance ~0 within the 0.5 mm pick
  // tolerance), while the radius dimension label sits at the circle's centre,
  // well clear of the click. The Offset button wakes up once an offsetable
  // entity is selected.
  await page.keyboard.press('v');
  const offsetBtn = page.getByRole('button', { name: 'Offset entity' });
  await expect(offsetBtn).toBeDisabled();
  await page.mouse.click(rimX, cy);
  await expect(offsetBtn).toBeEnabled();

  // Arm Offset → the numeric prompt opens with the distance field.
  await offsetBtn.click();
  const prompt = page.locator('#numeric-prompt-input');
  await expect(prompt).toBeVisible();
  await prompt.fill('3');
  await prompt.press('Enter');

  // Committing runs offsetSelectedSketch(3): a grown copy of the circle
  // appears (fresh centre point + ring = +2 entities), the prompt closes and
  // the copy becomes the new selection.
  await expect.poll(() => countEntities(page)).toBe(4);
  await expect(prompt).toBeHidden();

  // Sketch-scoped undo: one Ctrl+Z removes the offset copy, leaving the
  // original circle untouched.
  await page.keyboard.press('Control+z');
  await expect.poll(() => countEntities(page)).toBe(2);
});
