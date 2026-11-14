import { expect, test } from '@playwright/test';
import { economyCategories, economyLine, economyOverview, status } from '../src/testing/fixtures';

test('GGG current prices share the list/detail UI, preserve gaps, align launch ages, and retain latest price', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const launch = Date.parse('2026-07-24T18:00:00Z') / 1000;
  const current = Date.parse('2026-11-06T19:00:00Z') / 1000;
  let ninjaRequests = 0;
  const line = economyLine({ id: 'oil', name: 'Golden Oil', price: '90', volume: '12', pair: 'Chaos Orb', pair_rate: '90', sparkline: [] });
  const unavailable = economyLine({ id: 'missing', name: 'Silver Oil', price: null, volume: null, sparkline: [] });
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith('/economy/categories')) return route.fulfill({ json: economyCategories() });
    if (path.endsWith('/economy/leagues')) return route.fulfill({ json: [
      { id: 'Standard', name: 'Standard', live: true }, { id: 'Ancestors', name: 'Ancestors', live: true, archived: true },
    ] });
    if (path.endsWith('/economy/archives')) return route.fulfill({ json: [] });
    if (path === '/api/v1/leagues') return route.fulfill({ json: [{ id: 'Standard', name: 'Standard' }] });
    if (path.endsWith('/status')) return route.fulfill({ json: status() });
    if (path.endsWith('/selection')) return route.fulfill({ json: { id: 'Standard', name: 'Standard' } });
    if (path === '/api/v1/ggg/prices') {
      const historical = url.searchParams.get('league') === 'Ancestors';
      const overview = { ...economyOverview(), league: historical ? 'Ancestors' : 'Standard', source: 'ggg',
        fetched_at: '2026-07-24T22:00:00Z', lines: [line, unavailable] };
      return route.fulfill({ json: { overview, launch, current_launch: current, current_league: 'Standard',
        warnings: [], collection: { status: 'running', completed_hours: 5, total_hours: 8 },
        trends: { oil: {
          selected: [0, 3600, 7200, 10800, 14400].map((age, index) => ({ time: launch + age, price: index === 2 ? null : `${10 + index}`, volume: '12', granularity: 'hourly' })),
          current: historical ? [0, 3600, 7200].map(age => ({ time: current + age, price: '100', volume: '100', granularity: 'hourly' })) : [],
        } },
      } });
    }
    if (path.includes('/economy/')) {
      ninjaRequests++;
      if (path.endsWith('/dates')) return route.fulfill({ json: [] });
      return route.fulfill({ json: economyOverview() });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  await page.goto('/#/prices');
  await expect(page.getByRole('button', { name: 'GGG Exchange', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.economy-table')).toContainText('Golden Oil');
  await expect(page.locator('.economy-table')).toContainText('item units/hour');
  await expect(page.getByRole('status')).toContainText('5 / 8 hours downloaded');
  await expect(page.locator('.economy-table tbody tr').filter({ hasText: 'Silver Oil' }).locator('.price-cell')).toContainText('-');
  await page.getByRole('combobox', { name: 'League', exact: true }).selectOption('archive:Ancestors');
  await expect(page.locator('.comparison-legend')).toContainText('Aligned by league age');
  await expect(page.locator('.ggg-trend .current-comparison-line').first()).toHaveAttribute('d', /^M/);
  await page.getByRole('button', { name: 'Golden Oil', exact: true }).click();
  await expect(page.locator('.history-plot .current-comparison-line')).toHaveAttribute('d', /^M/);
  await expect(page.locator('.history-plot .current-comparison-line')).toHaveCSS('stroke', 'rgb(244, 162, 97)');
  await expect(page.locator('.history-plot .current-comparison-dots')).toHaveCSS('fill', 'rgb(244, 162, 97)');
  await expect(page.locator('.history-volume .current-comparison-volume')).toHaveAttribute('d', /^M/);
  await expect(page.locator('.history-day-axis')).toContainText('Day 1');
  await expect(page.locator('.detail-value')).toContainText('90');
  await page.getByRole('slider', { name: 'Period start', exact: true }).press('ArrowRight');
  await expect(page.locator('.detail-value')).toContainText('90');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole('article', { name: 'Item details' })).toBeVisible();
  expect(ninjaRequests).toBe(0);
  expect(errors).toEqual([]);
});
