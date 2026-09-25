import { test, expect, type Page } from '@playwright/test';

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
