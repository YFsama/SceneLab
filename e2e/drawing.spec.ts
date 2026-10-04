import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'fs/promises';

/**
 * Drawing-workspace flow: the Note tool places a text note on the sheet via an
 * inline editor, the footer's project-dirty dot appears, and the text edit is
 * undoable. Default locale is English ('en' fallback in src/lib/i18n.ts), so
 * the aria labels asserted here are the English ones.
 *
 * The sheet only renders when bodies exist (DrawingCanvas early-returns a
 * placeholder when the scene is empty), so a box is inserted first through the
 * same context-menu flow the smoke suite uses. The box insert itself marks the
 * project dirty, so the project is saved (Ctrl+S) up front — that makes the
 * dirty dot's reappearance attributable to the note edit alone.
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

/** Read the footer undo/redo depth (↺ n · ↻ m); null while hidden. */
function undoDepth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const m = /↺\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '');
    return m ? +m[1]! : null;
  });
}

test('place a drawing note, commit it with Enter, then undo the text edit', async ({ page }) => {
  await page.goto('/');

  // The sheet needs a body: right-click empty viewport → Insert → Box.
  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect(page.getByText('Box', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  // Clear the insert's dirty flag (Ctrl+S saves + clears) so the note — not
  // the box — is what marks the project dirty below.
  const projectBtn = page.locator('footer[role=status] button').first();
  await page.keyboard.press('Control+s');
  await expect(projectBtn).not.toContainText('•');

  // D switches to the drawing workspace; the sheet canvas mounts.
  await page.keyboard.press('d');
  const sheet = page.getByRole('img', { name: 'Drawing view' });
  await expect(sheet).toBeVisible();

  // Arm the Note tool (aria-pressed reflects the armed state).
  const noteBtn = page.getByRole('button', { name: 'Note', exact: true });
  await expect(noteBtn).toHaveAttribute('aria-pressed', 'false');
  await noteBtn.click();
  await expect(noteBtn).toHaveAttribute('aria-pressed', 'true');

  // Click the sheet centre — clear of the four projected views' dimension
  // labels (the grid divider cross, ≥40px from any geometry) — to place the
  // note; the inline text editor opens on it immediately.
  const sb = (await sheet.boundingBox())!;
  const nx = sb.x + sb.width / 2;
  const ny = sb.y + sb.height / 2;
  await page.mouse.click(nx, ny);
  const editor = page.getByRole('textbox', { name: 'Note text' });
  await expect(editor).toBeVisible();

  // Type the note and commit with Enter: the inline editor closes…
  await editor.fill('QA note');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);

  // …and the footer's project-name button carries the dirty dot (•) again —
  // caused by the note edit this time, not the earlier insert.
  await expect(projectBtn).toContainText('•');

  // The committed note is re-editable: double-clicking the placed note reopens
  // the inline editor carrying the committed text.
  await page.mouse.dblclick(nx, ny);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('QA note');
  // Esc cancels the re-edit without changing the note.
  await editor.press('Escape');
  await expect(editor).toHaveCount(0);

  // Ctrl+Z undoes the note's text commit — the drawing sheet is part of the
  // undo history, so the status bar's undo depth drops by one. (The dirty dot
  // does NOT clear on undo: app.ts's undo() itself sets projectDirty — an
  // undo is still an unsaved change.)
  const depthBefore = await undoDepth(page);
  expect(depthBefore).toBeGreaterThanOrEqual(2); // box insert + note edits
  await page.keyboard.press('Control+z');
  await expect.poll(() => undoDepth(page)).toBe(depthBefore! - 1);
  await expect(projectBtn).toContainText('•');
});

test('a drilled parametric hole exports a ⌀ THRU callout in the drawing SVG', async ({ page }) => {
  await page.goto('/');
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  }, { timeout: 10_000 }).toBe(true);

  // The callout is derived from the feature TREE, so the body must be
  // parametric (the hole suite's flow): ground-plane sketch → rectangle (R)
  // → extrude. An inserted box would be a direct body whose in-place hole
  // has no feature — and no callout.
  const countEntities = (): Promise<number> =>
    page.evaluate(() =>
      Number(/Entities:\s*(\d+)/.exec(document.querySelector('footer[role=status]')?.textContent ?? '')?.[1] ?? -1),
    );
  const countObjects = (): Promise<number> =>
    page.evaluate(() => Number(/Objects:\s*(\d+)/.exec(document.body.textContent ?? '')?.[1] ?? -1));

  const vb = (await canvas.boundingBox())!;
  const cx = vb.x + vb.width / 2;
  const cy = vb.y + vb.height / 2;
  // All three 3×3 datum quads meet at the origin; 40px below centre hits the
  // GROUND diamond so the extrude runs along Y (and the hole drills down it).
  await page.mouse.click(cx, cy + 40);
  await expect.poll(countEntities, { timeout: 5_000 }).toBe(0);
  await page.waitForTimeout(300); // let the camera finish snapping normal-to

  await page.keyboard.press('r');
  await page.mouse.move(cx - 120, cy - 80);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 5 });
  await page.mouse.up();
  await expect.poll(countEntities).toBe(8);

  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Extrude' }).click();
  await expect.poll(countObjects, { timeout: 10_000 }).toBe(1);

  // Frame the body, then right-click it → Feature → Hole: ⌀2, depth 0
  // (through-all), placed dead-centre on the top face from an exact top view
  // (the hole suite's placement choreography).
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy, { button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const featureItem = menu.getByRole('menuitem', { name: /^Feature\b/ });
  await featureItem.hover();
  await featureItem.click();
  await page.getByRole('menuitem', { name: 'Hole', exact: true }).click();
  const input = page.locator('#numeric-prompt-input');
  await expect(input).toBeVisible();
  await input.fill('2');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.fill('0');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Click the body where the hole should start')).toBeVisible();
  await page.keyboard.press('2');
  await page.waitForTimeout(400); // let the view snap finish
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);

  // The hole landed as the third timeline chip (sketch → extrude → hole).
  const timeline = page.getByRole('toolbar', { name: 'Timeline' });
  await expect(timeline.locator('button[draggable]')).toHaveCount(3, { timeout: 10_000 });

  // D switches to the drawing workspace; the −Y hole's callout belongs to
  // the Top view (the only axis-on view of the four). Export the SVG and
  // read the downloaded file back.
  await page.keyboard.press('d');
  await expect(page.getByRole('img', { name: 'Drawing view' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export SVG' }).click(),
  ]);
  const path = await download.path();
  expect(path).not.toBeNull();
  const svg = await readFile(path!, 'utf-8');
  expect(svg).toContain('⌀');
  expect(svg).toContain('⌀2×THRU');
});
