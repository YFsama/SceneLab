import { test, expect, type Page } from '@playwright/test';

/**
 * Command-palette modeling verbs (F3): the palette exposes the same feature /
 * transform actions the right-click menu has. The fillet verb is driven end
 * to end through the real UI — a selected box gets the feature applied via
 * the numeric prompt (volume drops), and with nothing selected the verb
 * refuses deterministically with the needs-body toast. Default locale is
 * English, so palette/prompt/toast strings are asserted in English.
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

/** Insert a default 20mm box via the empty-space context menu (drawing.spec's
 * proven flow: right-click empty viewport → Insert → Box → Enter). */
async function insertBox(page: Page) {
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
}

/** The selected body's volume in mm³ from the properties panel; null while
 * nothing is selected (same readout the hole suite uses). */
async function readVolume(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll('[role=complementary]')].map((p) => p.textContent ?? '');
    const hit = panels.find((t) => t.includes('mm³'));
    if (!hit) return null;
    const m = /([\d.]+)\s*mm³/.exec(hit);
    return m ? +m[1]! : null;
  });
}

/** Open the palette (Ctrl+K), type a query, run the top hit with Enter. */
async function runPaletteCommand(page: Page, query: string) {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  await input.fill(query);
  await input.press('Enter');
  // Running closes the palette.
  await expect(input).toHaveCount(0);
}

test('palette: fillet applies to the selected box (volume drops)', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);
  await insertBox(page);

  // Select the box (auto-framed at the viewport centre on insert) and read
  // its volume: 20×20×20 = 8000 mm³.
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => readVolume(page), { timeout: 5_000 }).not.toBeNull();
  const before = (await readVolume(page))!;
  expect(before).toBeGreaterThan(7000);

  // Palette → fillet: the verb is registered and searchable.
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  await input.fill('fillet');
  await expect(page.getByRole('button', { name: /fillet/i }).first()).toBeVisible();
  await input.press('Enter');

  // The numeric prompt is the SAME one the context menu opens (title + label
  // from feature.fillet / feature.filletPrompt).
  const prompt = page.getByRole('dialog');
  await expect(prompt).toBeVisible();
  await expect(prompt.getByText('Fillet radius (mm)')).toBeVisible();
  await prompt.locator('#numeric-prompt-input').fill('2');
  await prompt.locator('#numeric-prompt-input').press('Enter');

  // Feature applied — the deterministic success toast fires first (assert it
  // inside its 3s window, before any slower polling).
  await expect(page.getByText('Feature applied')).toBeVisible();
  // The whole-body fillet reshaped the box: the edge arc strips move the
  // volume readout off the crisp 20×20×20 = 8000.00 mm³.
  await expect.poll(() => readVolume(page), { timeout: 5_000 }).not.toBe(before);
});

test('palette: fillet without a selection toasts "Select a body first"', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);
  await insertBox(page);

  // Click empty space (viewport corner, clear of the centred box) so nothing
  // is selected — the insert itself selects nothing.
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.08, box.y + box.height * 0.08);

  await runPaletteCommand(page, 'fillet');
  // No prompt opens; the deterministic needs-body toast appears instead.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Select a body first')).toBeVisible();
});
