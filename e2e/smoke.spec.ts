import { test, expect } from '@playwright/test';

/**
 * Workspace smoke flows — the minimum bar before any release: the app boots,
 * a primitive can be inserted through the real UI, and it shows up in the
 * browser tree. Runs headless (WebGL via SwiftShader).
 *
 * The first-run welcome card is dismissed up front: it overlays the viewport
 * (quick-start buttons) and would both intercept canvas clicks and shadow
 * toolbar buttons by name.
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

test('app boots to the modeling workspace', async ({ page }) => {
  await page.goto('/');
  // The workspace switcher renders all four modes.
  await expect(page.getByRole('button', { name: 'Sketch', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible();
  // The WebGL viewport canvas is mounted and sized.
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  }, { timeout: 10_000 }).toBe(true);
});

test('insert a box through the context menu and see it in the tree', async ({ page }) => {
  await page.goto('/');

  // Right-click empty viewport → Insert → Box. The insert dialog opens with
  // sensible defaults and commits on Enter (SolidWorks-style flow).
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  // The Insert flyout opens a submenu of primitives.
  await page.getByRole('menuitem', { name: 'Box' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.press('Enter');

  // The box appears in the browser tree by its auto-numbered name.
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
});

test('import a curved STEP file through the exact OCCT kernel', async ({ page }) => {
  await page.goto('/');

  // The hidden mesh-import input accepts the curved fixture directly; the
  // curved-surface heuristic routes it to the lazy occt-import-js chunk.
  await page.locator('input[type="file"]').setInputFiles('e2e/fixtures/conical-surface.step');

  // The kernel toast confirms the exact engine was used (wasm fetched + run).
  await expect(page.getByText(/exact OCCT kernel/).first()).toBeVisible({ timeout: 30_000 });
  // The tessellated cone lands in the browser tree under the file name.
  await expect(page.getByText('conical-surface', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});

test('drag a body to move it, as one undo step', async ({ page }) => {
  await page.goto('/');

  // Insert a Box through the context menu (20mm cube at the origin).
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  // Frame it so the box sits at the viewport centre under the cursor.
  await page.keyboard.press('f');
  await page.waitForTimeout(300);

  // A plain click on the box in the viewport selects it (properties panel).
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const cx = vb.x + vb.width / 2;
  const cy = vb.y + vb.height / 2;
  await page.mouse.click(cx, cy);
  // Reads the selected body's bbox-centre line straight from the properties
  // panel (mixed JSX text nodes defeat getByText here).
  const readCenter = async (): Promise<[number, number, number] | null> => {
    const txt = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('[role=complementary]')].map((p) => p.textContent ?? '');
      const hit = panels.find((t) => t.includes('BBox Center:') || t.includes('包围盒中心'));
      if (!hit) return null;
      const i = hit.includes('BBox Center:') ? hit.indexOf('BBox Center:') : hit.indexOf('包围盒中心');
      return hit.slice(i);
    });
    const m = /\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/.exec(txt ?? '');
    return m ? [+m[1]!, +m[2]!, +m[3]!] : null;
  };
  const before = await readCenter();
  expect(before).not.toBeNull();

  // Grab the box at the viewport centre and slide the mouse right-down.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 30, { steps: 10 });
  await page.mouse.up();

  const after = await readCenter();
  expect(after).not.toBeNull();
  const planarMove = Math.abs(after![0]! - before![0]!) + Math.abs(after![2]! - before![2]!);
  expect(planarMove).toBeGreaterThan(0);

  // The whole drag is exactly one history entry: a single Ctrl+Z restores
  // the pre-drag position (grid-snapped moves never split into frames).
  // Undo clears the selection, so re-click the box (back at the centre)
  // before reading its centre again.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  await page.mouse.click(cx, cy);
  const undone = await readCenter();
  expect(Math.abs(undone![0]! - before![0]!) + Math.abs(undone![2]! - before![2]!)).toBeLessThan(1e-6);
});
