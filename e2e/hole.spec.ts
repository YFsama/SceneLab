import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Hole feature E2E — the Fusion-style hole flow through the real UI.
 *
 * The first test drives the parametric path the timeline exists for: a
 * sketch→extrude box, then right-click the body → Feature → Hole with the
 * two-step numeric prompt (diameter, then depth — 0 drills through-all). The
 * hole lands as a THIRD timeline chip, keeps the footer object count at one,
 * removes ~πr²·h of material (read from the properties panel like the smoke
 * suite's readouts), and a single Ctrl+Z removes the chip again.
 *
 * The second test keeps the literal insert path from the plan — a box via the
 * context menu's Insert flyout — and documents how it differs: an inserted
 * box is a DIRECT body with no feature history, so the hole is an undoable
 * in-place edit and no timeline chip appears (Objects still stays at one and
 * Ctrl+Z restores the un-drilled volume).
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

/** Read the status-bar "Objects: N" counter (as the smoke suite does). */
async function countObjects(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Objects:\s*(\d+)/.exec(document.body.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

/** Read the sketch "Entities: N" counter from the status bar (-1 if absent). */
async function countEntities(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Entities:\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

/**
 * The selected body's volume in mm³ from the properties panel (the volume
 * row is the panel's only mm³ figure); null while nothing is selected.
 */
async function readVolume(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const panels = [...document.querySelectorAll('[role=complementary]')].map((p) => p.textContent ?? '');
    const hit = panels.find((t) => t.includes('mm³'));
    if (!hit) return null;
    const m = /([\d.]+)\s*mm³/.exec(hit);
    return m ? +m[1]! : null;
  });
}

/** Click the body at the viewport centre to select it, then read its volume. */
async function selectAndReadVolume(page: Page, center: { x: number; y: number }): Promise<number> {
  await page.mouse.click(center.x, center.y);
  await expect.poll(() => readVolume(page), { timeout: 5_000 }).not.toBeNull();
  return (await readVolume(page))!;
}

/** The timeline chips (the only draggable buttons in the timeline toolbar). */
function chips(timeline: Locator): Locator {
  return timeline.locator('button[draggable]');
}

/** aria-labels of all timeline chips, in build order. */
async function chipLabels(timeline: Locator): Promise<string[]> {
  return chips(timeline).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/**
 * Right-click the body at `center` → Feature flyout → Hole, answering the
 * two-step numeric prompt (diameter, then depth; 0 = through-all). Since the
 * click-to-place rework the prompts ARM a one-shot placement instead of
 * drilling at the centroid: `beforePlace` (optional) runs first — e.g. to
 * switch to a top view — then the click at `place` drills at that point.
 */
async function applyHoleViaMenu(
  page: Page,
  center: { x: number; y: number },
  diameter: string,
  depth: string,
  place: { x: number; y: number },
  beforePlace?: () => Promise<void>,
) {
  await page.mouse.click(center.x, center.y, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // The submenu item's accessible name carries the ▸ flyout marker.
  const featureItem = menu.getByRole('menuitem', { name: /^Feature\b/ });
  await featureItem.hover();
  await featureItem.click();
  // The Feature flyout opens; its Hole item starts the two-step prompt.
  await page.getByRole('menuitem', { name: 'Hole', exact: true }).click();
  const input = page.locator('#numeric-prompt-input');
  await expect(input).toBeVisible();
  await input.fill(diameter);
  await input.press('Enter');
  // The prompt reopens keyed for the depth question.
  await expect(input).toBeVisible();
  await input.fill(depth);
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // ARMED: the hint pill shows the pick instruction — the click drills.
  await expect(page.getByText('Click the body where the hole should start')).toBeVisible();
  if (beforePlace) await beforePlace();
  await page.mouse.click(place.x, place.y);
}

test('hole on a parametric body: timeline chip, volume drop, Ctrl+Z removes the chip', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);

  // Sketch entry via the datum-plane click (the sketch/timeline suites'
  // path — an inserted box would be a direct body with no feature history),
  // then a centred rectangle drag (R tool) and the extrude dialog's Extrude
  // button (default 10 mm).
  // The click lands 40 px BELOW the screen centre: all three 3×3 datum quads
  // meet at the origin, and from the iso camera the dead centre hits the
  // vertical 'yz' diamond. Since extrude became plane-aware (it follows the
  // sketch plane's true normal), this test needs the GROUND plane so the hole
  // drills down the 10 mm extrude axis — the ground diamond starts just under
  // the origin on screen.
  const box = (await page.locator('#viewport-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 40);
  await expect.poll(() => countEntities(page), { timeout: 5_000 }).toBe(0);
  await page.waitForTimeout(300); // let the camera finish snapping normal-to

  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => countEntities(page)).toBe(8);

  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Extrude' }).click();
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);

  // The timeline bar appears with the sketch→extrude pair as two chips.
  const timeline = page.getByRole('toolbar', { name: 'Timeline' });
  await expect(timeline).toBeVisible();
  await expect(chips(timeline)).toHaveCount(2);

  // Frame the body so it sits at the viewport centre under the cursor, select
  // it, and snapshot its volume from the properties panel.
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const center = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  const before = await selectAndReadVolume(page, center);
  expect(before).toBeGreaterThan(0);

  // Right-click the body → Feature → Hole: ⌀2, depth 0 = through-all. The
  // placement click needs an exact TOP view ('2' + fit) so the centre click
  // lands dead-centre on the top face — the near-top sketch camera offsets it
  // toward the footprint edge and would clip the hole.
  // ⌀2 (not ⌀4): the drag produces a ~3×5 mm footprint — a ⌀4 circle would
  // be clipped by the 3 mm sides, making the removed volume depend on the
  // clipping math instead of the clean cylinder formula below.
  await applyHoleViaMenu(page, center, '2', '0', center, async () => {
    await page.keyboard.press('2');
    await page.waitForTimeout(400); // let the view snap finish
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
  });

  // The timeline gained the Hole chip as the third feature.
  await expect(chips(timeline)).toHaveCount(3);
  await expect.poll(async () => (await chipLabels(timeline)).join(' | '), { timeout: 5_000 })
    .toMatch(/1\. Sketch .+ \| 2\. Extrude \| 3\. Hole$/);

  // The hole consumed its parent — still exactly one object.
  expect(await countObjects(page)).toBe(1);

  // The properties panel volume dropped by ~π·1²·10 (a ⌀2 cylinder through
  // the 10 mm extrude), the same readout the smoke suite parses. Re-select
  // from an OBLIQUE view first: in the top view the centre click would shoot
  // straight down the new through-hole shaft onto the sketch plane below
  // (starting a sketch instead of selecting the body).
  await page.keyboard.press('4');
  await page.waitForTimeout(400);
  const after = await selectAndReadVolume(page, center);
  const removed = before - after;
  const ideal = Math.PI * 1 * 1 * 10;
  expect(removed).toBeGreaterThan(ideal * 0.8);
  expect(removed).toBeLessThan(ideal * 1.2);

  // A single Ctrl+Z removes the hole feature. Undo swaps the feature list in
  // place without bumping featureVersion, so the chips repaint only after a
  // TimelineBar re-render — the same stale-render the timeline suite
  // documents. The timeline's own Recompute button is the in-app trigger:
  // recomputeTree bumps featureVersion and repaints the chips.
  const undoDepth = (): Promise<number> =>
    page.evaluate(() => Number(/↺\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '')?.[1] ?? -1));
  const depthBefore = await undoDepth();
  await page.keyboard.press('Control+z');
  await expect.poll(undoDepth, { timeout: 5_000 }).toBe(depthBefore - 1); // the undo committed

  await timeline.getByRole('button', { name: /recompute/i }).click();
  await expect(chips(timeline)).toHaveCount(2);
  await expect.poll(async () => (await chipLabels(timeline)).join(' | '), { timeout: 5_000 })
    .not.toContain('Hole');
  // …and the material is back.
  const restored = await selectAndReadVolume(page, center);
  expect(Math.abs(restored - before)).toBeLessThan(0.5);
});

test('hole on a context-menu-inserted box edits the direct body in place (undoable, no chip)', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);

  // Right-click empty viewport → Insert → Box; Enter commits the 20 mm cube.
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);

  // Frame, select, and snapshot the box's volume (20×20×20 = 8000 mm³).
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const center = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  const before = await selectAndReadVolume(page, center);
  expect(before).toBeGreaterThan(7000);

  // Right-click the body → Feature → Hole: ⌀4 through-all on the direct box.
  // The placement click needs the TOP face: from the iso view the centre ray
  // hits the box's vertical corner, so switch to a top view ('2' + fit)
  // before the click — the centre then lands on the top face centre and the
  // full ⌀4 cylinder is removed (what the volume assertion below expects).
  await applyHoleViaMenu(page, center, '4', '0', center, async () => {
    await page.keyboard.press('2');
    await page.waitForTimeout(400); // let the view snap finish
    await page.keyboard.press('f');
    await page.waitForTimeout(300);
  });

  // A direct body has no feature history: no timeline chip appears…
  await expect(page.locator('button[draggable]')).toHaveCount(0);
  // …the object count stays at one…
  expect(await countObjects(page)).toBe(1);
  // …and the hole removed ~π·2²·20 (a ⌀4 cylinder through the 20 mm box).
  // Re-select from an OBLIQUE view first — the top-view centre click would
  // fall straight down the through-hole shaft (see test 1).
  await page.keyboard.press('4');
  await page.waitForTimeout(400);
  const after = await selectAndReadVolume(page, center);
  const ideal = Math.PI * 2 * 2 * 20;
  expect(before - after).toBeGreaterThan(ideal * 0.8);
  expect(before - after).toBeLessThan(ideal * 1.2);

  // One Ctrl+Z restores the un-drilled box.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const restored = await selectAndReadVolume(page, center);
  expect(Math.abs(restored - before)).toBeLessThan(0.5);
});
