import { test, expect, type Page } from '@playwright/test';
async function go(page: Page, name: string) {
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
}
test.beforeEach(async ({ page }) => { await page.goto('/'); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await page.reload(); await expect(page.getByRole('heading', { name: 'Hello, Ravi' })).toBeVisible(); });
test('device navigation and all operational screens stay within viewport', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.screenshot({ path: `test-results/haya-${info.project.name}.png`, fullPage: true });
  for (const name of ['Projects', 'Work checklist', 'Daily reports', 'Attendance', 'Resources', 'Quality & defects', 'Progress reports']) {
    await go(page, name); await expect(page.locator('main h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('combobox', { name: 'Demo role' }).selectOption('owner');
  for (const name of ['Review & approvals', 'People & access', 'Site template', 'Activity & audit', 'Client handover']) { await go(page, name); await expect(page.locator('main h1')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
  expect(errors).toEqual([]);
});
test('work submission, independent approval and persisted state', async ({ page }) => {
  await go(page, 'Work checklist');
  await page.getByRole('button', { name: 'Update', exact: true }).last().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Update work' })).toBeVisible();
  await dialog.getByLabel('4. Newly completed quantity', { exact: false }).fill('4');
  await dialog.getByLabel('5. Work notes').fill('Four module alignment units measured against the drawing.');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'site-evidence.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yC1sAAAAASUVORK5CYII=', 'base64') });
  await expect(dialog.locator('.photo-link img')).toBeVisible();
  await dialog.getByRole('button', { name: 'Submit for review' }).click();
  await expect(dialog).not.toBeVisible();
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('haya-demo-v1')!).ledger.length);
  await page.getByRole('combobox', { name: 'Demo role' }).selectOption('manager');
  await go(page, 'Review & approvals');
  const card = page.locator('.card').filter({ hasText: 'Four module alignment units' });
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card).not.toBeVisible();
  await page.reload();
  const result = await page.evaluate(() => { const data = JSON.parse(localStorage.getItem('haya-demo-v1')!); return { ledger: data.ledger.length, quality: data.ledger.filter((l: { type: string }) => l.type === 'Quality').length, work: data.work[0].status }; });
  expect(result).toEqual({ ledger: before + 1, quality: 0, work: 'Approved' });
});
test('drafts survive reload, daily report is submitted and client records stay private', async ({ page }) => {
  await page.getByRole('button', { name: 'Daily report Bring the day together', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('What happened today?').fill('Completed foundation works and checked material receipts.');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Daily report Bring the day together', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('What happened today?')).toHaveValue('Completed foundation works and checked material receipts.');
  await dialog.getByLabel('Labour headcount').fill('12');
  await dialog.getByLabel('Tomorrow’s plan').fill('Continue installation after independent verification.');
  await dialog.getByRole('button', { name: 'Submit report' }).click(); await expect(dialog).not.toBeVisible();
  await page.getByRole('combobox', { name: 'Demo role' }).selectOption('client');
  await expect(page.locator('.sidebar').getByRole('button', { name: 'People & access', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Attendance', exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar').getByRole('button', { name: 'Review & approvals', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Update work', exact: true })).toHaveCount(0);
});
