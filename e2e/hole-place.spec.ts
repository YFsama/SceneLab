import { test, expect, type Page } from '@playwright/test';

/**
 * Hole CLICK-TO-PLACE E2E (usability audit F2) — the reworked Feature → Hole
 * flow through the real UI: the two-step ⌀/depth prompt now ARMS a one-shot
 * placement (hint pill + crosshair), and the next left click on the body
 * drills at the clicked world point instead of the top-face centroid.
 *
 * Determinism: the box is framed in an exact TOP view ('2' then 'f'), where
 * the camera sits straight above the target — a pixel computed for a chosen
 * world point (via the viewport's own camera-request/response protocol)
 * projects onto exactly that (x, z) on the top face. The click target is
 * deliberately OFF-CENTRE with a ⌀12 hole: the hole straddles the box wall,
 * so the removed volume is a CLIPPED cylinder (≈80% of π·6²·20). A regression
 * back to centroid placement would remove the FULL cylinder — the bands below
 * separate the two cases without depending on exact pixel landing (±1 mm of
 * click slop stays inside them).
 *
 * Run with `--repeat-each=3` to check stability.
 */
test.beforeEach(({ page }) => {
  page.addInitScript(() => localStorage.setItem('scenelab.welcomeDismissed', 'true'));
});

async function awaitCanvas(page: Page) {
  const canvas = page.locator('#viewport-canvas');
  await expect(canvas).toBeAttached();
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box !== null && box.width > 100 && box.height > 100;
  }, { timeout: 10_000 }).toBe(true);
  return canvas;
}

async function countObjects(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = /Objects:\s*(\d+)/.exec(document.body.textContent ?? '');
    return m ? +m[1]! : -1;
  });
}

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

/**
 * Screen pixel for a world point, computed from the LIVE camera through the
 * viewport's own camera-request/response events (the ViewCube protocol) and
 * three.js's lookAt/perspective math (fov 50°, vertical).
 */
