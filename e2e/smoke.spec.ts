import { test, expect } from '@playwright/test';

/**
 * Workspace smoke flows — the minimum bar before any release: the app boots,
 * a primitive can be inserted through the real UI, and it shows up in the
 * browser tree. Runs headless (WebGL via SwiftShader).
 */

test('app boots to the modeling workspace', async ({ page }) => {
  await page.goto('/');
  // The workspace switcher renders all four modes.
  await expect(page.getByRole('button', { name: 'Sketch' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model' })).toBeVisible();
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
