import { test, expect, type Page } from '@playwright/test';

/**
 * Responsive-layout flows (I3): the Tauri window shrinks to 800×600 minimum.
 * At that size the compact layout (< 960 CSS px) suppresses the docked side
 * panels at the App RENDER layer (the persisted store switches stay
 * untouched), the viewport keeps ≥ 400 px of canvas, nothing overflows the
 * document horizontally, and the key flows — command palette, primitive
 * insert, feature timeline — still work in the narrow window.
 *
 * Selector/flow conventions follow smoke.spec.ts / palette.spec.ts /
 * timeline.spec.ts. Default locale is English; asserted strings are English.
 */
test.beforeEach(({ page }) => {
  // Dismiss the welcome overlay AND arm every dock panel: compact suppression
  // is what keeps the 800px layout sane with "all panels on", so the tests
  // run against that worst case.
  page.addInitScript(() => {
    localStorage.setItem('scenelab.welcomeDismissed', 'true');
    localStorage.setItem('scenelab.showBrowserTree', 'true');
    localStorage.setItem('scenelab.showProperties', 'true');
    localStorage.setItem('scenelab.showPartsLibrary', 'true');
  });
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

/** The app root mirrors the live breakpoint for exactly these assertions. */
async function breakpoint(page: Page): Promise<string | null> {
  return page.locator('div[data-viewport]').getAttribute('data-viewport');
}

/** No horizontal document overflow (2px tolerance for subpixel rounding). */
function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 2,
  );
}

/** The 3D canvas' laid-out CSS width. */
function canvasWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('#viewport-canvas')?.clientWidth ?? 0);
}

/** The status-bar "Objects: N" counter (-1 if absent). */
function countObjects(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Objects:\s*(\d+)/.exec(document.body.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

/** Insert a primitive through the command palette (Ctrl+K → query → click the
 * matched "Add <kind>" row — clicking instead of Enter-on-top-hit so the
 * assertion doesn't depend on fuzzy ranking). The row's accessible name also
 * carries the "Create ·" category prefix, hence the unanchored regex. */
async function paletteInsert(page: Page, kind: string) {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  await input.fill(kind);
  const hit = page.getByRole('button', { name: new RegExp(`add ${kind}`, 'i') });
  await expect(hit).toBeVisible();
  await hit.click();
  // Running closes the palette.
  await expect(input).toHaveCount(0);
}

test('boots at 1280×800 with all panels docked and the viewport usable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await awaitCanvas(page);

  // 1280 CSS px is the 'normal' band (960 ≤ w < 1440).
  expect(await breakpoint(page)).toBe('normal');

  // All docked panels render inline: browser tree (role=tree), parts library
  // and properties (complementary asides). 48 toolbar + 224 + 240 + 240 px
  // still leaves the canvas > 400 px wide at 1280.
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Properties' })).toBeVisible();
  expect(await canvasWidth(page)).toBeGreaterThanOrEqual(400);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('800×600 compact: no overflow, ≥400px canvas, palette insert + timeline work', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await awaitCanvas(page);

  // --- Shrink to the Tauri minimum and settle the compact layout. ---
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(() => breakpoint(page), { timeout: 5_000 }).toBe('compact');

  // The docked panels are suppressed at the RENDER layer (store flags stay
  // on — verified below by the localStorage round-trip and the re-widen).
  await expect(page.getByRole('tree')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Properties' })).toHaveCount(0);

  // No horizontal document overflow and the viewport canvas keeps ≥ 400 px.
  expect(await noHorizontalOverflow(page)).toBe(true);
  expect(await canvasWidth(page)).toBeGreaterThanOrEqual(400);

  // --- Feature timeline flow in the narrow window: one sketch→extrude entry
  // (timeline.spec's proven path — centre click on the datum plane, R
  // rectangle drag, E extrude dialog, Extrude button). A timeline entry needs
  // a FEATURE: a palette-inserted Box is a direct body and deliberately never
  // chips onto the timeline, which is why the box below is asserted through
  // the Objects counter instead.
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(
    () => page.evaluate(() =>
      Number(/Entities:\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '')?.[1] ?? -1)),
    { timeout: 5_000 },
  ).toBe(0);
  await page.waitForTimeout(300); // let the camera snap normal-to the plane
  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 60);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Extrude' }).click();

  // The timeline bar appears with the sketch + extrude chips.
  const timeline = page.getByRole('toolbar', { name: 'Timeline' });
  await expect(timeline).toBeVisible({ timeout: 10_000 });
  await expect(timeline.locator('button[draggable]')).toHaveCount(2);

  // --- Command palette insert in the narrow window. ---
  const before = await countObjects(page);
  expect(before).toBeGreaterThanOrEqual(1); // the extruded body
  await paletteInsert(page, 'box');
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(before + 1);

  // Still no horizontal overflow with timeline chips + a fuller tree.
  expect(await noHorizontalOverflow(page)).toBe(true);

  // --- Widening restores the docked panels: compact was render-only, and the
  // persisted switch was never rewritten.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(() => breakpoint(page), { timeout: 5_000 }).toBe('normal');
  await expect(page.getByRole('tree')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Properties' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('scenelab.showBrowserTree'))).toBe('true');
  expect(await page.evaluate(() => localStorage.getItem('scenelab.showProperties'))).toBe('true');
});

test('800×600 cold boot: the palette searches and executes', async ({ page }) => {
  // Set the size BEFORE navigation so the app boots straight into compact.
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto('/');
  await awaitCanvas(page);
  expect(await breakpoint(page)).toBe('compact');

  // Palette search + execute at the minimum window size.
  const before = await countObjects(page);
  await paletteInsert(page, 'cylinder');
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(before + 1);

  expect(await noHorizontalOverflow(page)).toBe(true);
});