function screenPointFor(page: Page, world: { x: number; y: number; z: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((w) => new Promise<{ x: number; y: number }>((resolve) => {
    const onResp = (e: Event) => {
      window.removeEventListener('viewport-camera-response', onResp);
      const d = (e as CustomEvent).detail as {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        up: { x: number; y: number; z: number };
      };
      const canvas = document.getElementById('viewport-canvas')!;
      const r = canvas.getBoundingClientRect();
      const sub = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
      const norm = (a: { x: number; y: number; z: number }) => {
        const l = Math.hypot(a.x, a.y, a.z);
        return { x: a.x / l, y: a.y / l, z: a.z / l };
      };
      const cross = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
      const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
        a.x * b.x + a.y * b.y + a.z * b.z;
      // three-style camera basis: z points backward (pos − target).
      const zAxis = norm(sub(d.position, d.target));
      const xAxis = norm(cross(d.up, zAxis));
      const yAxis = cross(zAxis, xAxis);
      const v = sub(w, d.position);
      const xc = dot(v, xAxis);
      const yc = dot(v, yAxis);
      const zc = dot(v, zAxis); // negative for points in front of the camera
      const focal = 1 / Math.tan((50 * Math.PI) / 360);
      const ndcX = (xc / zc) * focal / (r.width / r.height);
      const ndcY = (yc / zc) * focal;
      resolve({ x: r.left + ((ndcX + 1) / 2) * r.width, y: r.top + ((1 - ndcY) / 2) * r.height });
    };
    window.addEventListener('viewport-camera-response', onResp);
    window.dispatchEvent(new CustomEvent('viewport-camera-request'));
  }), world);
}

test('hole click-to-place drills at the clicked point on a direct box', async ({ page }) => {
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

  // Exact top view + fit: the camera ends straight above the box's centre,
  // so computed pixels map 1:1 onto top-face (x, z) coordinates.
  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const center = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  const before = await selectAndReadVolume(page, center);
  expect(before).toBeGreaterThan(7000); // 20×20×20 = 8000 mm³

  // Feature → Hole: ⌀12 through-all, then the armed placement click. The
  // click target is world (7, ·, 1) — on the top face, 7 mm off centre, so
  // the ⌀12 hole straddles the x = +10 wall and removes a clipped cylinder.
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(menu).toBeVisible();
  const featureItem = menu.getByRole('menuitem', { name: /^Feature\b/ });
  await featureItem.hover();
  await featureItem.click();
  await page.getByRole('menuitem', { name: 'Hole', exact: true }).click();
  const input = page.locator('#numeric-prompt-input');
  await expect(input).toBeVisible();
  await input.fill('12');
  await input.press('Enter');
  await expect(input).toBeVisible();
  await input.fill('0');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // ARMED: the pick hint pill is visible before the click…
  const hint = page.getByText('Click the body where the hole should start');
  await expect(hint).toBeVisible();
  const target = await screenPointFor(page, { x: 7, y: 20, z: 1 });
  await page.mouse.click(target.x, target.y);
  // …and disarms once the hole is placed.
  await expect(hint).toHaveCount(0);

  // A direct body has no feature history: no timeline chip appears…
  await expect(page.locator('button[draggable]')).toHaveCount(0);
  // …the object count stays at one…
  expect(await countObjects(page)).toBe(1);
  // …and the volume dropped by the CLIPPED ⌀12 cylinder. Ideal (unclipped)
  // would be π·6²·20 ≈ 2262; the click-anchored hole removes ≈80% of that
  // (hole centre 3 mm inside the wall), while a centroid regression would
  // remove the full cylinder — the bands separate the two.
  const after = await selectAndReadVolume(page, center);
  const ideal = Math.PI * 6 * 6 * 20;
  const removed = before - after;
  expect(removed).toBeGreaterThan(ideal * 0.55);
  expect(removed).toBeLessThan(ideal * 0.95);

  // One Ctrl+Z restores the un-drilled box.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  const restored = await selectAndReadVolume(page, center);
  expect(Math.abs(restored - before)).toBeLessThan(0.5);
});

test('a miss keeps the placement armed; Escape cancels it', async ({ page }) => {
  await page.goto('/');
  await awaitCanvas(page);

  await page.locator('#viewport-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /insert/i }).first().hover();
  await menu.getByRole('menuitem', { name: /insert/i }).first().click();
  await page.getByRole('menuitem', { name: 'Box' }).click();
  await page.getByRole('dialog').press('Enter');
  await expect.poll(() => countObjects(page), { timeout: 10_000 }).toBe(1);

  await page.keyboard.press('2');
  await page.waitForTimeout(400);
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const vb = (await page.locator('#viewport-canvas').boundingBox())!;
  const center = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
  const before = await selectAndReadVolume(page, center);

  // Arm the placement (⌀4 through-all)…
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(menu).toBeVisible();
  const featureItem = menu.getByRole('menuitem', { name: /^Feature\b/ });
  await featureItem.hover();
  await featureItem.click();
  await page.getByRole('menuitem', { name: 'Hole', exact: true }).click();
  const input = page.locator('#numeric-prompt-input');
  await input.fill('4');
  await input.press('Enter');
  await input.fill('0');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const hint = page.getByText('Click the body where the hole should start');
  await expect(hint).toBeVisible();

  // …click EMPTY space (a corner of the viewport, well outside the framed
  // box): the needs-body toast appears and the placement stays armed…
  await page.mouse.click(vb.x + 30, vb.y + 30);
  await expect(page.getByText('Select a body first')).toBeVisible();
  await expect(hint).toBeVisible();

  // …then Escape cancels: the pill disappears and the volume is untouched.
  await page.keyboard.press('Escape');
  await expect(hint).toHaveCount(0);
  const after = await selectAndReadVolume(page, center);
  expect(Math.abs(after - before)).toBeLessThan(0.5);
});
