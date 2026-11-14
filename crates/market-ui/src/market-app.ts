import { resolve } from 'aurelia';
import { IRouter, type IRouteConfig } from '@aurelia/router';
import type { EconomyArchive } from './core/api-types';
import { MarketSession } from './services/market-session';
import { CurrentPrices } from './pages/current-prices/current-prices';
import { GemFlipping } from './pages/gem-flipping/gem-flipping';
import { SettingsPage } from './pages/settings/settings-page';
import { CurrencyExchange } from './pages/currency-exchange/currency-exchange';
import { FlipAnalysis } from './pages/flip-analysis/flip-analysis';
import { TriangularArbitrage } from './pages/triangular-arbitrage/triangular-arbitrage';

export class MarketApp {
  readonly devMode = import.meta.env.DEV;
  readonly router = resolve(IRouter);
  readonly session = resolve(MarketSession);
  get prices(): CurrentPrices | null { return this.session.prices; }
  get gems(): GemFlipping | null { return this.session.gems; }
  get settings(): SettingsPage | null { return this.session.settings; }
  get error(): string { return this.gems?.error || this.session.error; }

  getRouteConfig(): IRouteConfig {
    return {
      title: 'Faust',
      routes: [
        { path: '', redirectTo: this.devMode ? 'prices' : 'flips' },
        ...(this.devMode ? [
          { path: 'prices', component: CurrentPrices, title: 'Current prices' },
          { path: 'exchange', component: CurrencyExchange, title: 'Currency Exchange' },
          { path: ['triangular-arbitrage', 'arbitrage'], component: TriangularArbitrage, title: 'Triangular arbitrage' },
        ] : [
          { path: ['prices', 'exchange', 'triangular-arbitrage', 'arbitrage'], redirectTo: 'flips' },
        ]),
        { path: 'gems', component: GemFlipping, title: 'Gem flipping' },
        { path: 'flips', component: FlipAnalysis, title: 'Fliper' },
        { path: 'settings', component: SettingsPage, title: 'Settings' },
      ],
    };
  }

  attached(): void {
    void this.session.ensureLoaded();
  }

  unbinding(): void {
    this.session.cancelRequest();
  }

  get asOfDates(): string[] {
    return (this.session.page === 'gems' ? this.gems?.historicalDates : this.prices?.dates) ?? [];
  }

  get isLoading(): boolean {
    return this.gems?.isLoading || this.prices?.isLoading || this.settings?.isLoading
      || this.session.exchange?.isLoading || this.session.flips?.isLoading || this.session.flips?.periodLoading || this.session.triangularArbitrage?.isLoading || false;
  }

  async selectAsOfDate(date: string): Promise<void> {
    this.session.historicalDate = date;
    if (this.prices) this.prices.selectDate(date);
    else await this.gems?.loadHistoricalGems();
  }

  async selectDataset(value: string): Promise<void> {
    if (value !== this.session.selectedDataset) {
      this.session.historicalDate = '';
      this.prices?.clearFilters();
      this.prices?.closeDetail();
    }

    if (this.gems) await this.gems.selectDataset(value);
    else await this.session.selectDataset(value);
    if (this.prices) await this.prices.load();
    if (this.session.exchange) await this.session.exchange.datasetChanged();
    if (this.session.flips) await this.session.flips.datasetChanged();
    if (this.session.triangularArbitrage) await this.session.triangularArbitrage.refresh();
  }

  async selectCompareLeague(league: string): Promise<void> {
    const saving = this.session.selectCompareLeague(league);
    if (this.session.flips) await this.session.flips.datasetChanged();
    if (this.prices) await this.prices.load();
    await saving;
  }

  async refresh(): Promise<void> {
    if (this.settings) await this.settings.refresh();
    else if (this.gems) await this.gems.refresh();
    else if (this.session.exchange) await this.session.exchange.refresh();
    else if (this.session.flips) await this.session.flips.datasetChanged();
    else if (this.session.triangularArbitrage) await this.session.triangularArbitrage.refresh();
    else await this.prices?.refresh();
  }

  async browseArchive(archive: EconomyArchive): Promise<void> {
    await this.selectCompareLeague(archive.league ?? archive.name);
    await this.router.load('/flips');
  }
}
