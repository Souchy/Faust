import { expect, test } from '@playwright/test';
import { economyArchive, status } from '../src/testing/fixtures';

test('production exposes only public tabs and redirects development routes, including aliases', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === '/api/v1/leagues') return route.fulfill({ json: [{ id: 'Standard', name: 'Standard' }] });
    if (path.endsWith('/status')) return route.fulfill({ json: status() });
    if (path.endsWith('/selection')) return route.fulfill({ json: { id: 'Standard', name: 'Standard' } });
    if (path.endsWith('/economy/leagues')) return route.fulfill({ json: [
      { id: 'Ancestors', name: 'Ancestors', live: false, archived: true },
    ] });
    if (path.endsWith('/analysis/league-start')) return route.fulfill({ json: {
      league: url.searchParams.get('league'), start: null, approximate: true,
    } });
    if (path.endsWith('/analysis/period')) return route.fulfill({ json: {
      league: url.searchParams.get('league'), start: null, end: null, hours: [], days: [], bounds_source: null, warnings: [],
    } });
    if (path.endsWith('/economy/archives')) return route.fulfill({ json: [economyArchive('Ancestors', 'completed')] });
    if (path.endsWith('/ggg/import')) return route.fulfill({ json: null });
    throw new Error(`Unexpected production API request: ${path}`);
  });
  for (const path of ['', 'prices', 'exchange', 'triangular-arbitrage', 'arbitrage']) {
    await page.goto(`/#/${path}`);
    await expect(page.getByRole('navigation', { name: 'Market pages' }).getByRole('button')).toHaveText([
      'Fliper', 'Gem flipping',
    ]);
    await expect(page.locator('flip-analysis')).toBeVisible();
    await expect(page.locator('current-prices, currency-exchange, triangular-arbitrage')).toHaveCount(0);
    await expect(page.locator('.dev-only-tab')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Compare league', exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Import leagues', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Browse Ancestors', exact: true }).click();
  await expect(page.locator('flip-analysis')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Target league', exact: true })).toHaveValue('Standard');
  await expect(page.getByRole('combobox', { name: 'Compare league', exact: true })).toHaveValue('Ancestors');
  expect(errors).toEqual([]);
});
