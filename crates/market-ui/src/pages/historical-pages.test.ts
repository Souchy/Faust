import { DI, Registration } from 'aurelia';
import { describe, expect, it, vi } from 'vitest';
import { MarketApi } from '../core/market-api';
import { latestHour, localInput } from '../core/historical';
import { MarketSession } from '../services/market-session';
import { ClientSettings } from '../services/client-settings';
import type { FlipPeriodSelection } from '../core/api-types';
import { analysisPeriod, arbitrageAnalysis, currentAvailability, flipAnalysis, flipSparklines, gggCoverage, gggHistory, gggJob, gggMarket, gggOverview } from '../testing/historical-fixtures';
import { CurrencyExchange } from './currency-exchange/currency-exchange';
import { FlipAnalysis } from './flip-analysis/flip-analysis';
import { TriangularArbitrage } from './triangular-arbitrage/triangular-arbitrage';

function workspace() {
  const api = new MarketApi('');
  vi.spyOn(api, 'analysisPeriod').mockImplementation(async (league) => analysisPeriod(league));
  vi.spyOn(api, 'leagueStart').mockImplementation(async (league) => ({ league, start: analysisPeriod(league).start, approximate: true }));
  const settings = new ClientSettings();
  vi.spyOn(settings, 'loadFlipPeriod').mockResolvedValue(null);
  vi.spyOn(settings, 'saveFlipPeriod').mockResolvedValue(undefined);
  vi.spyOn(api, 'flipSparklines').mockImplementation(async (_league, start, end, rows) => flipSparklines(rows, start, end));
  vi.spyOn(api, 'currentAvailability').mockImplementation(async (league, rows) => currentAvailability(league, rows));
  const container = DI.createContainer().register(Registration.instance(MarketApi, api), Registration.instance(ClientSettings, settings), Registration.singleton(MarketSession, MarketSession));
  const session = container.get(MarketSession);
  session.leagues = [{ id: 'standard', name: 'Standard' }];
  session.selectedLeagueId = 'standard';
  session.compareLeague = 'Standard';
  return { api, settings, container, session };
}
describe('Historical pages', () => {
  it('defaults Compare to None and does not request Flip data until a comparison is selected', async () => {
    const { api, container } = workspace();
    const empty = container.invoke(MarketSession);
    expect(empty.compareLeague).toBe('');
    const session = container.get(MarketSession);
    session.compareLeague = '';
    const flips = vi.spyOn(api, 'flips');
    const page = container.invoke(FlipAnalysis);
    await page.datasetChanged();
    await page.refresh();
    await page.analyze();
    expect(api.analysisPeriod).not.toHaveBeenCalled();
    expect(api.leagueStart).not.toHaveBeenCalled();
    expect(flips).not.toHaveBeenCalled();
    expect(page.canAnalyze).toBe(false);
    expect(page.periodLoading || page.isLoading).toBe(false);
    page.unbinding();
  });
  it('clearing Compare aborts in-flight ranking and cannot restore stale results', async () => {
    const { api, container, session } = workspace();
    let finish!: (result: ReturnType<typeof flipAnalysis>) => void;
    const flips = vi.spyOn(api, 'flips').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const page = container.invoke(FlipAnalysis);
    const pending = page.datasetChanged();
    await vi.waitFor(() => expect(flips).toHaveBeenCalledOnce());
    session.compareLeague = '';
    await page.datasetChanged();
    expect(flips.mock.calls[0]![4].aborted).toBe(true);
    finish(flipAnalysis());
    await pending;
    expect(page.result).toBeNull();
    expect(page.period).toBeNull();
    expect(page.referenceTime).toBeNull();
    expect(page.history).toBeNull();
    expect(page.canAnalyze).toBe(false);
    expect(page.periodLoading || page.isLoading || page.chartsLoading || page.currentAvailabilityLoading).toBe(false);
    page.unbinding();
  });
  it('clearing Compare during bounds loading prevents ranking and launch timers', async () => {
    vi.useFakeTimers();
    try {
      const { api, container, session } = workspace();
      let finish!: (period: ReturnType<typeof analysisPeriod>) => void;
      vi.mocked(api.analysisPeriod).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const flips = vi.spyOn(api, 'flips');
      const page = container.invoke(FlipAnalysis);
      const pending = page.datasetChanged();
      session.compareLeague = '';
      await page.datasetChanged();
      finish(analysisPeriod());
      await pending;
      expect(flips).not.toHaveBeenCalled();
      expect(page.period).toBeNull();
      expect(page.referenceTime).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      page.unbinding();
    } finally { vi.useRealTimers(); }
  });
  it('reranks the selected comparison against a changed target without changing Compare', async () => {
    const { api, container, session } = workspace();
    session.compareLeague = 'Mirage';
    const flips = vi.spyOn(api, 'flips').mockImplementation(async league => ({ ...flipAnalysis(), league }));
    const page = container.invoke(FlipAnalysis);
    await page.datasetChanged();
    page.presence = 'observed';
    session.leagues.push({ id: 'Other', name: 'Other league' });
    session.selectedLeagueId = 'Other';
    await page.datasetChanged();
    expect(session.compareLeague).toBe('Mirage');
    expect(flips.mock.calls.at(-1)?.[0]).toBe('Mirage');
    expect(flips.mock.calls.at(-1)?.[3].current_league).toBe('Other');
    expect(api.currentAvailability).toHaveBeenLastCalledWith('Other', expect.any(Array), expect.any(AbortSignal));
    page.unbinding();
  });
  it('projects exact current league age from launch rather than observation bounds and updates every minute', async () => {
    vi.useFakeTimers();
    try {
      const { api, container, session } = workspace();
      session.compareLeague = 'Mirage';
      const now = Date.parse('2026-11-14T18:00:00Z');
      vi.setSystemTime(now);
      const age = (2 * 24 + 5) * 3600;
      const historicalStart = analysisPeriod('Mirage').start! - 3600;
      vi.mocked(api.leagueStart).mockImplementation(async league => ({
        league, start: league === 'Standard' ? now / 1000 - age : historicalStart, approximate: false,
      }));
      vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
      const page = container.invoke(FlipAnalysis); await page.datasetChanged();
      expect(page.minimum).toBe(historicalStart);
      expect(page.referenceTime).toBe(historicalStart + age);
      expect(page.referenceLabel).toContain('2d 5h 0m');
      expect(page.referenceLabel).not.toContain('Approximate');
      const start = page.start, end = page.end;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(page.referenceTime).toBe(historicalStart + age + 60);
      expect([page.start, page.end]).toEqual([start, end]);
      page.unbinding();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('labels approximate launches and exposes missing metadata without preventing ranking', async () => {
    const { api, container, session } = workspace();
    session.compareLeague = 'Mirage';
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    expect(page.referenceLabel).toContain('(approx.)');
    expect(page.referenceLabel).not.toContain('earliest known dataset date');
    vi.mocked(api.leagueStart).mockRejectedValue(new Error('Official metadata HTTP 503'));
    await page.datasetChanged();
    expect(page.referenceTime).toBeNull();
    expect(page.referenceError).toContain('HTTP 503');
    expect(page.result).not.toBeNull();
    page.unbinding();
  });
  it('restores filters and zoom before the first ranking request and sends presence to the live league', async () => {
    const { api, container, session, settings } = workspace();
    session.compareLeague = 'Mirage';
    const bounds = analysisPeriod('Mirage');
    const saved: FlipPeriodSelection = {
      start: bounds.start!, end: bounds.end!,
      viewport: { start: bounds.start! + 1200.5, end: bounds.end! - 1200.5 },
      filters: { minPrice: '1', maxPrice: '500', minVolume: '20', minConfidence: 'Medium',
        strictStart: true, search: 'oil', category: 'Oil', venue: 'trade', sort: 'value-asc', presence: 'observed' },
    };
    vi.mocked(settings.loadFlipPeriod).mockResolvedValue(saved);
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    expect(page.viewport).toEqual(saved.viewport);
    expect(flips.mock.calls[0]?.[3]).toMatchObject({
      min_price: '1', max_price: '500', min_volume: '20', min_confidence: 'Medium', strict_start: 'true',
      search: 'oil', category: 'Oil', venue: 'trade', sort: 'value-asc', presence: 'observed', current_league: 'standard',
    });
    page.unbinding();
  });
  it('persists zoom and all filters on navigation without waiting for a debounce or mixing leagues', async () => {
    const { api, container, session, settings } = workspace();
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    page.search = 'Golden'; page.minPrice = '10'; page.presence = 'unknown';
    const viewport = { start: analysisPeriod().start! + 1200.5, end: analysisPeriod().end! - 1200.5 };
    page.commitViewport(viewport);
    session.compareLeague = 'Mirage'; await page.datasetChanged();
    await vi.waitFor(() => expect(settings.saveFlipPeriod).toHaveBeenCalled());
    expect(vi.mocked(settings.saveFlipPeriod).mock.calls[0]).toEqual([
      'Standard', expect.objectContaining({ viewport, filters: expect.objectContaining({ search: 'Golden', minPrice: '10', presence: 'unknown' }) }),
    ]);
    expect(page.search).toBe(''); expect(page.viewport).toBeNull(); expect(page.presence).toBe('');
    page.unbinding();
  });
  it('renders provider-relative current trends with gaps and negative samples without inventing prices', async () => {
    const { api, container } = workspace();
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.refresh();
    await vi.waitFor(() => expect(page.currentAvailabilityLoading).toBe(false));
    expect(page.currentTrends.divine?.paths).toHaveLength(2);
    expect(page.currentTrends.divine?.paths[1]).toContain('L');
    expect(page.currentAvailability.divine?.price).toBe('125.5');
    page.unbinding();
  });
  it('checks the retained live league separately from historical ranking, only for displayed rows', async () => {
    const { api, container, session } = workspace();
    session.compareLeague = 'Mirage';
    const result = { ...flipAnalysis(), league: 'Mirage' };
    vi.spyOn(api, 'flips').mockResolvedValue(result);
    let finish!: (value: ReturnType<typeof currentAvailability>) => void;
    vi.mocked(api.currentAvailability).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const page = container.invoke(FlipAnalysis); await page.refresh();
    expect(page.result).toBe(result); expect(page.isLoading).toBe(false);
    expect(page.currentAvailabilityLoading).toBe(true);
    expect(api.currentAvailability).toHaveBeenCalledOnce();
    expect(api.currentAvailability).toHaveBeenCalledWith('standard', result.rows, expect.any(AbortSignal));
    finish(currentAvailability('standard', result.rows));
    await vi.waitFor(() => expect(page.currentAvailabilityLoading).toBe(false));
    expect(page.currentAvailability.divine?.listings).toBeNull();
    expect(page.currentAvailability.oil?.listings).toBe(42);
    expect(page.snapshot()).not.toHaveProperty('currentAvailability');
    page.unbinding();
  });
  it.each(['search', 'filter', 'page', 'league', 'unbind'] as const)('cancels availability on %s and ignores late replies', async action => {
    const { api, container, session } = workspace();
    vi.spyOn(api, 'flips').mockImplementation(async league => ({ ...flipAnalysis(), league }));
    const finishes: (() => void)[] = [];
    vi.mocked(api.currentAvailability).mockImplementation((league, rows) => new Promise(resolve => {
      finishes.push(() => resolve(currentAvailability(league, rows)));
    }));
    const page = container.invoke(FlipAnalysis); await page.refresh();
    const signal = vi.mocked(api.currentAvailability).mock.calls[0]![2];
    if (action === 'search') page.searchChangedByUser();
    else if (action === 'filter') await page.refresh();
    else if (action === 'page') await page.changePage(1);
    else if (action === 'league') { session.compareLeague = 'Mirage'; await page.datasetChanged(); }
    else page.unbinding();
    expect(signal.aborted).toBe(true);
    finishes[0]!(); await Promise.resolve();
    expect(page.currentAvailability).toEqual({});
    page.unbinding();
    for (const finish of finishes.slice(1)) finish();
  });
  it('shows availability failures independently without hiding historical ranking', async () => {
    const { api, container } = workspace();
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis);
    vi.mocked(api.currentAvailability).mockRejectedValueOnce(new Error('HTTP 503'));
    await page.refresh();
    await vi.waitFor(() => expect(page.currentAvailabilityError).toContain('HTTP 503'));
    expect(page.result).not.toBeNull(); expect(page.error).toBe('');
    vi.mocked(api.currentAvailability).mockResolvedValueOnce({ league: 'standard', items: [] });
    await page.refresh();
    await vi.waitFor(() => expect(page.currentAvailabilityError).toContain('Missing current availability'));
    await page.refresh();
    await vi.waitFor(() => expect(page.currentAvailabilityError).toBe(''));
    page.unbinding();
  });
  it('uses provider confidence labels, never fabricated confidence or GGG zeroes', () => {
    const { container } = workspace();
    const page = container.invoke(FlipAnalysis);
    const [ggg, ninja] = flipAnalysis().rows;
    expect(page.confidence(ggg!)).toBe('—');
    expect(page.confidenceTitle(ggg!)).toContain('Not applicable');
    expect(page.confidence(ninja!)).toBe('High → Low');
    expect(page.confidence({ ...ninja!, start_confidence: null, end_confidence: undefined })).toBe('Unknown → Unknown');
    expect(page.confidence({ ...ninja!, start_confidence: '', end_confidence: 'Medium' })).toBe('Unknown → Medium');
  });
  it('publishes ranking before its separate displayed-row chart batch resolves', async () => {
    const { api, container } = workspace();
    const result = flipAnalysis();
    vi.spyOn(api, 'flips').mockResolvedValue(result);
    let finish!: (value: ReturnType<typeof flipSparklines>) => void;
    vi.mocked(api.flipSparklines).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const page = container.invoke(FlipAnalysis);
    await page.refresh();
    expect(page.result).toBe(result); expect(page.isLoading).toBe(false); expect(page.chartsLoading).toBe(true);
    expect(api.flipSparklines).toHaveBeenCalledWith(result.league, result.start, result.end, result.rows, expect.any(AbortSignal));
    finish(flipSparklines(result.rows)); await vi.waitFor(() => expect(page.chartsLoading).toBe(false));
    expect(page.charts.divine?.paths).toHaveLength(2);
    expect(page.snapshot()).not.toHaveProperty('charts');
    expect(page.snapshot()).not.toHaveProperty('chartRequest');
    page.unbinding();
  });
  it.each(['search', 'filter', 'page', 'league', 'unbind'] as const)('aborts charts on %s and ignores late replies', async (action) => {
    const { api, container, session } = workspace();
    vi.spyOn(api, 'flips').mockImplementation(async (league) => ({ ...flipAnalysis(), league }));
    const finishes: (() => void)[] = [];
    vi.mocked(api.flipSparklines).mockImplementation((_league, start, end, rows) => new Promise((resolve) => {
      finishes.push(() => resolve(flipSparklines(rows, start, end)));
    }));
    const page = container.invoke(FlipAnalysis);
    await page.refresh();
    const signal = vi.mocked(api.flipSparklines).mock.calls[0]![4];
    if (action === 'search') page.searchChangedByUser();
    else if (action === 'filter') { page.category = 'Oils'; await page.refresh(); }
    else if (action === 'page') await page.changePage(1);
    else if (action === 'league') { session.compareLeague = 'Mirage'; await page.datasetChanged(); }
    else page.unbinding();
    expect(signal.aborted).toBe(true);
    finishes[0]!(); await Promise.resolve();
    expect(page.charts).toEqual({});
    page.unbinding();
    for (const finish of finishes.slice(1)) finish();
    await Promise.resolve();
    expect(page.charts).toEqual({});
  });
  it('surfaces chart errors without removing ranking and rejects omitted or oversized series', async () => {
    const { api, container } = workspace();
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis);
    for (const response of [new Error('HTTP 503'), { series: [] }, {
      series: [{ id: 'divine', warnings: [], points: Array.from({ length: 61 }, () => ({ time: 0, price: '1' })) }],
    }]) {
      if (response instanceof Error) vi.mocked(api.flipSparklines).mockRejectedValueOnce(response);
      else vi.mocked(api.flipSparklines).mockResolvedValueOnce(response);
      await page.refresh();
      await vi.waitFor(() => expect(page.chartsLoading).toBe(false));
      expect(page.chartError).toContain('Historical charts unavailable');
      expect(page.rows).toHaveLength(2);
    }
    page.unbinding();
  });
  it('shows selected-pair endpoint item volumes and preserves unknown liquidity for ninja rows', () => {
    const { container } = workspace();
    const page = container.invoke(FlipAnalysis);
    const [exchange, ninja] = flipAnalysis().rows;
    exchange!.alternatives.unshift({ ...exchange!.alternatives[0]!, selected: false, start_volume: '99999', end_volume: '99999' });
    expect(page.volume(exchange!)).toBe('50 → 60');
    expect(page.volumeTitle(exchange!)).toContain('not the period total');
    expect(page.volume(ninja!)).toBe('Unknown');
    expect(page.volume({ ...ninja!, venue: 'exchange', alternatives: exchange!.alternatives })).toBe('Unknown');
    expect(page.volume({ ...exchange!, alternatives: [] })).toBe('Unknown');
  });
  it('formats flip decimals with the shared economy convention without changing API precision', () => {
    const { container } = workspace();
    const page = container.invoke(FlipAnalysis);
    page.result = flipAnalysis();
    page.result.rows[0]!.growth_percent = '8932.258064516129032258064516';
    expect(page.format(page.result.rows[0]!.growth_percent)).toBe('8 932,26');
    expect(page.format('94.23')).toBe('94,23');
    expect(page.format('0.000123456789')).toBe('0,0001235');
    expect(page.result.rows[0]!.growth_percent).toBe('8932.258064516129032258064516');
  });
  it('defaults to flexible starts and preserves strict-start requests and route state', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis);
    expect(page.strictStart).toBe(false);
    await page.refresh();
    expect(fetch.mock.calls.at(-1)![3]).not.toHaveProperty('strict_start');
    page.strictStart = true; page.offset = 100;
    await page.refresh();
    expect(fetch.mock.calls.at(-1)![3]).toMatchObject({ strict_start: 'true', offset: '0' });
    page.unbinding();
    const restored = container.invoke(FlipAnalysis);
    expect(restored.strictStart).toBe(true);
    restored.strictStart = false;
    await restored.refresh();
    expect(fetch.mock.calls.at(-1)![3]).not.toHaveProperty('strict_start');
  });
  it('sends minimum confidence globally and preserves it across navigation', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis);
    expect(page.minConfidence).toBe('');
    await page.refresh();
    expect(fetch.mock.calls.at(-1)![3]).not.toHaveProperty('min_confidence');
    page.minConfidence = 'Medium'; page.offset = 100;
    await page.refresh();
    expect(fetch.mock.calls.at(-1)![3]).toMatchObject({ min_confidence: 'Medium', offset: '0' });
    page.unbinding();
    const restored = container.invoke(FlipAnalysis);
    expect(restored.minConfidence).toBe('Medium');
    restored.minConfidence = '';
    await restored.refresh();
    expect(fetch.mock.calls.at(-1)![3]).not.toHaveProperty('min_confidence');
  });
  it('sends exact flip endpoints and server-side filters, preserves returned order and route state', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    vi.spyOn(api, 'gggHistory').mockResolvedValue(gggHistory());
    const page = container.invoke(FlipAnalysis);
    page.minPrice = '0'; page.maxPrice = '200'; page.minVolume = '50';
    await page.refresh();
    expect(fetch).toHaveBeenCalledWith('Standard', new Date(page.start).getTime() / 1000, new Date(page.end).getTime() / 1000,
      { min_price: '0', max_price: '200', min_volume: '50', offset: '0', limit: '100',
        sort: 'percent-desc', search: '', category: '', venue: '' }, expect.any(AbortSignal));
    expect(page.rows.map((r) => r.name)).toEqual(['Divine Orb', 'Golden Oil']);
    page.sort = 'value-desc'; expect(page.rows[0]?.name).toBe('Divine Orb');
    page.search = 'Divine'; page.toggle('divine');
    page.unbinding();
    const restored = container.invoke(FlipAnalysis);
    expect(restored.snapshot()).toEqual(page.snapshot());
    expect(restored.isLoading).toBe(false);
    restored.category = 'Oils'; expect(restored.rows).toHaveLength(2);
  });
  it('surfaces invalid min/max without an API request and clears old rows', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'flips');
    const page = container.invoke(FlipAnalysis);
    page.result = flipAnalysis(); page.minPrice = '20'; page.maxPrice = '10';
    await page.refresh();
    expect(page.error).toContain('must not exceed');
    expect(page.result).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it('aborts in-flight analysis on unbinding and never applies late results', async () => {
    const { api, container } = workspace();
    let finish!: (result: ReturnType<typeof flipAnalysis>) => void;
    const fetch = vi.spyOn(api, 'flips').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const page = container.invoke(FlipAnalysis);
    page.period = analysisPeriod(); page.periodLeague = 'Standard';
    page.start = localInput(page.period.start!); page.end = localInput(page.period.end!);
    const pending = page.refresh(); page.unbinding(); finish(flipAnalysis()); await pending;
    expect(fetch.mock.calls[0]?.[4].aborted).toBe(true);
    expect(page.result).toBeNull();
  });
  it('reads saved GGG hours without starting imports and preserves timeframe/search/history', async () => {
    const { api, container } = workspace();
    vi.spyOn(api, 'gggMarkets').mockResolvedValue(gggOverview());
    vi.spyOn(api, 'gggCoverage').mockResolvedValue(gggCoverage());
    vi.spyOn(api, 'gggImport').mockResolvedValue(null);
    vi.spyOn(api, 'gggHistory').mockResolvedValue(gggHistory());
    const start = vi.spyOn(api, 'startGggImport');
    const page = container.invoke(CurrencyExchange);
    await page.refresh(); await page.selectMarket(gggMarket());
    page.search = 'Divine'; page.unbinding();
    const restored = container.invoke(CurrencyExchange);
    expect(start).not.toHaveBeenCalled();
    expect(restored.snapshot()).toEqual(page.snapshot());
    expect(restored.segments).toHaveLength(2);
  });
  it('can cancel a running import even when draft range controls are invalid', async () => {
    const { api, container } = workspace();
    const cancel = vi.spyOn(api, 'cancelGggImport').mockResolvedValue(gggJob('cancelled'));
    const page = container.invoke(CurrencyExchange);
    page.start = 'invalid'; await page.importHours(true);
    expect(cancel).toHaveBeenCalled(); expect(page.job?.status).toBe('cancelled');
  });
  it('keeps background imports running when unbinding but cancels foreground reads', async () => {
    const { api, container } = workspace();
    const cancel = vi.spyOn(api, 'cancelGggImport');
    vi.spyOn(api, 'startGggImport').mockResolvedValue(gggJob());
    const page = container.invoke(CurrencyExchange);
    await page.importHours();
    page.unbinding();
    expect(cancel).not.toHaveBeenCalled(); expect(page.session.exchangeState?.job?.status).toBe('running');
  });
  it('shows arbitrage request errors, filters returns and restores data-only snapshots', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'arbitrage').mockRejectedValueOnce(new Error('HTTP 503')).mockResolvedValue(arbitrageAnalysis());
    const page = container.invoke(TriangularArbitrage);
    page.hour = localInput(latestHour()); await page.refresh();
    expect(page.error).toBe('HTTP 503'); expect(page.result).toBeNull();
    await page.refresh(); expect(fetch).toHaveBeenCalledTimes(2);
    page.minReturn = '6'; expect(page.loops).toHaveLength(0);
    page.minReturn = '-1'; expect(page.filterError).toContain('nonnegative');
    page.minReturn = '4'; page.toggle('loop'); page.unbinding();
    expect(container.invoke(TriangularArbitrage).snapshot()).toEqual(page.snapshot());
  });
  it('requests pages of 100 without appending or applying page-local filters', async () => {
    const { api, container } = workspace();
    const page = container.invoke(FlipAnalysis);
    const result = flipAnalysis();
    result.rows = Array.from({ length: 100 }, (_, i) => ({ ...result.rows[0]!, id: `row-${i}`, name: `Item ${i}` }));
    result.total = 250;
    const fetch = vi.spyOn(api, 'flips').mockImplementation(async (_league, _start, _end, filters) => ({ ...result, offset: Number(filters.offset) }));
    await page.refresh();
    expect(page.visibleRows).toHaveLength(100);
    expect(vi.mocked(api.flipSparklines).mock.calls.at(-1)?.[3]).toBe(page.result?.rows);
    expect(vi.mocked(api.flipSparklines).mock.calls.at(-1)?.[3]).toHaveLength(100);
    await page.changePage(1); expect(page.visibleRows).toHaveLength(100);
    expect(vi.mocked(api.flipSparklines).mock.calls.at(-1)?.[3]).toBe(page.result?.rows);
    expect(fetch.mock.calls.at(-1)?.[3].offset).toBe('100');
    page.search = 'Item 249'; page.category = 'Oils'; page.sort = 'value-asc';
    await page.refresh();
    expect(fetch.mock.calls.at(-1)?.[3]).toMatchObject({ offset: '0', search: 'Item 249', category: 'Oils', sort: 'value-asc' });
    expect(page.visibleRows).toHaveLength(100);
    expect(page.categories).toEqual(['Currency', 'Oils']);
  });
  it('loads ninja native supporting history with exact variant keys and no fabricated volumes', async () => {
    const { api, container } = workspace();
    const fetch = vi.spyOn(api, 'economyHistory').mockResolvedValue({ points: [], coverage: { start: null, end: null } });
    const page = container.invoke(FlipAnalysis);
    page.result = flipAnalysis();
    await page.inspect(page.result.rows[1]!);
    expect(fetch).toHaveBeenCalledWith('Standard', 'Oil', 'stash', 'golden-oil', '', expect.any(AbortSignal));
    expect(page.ninjaHistory?.points).toEqual([]);
    expect(page.history).toBeNull();
  });
  it('uses ninja supporting history for Exchange-category rows instead of requesting a GGG pair', async () => {
    const { api, container } = workspace();
    const ninja = vi.spyOn(api, 'economyHistory').mockResolvedValue({ points: [], coverage: { start: null, end: null } });
    const ggg = vi.spyOn(api, 'gggHistory');
    const page = container.invoke(FlipAnalysis); page.result = flipAnalysis();
    const row = { ...page.result.rows[1]!, venue: 'exchange' as const, history_source: 'exchange' };
    await page.inspect(row);
    expect(ninja).toHaveBeenCalled(); expect(ggg).not.toHaveBeenCalled();
  });
  it('resets to actual Mirage dates on league change, preserves same-league custom dates and bounds input requests', async () => {
    const { api, container, session } = workspace();
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    session.compareLeague = 'Mirage'; await page.datasetChanged();
    expect(page.start.slice(0, 7)).toBe('2026-03');
    const start = analysisPeriod('Mirage').start! + 3600, end = analysisPeriod('Mirage').end! - 3600;
    page.start = localInput(start); page.end = localInput(end); await page.refresh();
    page.unbinding();
    const restored = container.invoke(FlipAnalysis); await restored.datasetChanged(false);
    expect(restored.start).toBe(localInput(start)); expect(restored.end).toBe(localInput(end));
    restored.start = localInput(start - 10 * 86400); await restored.refresh();
    expect(restored.error).toBe('');
    expect(restored.start).toBe(localInput(analysisPeriod('Mirage').start!));
    expect(restored.end).toBe(localInput(end));
    expect(flips.mock.calls.at(-1)?.[1]).toBe(analysisPeriod('Mirage').start!);
  });
  it('restores a file-backed period with a fresh session and keeps league selections separate', async () => {
    const saved = new Map<string, { start: number; end: number }>();
    for (const league of ['Standard', 'Mirage']) {
      const { api, settings, container, session } = workspace();
      session.compareLeague = league;
      vi.mocked(settings.loadFlipPeriod).mockImplementation(async name => saved.get(name) ?? null);
      vi.mocked(settings.saveFlipPeriod).mockImplementation(async (name, period) => {
        saved.set(name, period);
      });
      vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
      const page = container.invoke(FlipAnalysis); await page.datasetChanged();
      page.start = localInput(analysisPeriod(league).start! + 3600);
      page.end = localInput(analysisPeriod(league).end! - 3600);
      await page.savePeriod();
      expect(saved.get(league)).toMatchObject({ start: analysisPeriod(league).start! + 3600, end: analysisPeriod(league).end! - 3600 });
      page.unbinding();
    }
    const { api, settings, container, session } = workspace();
    vi.mocked(settings.loadFlipPeriod).mockImplementation(async name => saved.get(name) ?? null);
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    expect(page.selectedStart).toBe(saved.get('Standard')!.start);
    expect(page.selectedEnd).toBe(saved.get('Standard')!.end);
    session.compareLeague = 'Mirage'; await page.datasetChanged();
    expect(flips.mock.calls.at(-1)?.slice(0, 3)).toEqual(['Mirage', saved.get('Mirage')!.start, saved.get('Mirage')!.end]);
    expect(settings.saveFlipPeriod).not.toHaveBeenCalled();
  });
  it('clamps restored timestamps to refreshed bounds and rejects malformed saved settings visibly', async () => {
    const { api, settings, container } = workspace();
    const bounds = analysisPeriod();
    vi.mocked(settings.loadFlipPeriod).mockResolvedValue({ start: bounds.start! - 3600, end: bounds.end! + 3600 });
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    expect(page.selectedStart).toBe(bounds.start); expect(page.selectedEnd).toBe(bounds.end);
    page.unbinding();
    const next = workspace();
    vi.mocked(next.settings.loadFlipPeriod).mockResolvedValue({ start: 5, end: 2 });
    vi.spyOn(next.api, 'flips').mockResolvedValue(flipAnalysis());
    const invalid = next.container.invoke(FlipAnalysis); await invalid.datasetChanged();
    expect(invalid.settingsError).toContain('invalid hour timestamps');
    expect(invalid.selectedStart).toBe(bounds.start); expect(invalid.selectedEnd).toBe(bounds.end);
    expect(next.settings.saveFlipPeriod).not.toHaveBeenCalled();
  });
  it('reports settings failures without hiding ranking and never saves invalid edits', async () => {
    const { api, settings, container } = workspace();
    vi.mocked(settings.loadFlipPeriod).mockRejectedValue(new Error('Cannot read settings'));
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    expect(page.settingsError).toContain('Cannot read settings'); expect(page.result).not.toBeNull();
    page.start = 'invalid'; await page.savePeriod();
    expect(settings.saveFlipPeriod).not.toHaveBeenCalled(); expect(page.settingsError).toContain('valid local date');
    page.start = localInput(analysisPeriod().start! + 3600);
    vi.mocked(settings.saveFlipPeriod).mockRejectedValueOnce(new Error('Disk is full'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await page.savePeriod();
      expect(page.settingsError).toContain('Disk is full'); expect(page.result).not.toBeNull();
      await page.savePeriod();
      expect(page.settingsError).toBe('');
    } finally { log.mockRestore(); }
  });
  it('serializes file writes across page instances and preserves exact band timestamps', async () => {
    const { api, settings, container } = workspace();
    vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    let finish!: () => void;
    vi.mocked(settings.saveFlipPeriod).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    const first = { start: analysisPeriod().start! + 3600, end: analysisPeriod().end! };
    page.commitPeriod(first);
    await vi.waitFor(() => expect(settings.saveFlipPeriod).toHaveBeenCalledOnce());
    page.unbinding();
    const next = container.invoke(FlipAnalysis);
    const second = { start: first.start + 3600, end: first.end - 3600 };
    next.start = localInput(second.start); next.end = localInput(second.end);
    const save = next.savePeriod();
    await Promise.resolve();
    expect(settings.saveFlipPeriod).toHaveBeenCalledOnce();
    finish(); await save;
    expect(vi.mocked(settings.saveFlipPeriod).mock.calls.map(call => call[1]))
      .toEqual(expect.arrayContaining([expect.objectContaining(first), expect.objectContaining(second)]));
  });
  it('reloads imported bounds on Analyze and clamps each endpoint while retaining filters', async () => {
    const { api, container } = workspace();
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    const before = analysisPeriod();
    const after = { ...before, start: before.start! + 22 * 3600, end: before.end! - 3600 };
    vi.mocked(api.analysisPeriod).mockResolvedValue(after);
    page.search = 'oil'; page.minVolume = ''; page.offset = 100;
    await page.analyze();
    expect(page.start).toBe(localInput(after.start));
    expect(page.end).toBe(localInput(after.end));
    expect(page.selectedStart).toBe(after.start); expect(page.selectedEnd).toBe(after.end);
    expect(page.search).toBe('oil'); expect(page.offset).toBe(0);
    expect(flips.mock.calls.at(-1)?.slice(1, 3)).toEqual([after.start, after.end]);
    page.start = '2026-02-31T00:00'; await page.analyze();
    expect(page.error).toContain('valid local date');
  });
  it('does not invent endpoints for unavailable periods and ignores stale league metadata', async () => {
    const { api, container, session } = workspace();
    let finish!: (period: ReturnType<typeof analysisPeriod>) => void;
    vi.mocked(api.analysisPeriod).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ ...analysisPeriod('Mirage'), start: null, end: null, hours: [], days: [], bounds_source: 'unavailable' });
    const flips = vi.spyOn(api, 'flips');
    const page = container.invoke(FlipAnalysis);
    const old = page.datasetChanged(); session.compareLeague = 'Mirage';
    await page.datasetChanged(); finish(analysisPeriod()); await old;
    expect(page.periodLeague).toBe('Mirage'); expect(page.canAnalyze).toBe(false);
    expect(page.start).toBe(''); expect(page.end).toBe(''); expect(flips).not.toHaveBeenCalled();
  });
  it('debounces search and resets the server offset', async () => {
    vi.useFakeTimers();
    try {
      const { api, container } = workspace();
      const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
      const page = container.invoke(FlipAnalysis); await page.datasetChanged(); page.offset = 100;
      page.search = 'Golden'; page.searchChangedByUser();
      await vi.advanceTimersByTimeAsync(200); expect(flips).toHaveBeenCalledTimes(1);
      page.search = 'Golden Oil'; page.searchChangedByUser(); await vi.advanceTimersByTimeAsync(250);
      expect(flips).toHaveBeenCalledTimes(2);
      expect(flips.mock.calls.at(-1)?.[3]).toMatchObject({ search: 'Golden Oil', offset: '0' });
      page.unbinding();
    } finally { vi.useRealTimers(); }
  });
  it('does not restore stale rows if navigation interrupts a debounced server filter', async () => {
    const { api, container } = workspace();
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis); await page.datasetChanged();
    page.search = 'Golden'; page.searchChangedByUser(); page.unbinding();
    const restored = container.invoke(FlipAnalysis);
    expect(restored.result).toBeNull(); await restored.datasetChanged(false);
    expect(flips.mock.calls.at(-1)?.[3].search).toBe('Golden');
  });
  it('retries failed period metadata on page refresh and restores bounded endpoints', async () => {
    const { api, container } = workspace();
    vi.mocked(api.analysisPeriod).mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValue(analysisPeriod());
    const flips = vi.spyOn(api, 'flips').mockResolvedValue(flipAnalysis());
    const page = container.invoke(FlipAnalysis);
    await page.datasetChanged();
    expect(page.canAnalyze).toBe(false); expect(page.periodLoading).toBe(false);
    expect(page.error).toBe('HTTP 502');
    await page.refresh();
    expect(api.analysisPeriod).toHaveBeenCalledTimes(2);
    expect(page.canAnalyze).toBe(true); expect(page.error).toBe('');
    expect(page.start).toBe(localInput(analysisPeriod().start!));
    expect(page.end).toBe(localInput(analysisPeriod().end!)); expect(flips).toHaveBeenCalledOnce();
  });
  it('stops active import polling on unbinding without cancelling the background job', async () => {
    vi.useFakeTimers();
    const { api, container } = workspace();
    vi.spyOn(api, 'gggMarkets').mockResolvedValue(gggOverview());
    vi.spyOn(api, 'gggCoverage').mockResolvedValue(gggCoverage());
    const poll = vi.spyOn(api, 'gggImport').mockResolvedValue(null);
    vi.spyOn(api, 'startGggImport').mockResolvedValue(gggJob());
    const cancel = vi.spyOn(api, 'cancelGggImport');
    const page = container.invoke(CurrencyExchange);
    try {
      page.attached();
      await vi.advanceTimersByTimeAsync(0);
      await page.importHours();
      const calls = poll.mock.calls.length;
      page.unbinding();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(poll).toHaveBeenCalledTimes(calls);
      expect(cancel).not.toHaveBeenCalled();
    } finally { page.unbinding(); vi.useRealTimers(); }
  });
  it('adds a completed custom GGG import to shared datasets without changing the selected league', async () => {
    vi.useFakeTimers();
    const { api, container, session } = workspace();
    vi.spyOn(api, 'gggMarkets').mockResolvedValue(gggOverview());
    vi.spyOn(api, 'gggCoverage').mockResolvedValue(gggCoverage());
    const poll = vi.spyOn(api, 'gggImport').mockResolvedValue(null);
    vi.spyOn(api, 'startGggImport').mockResolvedValue({ ...gggJob(), league: 'Retained League' });
    const datasets = [{ id: 'Retained League', name: 'Retained League', live: false, archived: false }];
    const catalog = vi.spyOn(api, 'economyLeagues').mockResolvedValue(datasets);
    const page = container.invoke(CurrencyExchange);
    try {
      page.attached();
      await vi.advanceTimersByTimeAsync(0);
      page.customLeague = 'Retained League';
      await page.importHours();
      expect(catalog).not.toHaveBeenCalled();
      poll.mockResolvedValue({ ...gggJob('completed'), league: 'Retained League' });
      await vi.advanceTimersByTimeAsync(1500);
      expect(catalog).toHaveBeenCalledTimes(1);
      expect(session.datasets).toEqual(datasets);
      expect(session.archivedDatasets).toEqual(datasets);
      expect(session.selectedDataset).toBe('standard');
      await session.selectDataset('archive:Retained League');
      expect(session.selectedLeagueName).toBe('Retained League');
    } finally { page.unbinding(); vi.useRealTimers(); }
  });
});
