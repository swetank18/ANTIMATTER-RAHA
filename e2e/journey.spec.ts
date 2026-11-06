import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const requests = async (page: Page) => {
  const ledger = await (await page.request.get('/api/ledger?limit=2000')).json();
  return ledger.filter((e: { type: string }) => e.type === 'RIDE_REQUEST').length;
};

async function settle(page: Page) {
  await page.goto('/#/rider');
  await page.waitForFunction(() => !!localStorage.getItem('pack'));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller || location.reload() === undefined);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForTimeout(800);
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/reset', { data: {} });
});

test('C01: the rider journey survives losing the internet in a real browser', async ({ page, context }) => {
  await settle(page);
  const before = await requests(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Is this fare fair?' })).toBeVisible();
  await expect(page.locator('#net')).toContainText('You are offline');
  await expect(page.getByText('Queued until you reconnect')).toBeVisible();

  await page.getByRole('button', { name: 'Check this fare' }).click();
  await expect(page.locator('#check-out')).toContainText('Using fares saved at');

  await page.getByRole('button', { name: 'Find my group' }).click();
  await expect(page.getByText('Waiting to send')).toBeVisible();

  await page.reload();
  await expect(page.getByText('Waiting to send')).toBeVisible();
  expect(await requests(page)).toBe(before);

  await context.setOffline(false);
  await expect(page.locator('#net')).toBeEmpty({ timeout: 10000 });
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await requests(page)).toBe(before + 1);

  await page.reload();
  await page.waitForTimeout(3000);
  expect(await requests(page)).toBe(before + 1);
});

test('C01: a hard outage from the Arena is shown the same way', async ({ page, request }) => {
  await settle(page);
  await request.post('/api/arena/offline', { data: { on: true } });
  await expect(page.locator('#net')).toContainText('You are offline', { timeout: 8000 });
  await request.post('/api/arena/offline', { data: { on: false } });
  await expect(page.locator('#net')).toBeEmpty({ timeout: 8000 });
});

// Behind a host's proxy a cut socket comes back as a 502, not a network error. A request sent in
// that moment must stay queued and arrive once, not be counted as sent and lost.
test('C01: a request sent as the outage starts is kept and arrives once', async ({ page, request }) => {
  await settle(page);
  const before = await requests(page);
  await request.post('/api/arena/offline', { data: { on: true } });
  await page.getByRole('button', { name: 'Find my group' }).click();
  await expect(page.getByText('Waiting to send')).toBeVisible();
  expect(await requests(page)).toBe(before);

  await request.post('/api/arena/offline', { data: { on: false } });
  await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(await requests(page)).toBe(before + 1);
  await page.waitForTimeout(3000);
  expect(await requests(page)).toBe(before + 1);
});

test('C06: keyboard only, no colour, no serious accessibility issues', async ({ page }) => {
  await settle(page);
  await page.goto('/#/rider?mode=keyboard');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'keyboard');

  const focusOn = async (name: string) => {
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((n) => document.activeElement?.textContent?.trim() === n, name)) return;
    }
    throw new Error(`Could not reach "${name}" by keyboard`);
  };
  await focusOn('Check this fare');
  await page.keyboard.press('Enter');
  await expect(page.locator('#check-out')).toContainText('cannot be checked against the legal cap');
  await focusOn('Find my group');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ride')).toBeFocused({ timeout: 10000 });
  const keyboardJourney = true;

  const audit = async (hash: string) => {
    await page.goto(hash);
    await page.waitForTimeout(600);
    await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
    return page.evaluate(async () => {
      const r = await (window as any).axe.run();
      return r.violations.filter((v: any) => ['serious', 'critical'].includes(v.impact)).map((v: any) => `${v.id}: ${v.nodes.length}`);
    });
  };
  const rider = await audit('/#/rider');
  const arena = await audit('/#/arena');
  const demo = await audit('/#/');
  console.log('serious issues', JSON.stringify({ rider, arena, demo }));
  writeFileSync('results/a11y.json', JSON.stringify({ keyboardJourney, seriousViolations: rider.length + arena.length + demo.length, pages: 3, details: { rider, arena, demo }, ranAt: new Date().toISOString() }, null, 2));
  expect([...rider, ...arena, ...demo]).toEqual([]);
});

test('A fare is read from a screenshot on the phone, even offline', async ({ page, context }) => {
  await settle(page);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 700;
    c.height = 300;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 700, 300);
    g.fillStyle = '#000';
    g.font = 'bold 44px Arial';
    g.fillText('Uber Go', 40, 90);
    g.fillText('Rs 437', 40, 170);
    g.font = '30px Arial';
    g.fillText('3 min away', 40, 240);
    return c.toDataURL('image/png').split(',')[1];
  });
  await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'yes', { timeout: 30000 });
  await context.setOffline(true);
  await page.locator('#shot').setInputFiles({ name: 'fare.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('#shot-out')).toContainText('Read Rs 437', { timeout: 30000 });
  await expect(page.locator('#amount')).toHaveValue('437');
});
