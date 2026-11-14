import { resolve } from 'aurelia';
import type { EconomyLeague, FlipPeriodSelection, LeagueOption } from '../core/api-types';
import { MarketApi } from '../core/market-api';
import { ClientSettings } from './client-settings';
import type { CurrentPrices } from '../pages/current-prices/current-prices';
import type { GemFlipping } from '../pages/gem-flipping/gem-flipping';
import type { SettingsPage } from '../pages/settings/settings-page';
import type { CurrencyExchange } from '../pages/currency-exchange/currency-exchange';
import type { FlipAnalysis } from '../pages/flip-analysis/flip-analysis';
import type { TriangularArbitrage } from '../pages/triangular-arbitrage/triangular-arbitrage';

export type MarketPage = 'prices' | 'gems' | 'settings' | 'exchange' | 'flips' | 'triangular-arbitrage';

export class MarketSession {
  private readonly api = resolve(MarketApi);
  private readonly clientSettings = resolve(ClientSettings);
  private request: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private periodSave: Promise<void> = Promise.resolve();
  private compareSave: Promise<void> = Promise.resolve();
  private compareRevision = 0;
  private compareRestored = false;
  leagues: LeagueOption[] = [];
  datasets: EconomyLeague[] = [];
  selectedLeagueId = '';
  compareLeague = '';
  historicalLeague = '';
  historicalDate = '';
  page: MarketPage = 'prices';
  error = '';
  compareError = '';
  prices: CurrentPrices | null = null;
  gems: GemFlipping | null = null;
  settings: SettingsPage | null = null;
  priceState: ReturnType<CurrentPrices['snapshot']> | null = null;
  gemState: ReturnType<GemFlipping['snapshot']> | null = null;
  gemRevision = 0;
  exchange: CurrencyExchange | null = null;
  flips: FlipAnalysis | null = null;
  triangularArbitrage: TriangularArbitrage | null = null;
  exchangeState: ReturnType<CurrencyExchange['snapshot']> | null = null;
  flipState: ReturnType<FlipAnalysis['snapshot']> | null = null;
  triangularArbitrageState: ReturnType<TriangularArbitrage['snapshot']> | null = null;

  get selectedDataset(): string {
    return this.historicalLeague ? `archive:${this.historicalLeague}` : this.selectedLeagueId;
  }

  selectCompareLeague(league: string): Promise<void> {
    this.compareRevision++;
    this.compareRestored = true;
    this.compareLeague = league;
    this.compareError = '';
    const revision = this.compareRevision;
    const save = this.compareSave.then(() => this.clientSettings.saveCompareLeague(league));
    this.compareSave = save.catch((error: unknown) => {
      if (revision === this.compareRevision) {
        this.compareError = `Unable to save Compare selection: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    return this.compareSave;
  }

  saveFlipPeriod(league: string, period: FlipPeriodSelection): Promise<void> {
    const save = this.periodSave.then(async () => {
      await this.clientSettings.saveFlipPeriod(league, period);
    });
    this.periodSave = save.catch((error: unknown) => {
      console.error('Unable to persist Fliper period', error);
    });
    return save;
  }

  async loadFlipPeriod(league: string, signal: AbortSignal): Promise<FlipPeriodSelection | null> {
    await this.periodSave;
    signal.throwIfAborted();
    return this.clientSettings.loadFlipPeriod(league);
  }

  get archivedDatasets(): EconomyLeague[] {
    return this.datasets.filter((entry) => entry.archived || !entry.live);
  }

  get selectedLeagueName(): string {
    return this.historicalLeague
      || this.leagues.find((league) => league.id === this.selectedLeagueId)?.name
      || 'the selected league';
  }

  get targetLeagueName(): string {
    return this.historicalLeague || this.leagues.find(league => league.id === this.selectedLeagueId)?.name || '';
  }

  ensureLoaded(): Promise<void> {
    return this.pending ?? (this.selectedLeagueId ? Promise.resolve() : this.load());
  }

  async selectDataset(value: string): Promise<void> {
    if (value.startsWith('archive:')) {
      this.cancelRequest();
      this.historicalLeague = value.slice(8);
    } else {
      this.historicalLeague = '';
      this.historicalDate = '';
      await this.load(value);
    }
  }

  async refreshGemSnapshot(signal: AbortSignal): Promise<void> {
    await this.api.refreshGemAnalysis(this.selectedLeagueId, signal);
    if (!signal.aborted) this.gemRevision++;
  }

  load(preferredLeague = this.selectedLeagueId): Promise<void> {
    const pending = this.loadSelection(preferredLeague);
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = null; });
    return pending;
  }

  cancelRequest(): void {
    this.request?.abort();
    this.request = null;
  }

  private async loadSelection(preferredLeague: string): Promise<void> {
    this.cancelRequest();
    const request = new AbortController();
    this.request = request;
    this.error = '';
    const timeout = setTimeout(() => request.abort(new Error('Market service request timed out.')), 60_000);
    const revision = this.compareRevision;
    try {
      const [leagues, status, datasets, comparison] = await Promise.all([
        this.api.leagues(request.signal), this.api.status(request.signal), this.api.economyLeagues(request.signal),
        this.compareRestored ? Promise.resolve(null) : this.clientSettings.loadCompareLeague().catch((error: unknown) => {
          if (this.request === request && revision === this.compareRevision) {
            this.compareError = `Unable to restore Compare selection: ${error instanceof Error ? error.message : String(error)}`;
          }
          return null;
        }),
      ]);
      if (this.request !== request) return;
      this.leagues = leagues;
      this.datasets = datasets;
      if (comparison !== null && revision === this.compareRevision) {
        this.compareRestored = true;
        if (comparison && !this.archivedDatasets.some(dataset => dataset.id === comparison)) {
          this.compareError = `Saved Compare league "${comparison}" is unavailable. Import it or select another league.`;
        } else {
          this.compareLeague = comparison;
          this.compareError = '';
        }
      }
      this.selectedLeagueId = leagues.find((league) => league.id === preferredLeague)?.id
        ?? leagues.find((league) => league.id === status.selected_league)?.id
        ?? leagues[0]?.id ?? '';
      if (!this.selectedLeagueId) {
        this.error = 'The market service returned no available leagues.';
        return;
      }
      if (status.selected_league !== this.selectedLeagueId) {
        await this.api.selectLeague(this.selectedLeagueId, request.signal);
      }
    } catch (error: unknown) {
      if (this.request !== request) return;
      request.abort();
      this.error = `Unable to load market data: ${error instanceof Error ? error.message : String(error)}. Check that the external market service is running and reachable.`;
    } finally {
      clearTimeout(timeout);
    }
  }
}
