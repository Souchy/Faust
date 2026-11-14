import { resolve } from 'aurelia';
import type { AnalysisPeriod, CurrentItemAvailability, EconomyHistory, FlipAnalysis as FlipAnalysisResult, FlipFilters, FlipPeriodSelection, FlipRow, FlipViewport, GggHistory, LeagueStart } from '../../core/api-types';
import { MarketApi } from '../../core/market-api';
import { formatNumber, sparkSegments } from '../../core/economy';
import { flipSparkline, type FlipSparklineView } from '../../core/flip-sparkline';
import { decimal, latestHour, localInput, localDate, nativeRatioLabel, priceSegments } from '../../core/historical';
import { observationPoints } from '../../components/period-band/period-band';
import { MarketSession } from '../../services/market-session';

export class FlipAnalysis {
  private readonly api = resolve(MarketApi);
  readonly session = resolve(MarketSession);
  get compareLeague(): string { return this.session.compareLeague; }
  async selectCompareLeague(league: string): Promise<void> {
    const saving = this.session.selectCompareLeague(league);
    await this.datasetChanged();
    await saving;
  }
  requestImports(event: Event): void {
    (event.currentTarget as HTMLElement).dispatchEvent(new CustomEvent('open-imports', { bubbles: true }));
  }
  private request: AbortController | null = null;
  private detailRequest: AbortController | null = null;
  private periodRequest: AbortController | null = null;
  private chartRequest: AbortController | null = null;
  private availabilityRequest: AbortController | null = null;
  private referenceRequest: AbortController | null = null;
  private referenceTimer: ReturnType<typeof setInterval> | null = null;
  private currentLaunch: LeagueStart | null = null;
  private selectedLaunch: LeagueStart | null = null;
  referenceTime: number | null = null;
  referenceLabel = '';
  referenceError = '';
  private updateReference(): void {
    const current = this.currentLaunch, selected = this.selectedLaunch;
    this.referenceTime = null; this.referenceLabel = '';
    if (current?.start == null || selected?.start == null) return;
    const age = Date.now() / 1000 - current.start;
    if (age < 0) { this.referenceLabel = 'Current league has not started yet.'; return; }
    this.referenceTime = selected.start + age;
    const days = Math.floor(age / 86400), hours = Math.floor(age % 86400 / 3600);
    const minutes = Math.floor(age % 3600 / 60);
    const approximate = current.approximate || selected.approximate;
    this.referenceLabel = `${this.currentLeagueName}: ${days}d ${hours}h ${minutes}m → ${localDate(this.referenceTime)}${approximate ? ' (approx.)' : ''}`;
    if (this.referenceTime < this.minimum || this.referenceTime > this.maximum) {
      this.referenceLabel += ' (outside available period)';
    }
  }
  private async loadReference(): Promise<void> {
    this.referenceRequest?.abort();
    if (this.referenceTimer) clearInterval(this.referenceTimer);
    this.referenceTimer = null;
    this.currentLaunch = null; this.selectedLaunch = null;
    this.referenceTime = null; this.referenceLabel = ''; this.referenceError = '';
    const current = this.currentLeagueName, selected = this.compareLeague;
    if (!current) { this.referenceError = 'Current league equivalent unavailable: select a live league.'; return; }
    const request = this.referenceRequest = new AbortController();
    try {
      const currentPromise = this.api.leagueStart(current, request.signal);
      const [currentLaunch, selectedLaunch] = await Promise.all([
        currentPromise, current === selected ? currentPromise : this.api.leagueStart(selected, request.signal),
      ]);
      if (request.signal.aborted || current !== this.currentLeagueName || selected !== this.compareLeague) return;
      if (currentLaunch.league !== current || selectedLaunch.league !== selected) throw new Error('Launch metadata belongs to a different league.');
      if (currentLaunch.start == null || selectedLaunch.start == null) throw new Error('No official launch or saved dataset start is available.');
      this.currentLaunch = currentLaunch; this.selectedLaunch = selectedLaunch;
      this.updateReference();
      this.referenceTimer = setInterval(() => this.updateReference(), 60_000);
    } catch (error) {
      if (!request.signal.aborted) this.referenceError = `Current league equivalent unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSettings: { league: string; settings: FlipPeriodSelection } | null = null;
  private active = false;
  private loadedLeague = '';
  start = '';
  end = '';
  selectedStart = 0;
  selectedEnd = 0;
  startPicker?: HTMLInputElement;
  endPicker?: HTMLInputElement;
  period: AnalysisPeriod | null = null;
  periodLeague = '';
  periodLoading = false;
  minPrice = '';
  maxPrice = '';
  minVolume = '';
  minConfidence = '';
  strictStart = false;
  presence = '';
  viewport: FlipViewport | null = null;
  search = '';
  category = '';
  venue = '';
  sort = 'percent-desc';
  expanded: string[] = [];
  offset = 0;
  excludedLimit = 100;
  historyRow = '';
  history: GggHistory | null = null;
  ninjaHistory: EconomyHistory | null = null;
  historyLimit = 100;
  historyError = '';
  historyLoading = false;
  result: FlipAnalysisResult | null = null;
  error = '';
  settingsError = '';
  isLoading = false;
  charts: Record<string, FlipSparklineView> = {};
  chartsLoading = false;
  chartError = '';
  currentAvailability: Record<string, CurrentItemAvailability> = {};
  currentTrends: Record<string, { paths: string[]; dots: { x: number; y: number }[] }> = {};
  currentAvailabilityLoading = false;
  currentAvailabilityError = '';
  get currentLeagueName(): string {
    return this.session.targetLeagueName;
  }
  private get targetLeagueId(): string { return this.session.historicalLeague || this.session.selectedLeagueId; }
  availabilityAge(value: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
    if (!Number.isFinite(minutes)) return 'Update time unknown';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }
  date = localDate;
  format = formatNumber;
  nativeRatioLabel = nativeRatioLabel;
  get segments(): string[] { return priceSegments(this.history); }
  get visibleRows(): FlipRow[] { return this.rows; }
  get rows(): FlipRow[] { return this.result?.rows ?? []; }
  get categories(): string[] { return this.result?.categories ?? []; }
  confidence(row: FlipRow): string {
    if (row.source === 'GGG Exchange') return '—';
    return `${row.start_confidence?.trim() || 'Unknown'} → ${row.end_confidence?.trim() || 'Unknown'}`;
  }
  confidenceTitle(row: FlipRow): string {
    return row.source === 'GGG Exchange'
      ? 'Not applicable: GGG reports actual traded volume, not poe.ninja provider confidence.'
      : 'poe.ninja provider confidence at the start → end observations. Missing labels are Unknown.';
  }
  cancelSparklines(): void {
    this.chartRequest?.abort(); this.chartRequest = null;
    this.charts = {}; this.chartsLoading = false; this.chartError = '';
    this.availabilityRequest?.abort(); this.availabilityRequest = null;
    this.currentAvailability = {}; this.currentAvailabilityLoading = false; this.currentAvailabilityError = '';
    this.currentTrends = {};
  }
  private async loadCurrentAvailability(result: FlipAnalysisResult): Promise<void> {
    if (!result.rows.length) return;
    const request = this.availabilityRequest = new AbortController();
    const league = this.targetLeagueId;
    this.currentAvailabilityLoading = true;
    try {
      if (!league) throw new Error('Select a live league to check current availability.');
      const response = await this.api.currentAvailability(league, result.rows, request.signal);
      if (request.signal.aborted || this.result !== result || league !== this.targetLeagueId) return;
      if (response.league !== league) throw new Error('Availability response belongs to a different league.');
      const items: Record<string, CurrentItemAvailability> = {};
      const trends: typeof this.currentTrends = {};
      for (const row of result.rows) {
        const item = response.items.find(item => item.id === row.id);
        if (!item) throw new Error(`Missing current availability for ${row.name}.`);
        items[row.id] = item;
        const segments = sparkSegments(item.sparkline, 120, 36);
        trends[row.id] = {
          paths: segments.filter(segment => segment.includes(' ')).map(segment => `M${segment.replaceAll(' ', ' L')}`),
          dots: segments.filter(segment => !segment.includes(' ')).map(segment => {
            const [x, y] = segment.split(',').map(Number);
            return { x: x!, y: y! };
          }),
        };
      }
      this.currentAvailability = items;
      this.currentTrends = trends;
    } catch (error) {
      if (!request.signal.aborted && this.result === result && league === this.targetLeagueId) {
        this.currentAvailabilityError = `Current-league availability unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      if (this.availabilityRequest === request) {
        this.currentAvailabilityLoading = false; this.availabilityRequest = null;
      }
    }
  }
  private async loadSparklines(result: FlipAnalysisResult): Promise<void> {
    this.cancelSparklines();
    if (!result.rows.length) return;
    const request = this.chartRequest = new AbortController();
    this.chartsLoading = true;
    try {
      const response = await this.api.flipSparklines(result.league, result.start, result.end, result.rows, request.signal);
      if (request.signal.aborted || this.result !== result || result.league !== this.compareLeague) return;
      const charts: Record<string, FlipSparklineView> = {};
      for (const row of result.rows) {
        const series = response.series.find((series) => series.id === row.id);
        if (!series) throw new Error(`Missing chart series for ${row.name}.`);
        if (series.points.length > 60) throw new Error('Chart series exceeds the 60-point limit.');
        charts[row.id] = flipSparkline(series, result.start, result.end);
      }
      this.charts = charts;
    } catch (error) {
      if (!request.signal.aborted && this.result === result) {
        this.chartError = `Historical charts unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      if (this.chartRequest === request) { this.chartsLoading = false; this.chartRequest = null; }
    }
  }
  volume(row: FlipRow): string {
    const pair = row.source === 'GGG Exchange' ? row.alternatives.find((pair) => pair.selected) : undefined;
    return pair ? `${this.format(pair.start_volume)} → ${this.format(pair.end_volume)}` : 'Unknown';
  }
  volumeTitle(row: FlipRow): string {
    const pair = row.source === 'GGG Exchange' ? row.alternatives.find((pair) => pair.selected) : undefined;
    return pair
      ? `${pair.start_volume} → ${pair.end_volume} item units traded in the start/end hours for the selected ${pair.quote} pair; not the period total.`
      : 'Comparable item-unit traded volume is unavailable for this source.';
  }
  get minimum(): number { return this.period?.start ?? 0; }
  get maximum(): number { return Math.min(this.period?.end ?? 0, latestHour()); }
  get minInput(): string { return this.period?.start == null ? '' : localInput(this.minimum); }
  get maxInput(): string { return this.period?.end == null ? '' : localInput(this.maximum); }
  get startText(): string { return this.start.replace('T', ' '); }
  set startText(value: string) { this.start = value.replace(' ', 'T'); }
  get endText(): string { return this.end.replace('T', ' '); }
  set endText(value: string) { this.end = value.replace(' ', 'T'); }
  get canAnalyze(): boolean {
    return !!this.compareLeague && this.periodLeague === this.compareLeague && this.period?.start != null
      && this.period?.end != null && this.maximum > this.minimum;
  }
  get availabilityMessage(): string {
    if (this.periodLoading) return 'Loading saved period metadata…';
    if (!this.period) return 'Saved period metadata is unavailable. Analysis is disabled.';
    if (!this.canAnalyze) return 'League bounds are unavailable or contain fewer than two completed hours. Analysis is disabled.';
    const points = observationPoints(this.period.hours, this.period.days);
    if (!this.start || !this.end) return 'Fewer than two recorded endpoints are available. Choose endpoints within league bounds; missing data is not interpolated.';
    if (!points.includes(this.selectedStart) || !points.includes(this.selectedEnd)) return 'One or both endpoints have no recorded observation. Missing item endpoints are excluded, never interpolated.';
    return 'Lines mark actual recorded hours / UTC dataset days; item coverage can differ.';
  }
  closeInformation(event: KeyboardEvent): void {
    if (event.key === 'Escape' && event.currentTarget instanceof HTMLDetailsElement) {
      event.preventDefault();
      event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }
  timestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : localDate(date.getTime() / 1000);
  }
  hasDifferentStart(row: FlipRow): boolean {
    if (!this.result) return false;
    return row.history_granularity === 'daily'
      ? row.start_observed_at.slice(0, 10) !== new Date(this.result.start * 1000).toISOString().slice(0, 10)
      : Date.parse(row.start_observed_at) / 1000 !== this.result.start;
  }
  constructor() { if (this.session.flipState) Object.assign(this, this.session.flipState); }
  loading(): void { this.session.page = 'flips'; this.session.flips = this; }
  attached(): void { this.active = true; void this.initialize(); }
  private async initialize(): Promise<void> {
    await this.session.ensureLoaded();
    if (this.active) await this.datasetChanged(false);
  }
  snapshot() {
    return { start: this.start, end: this.end, minPrice: this.minPrice, maxPrice: this.maxPrice,
      minVolume: this.minVolume, minConfidence: this.minConfidence, strictStart: this.strictStart, search: this.search, category: this.category, venue: this.venue,
      sort: this.sort, presence: this.presence, viewport: this.viewport, expanded: this.expanded, result: this.result, loadedLeague: this.loadedLeague,
      offset: this.offset, period: this.period, periodLeague: this.periodLeague, selectedStart: this.selectedStart,
      selectedEnd: this.selectedEnd, excludedLimit: this.excludedLimit, historyRow: this.historyRow, history: this.history,
      ninjaHistory: this.ninjaHistory, historyLimit: this.historyLimit };
  }
  unbinding(): void {
    this.referenceRequest?.abort();
    if (this.referenceTimer) clearInterval(this.referenceTimer);
    this.referenceTimer = null;
    this.flushSettings();
    this.cancelSparklines();
    this.active = false; this.request?.abort(); this.detailRequest?.abort();
    this.periodRequest?.abort();
    if (this.searchTimer || this.isLoading) this.result = null;
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.session.flipState = this.snapshot();
    if (this.session.flips === this) this.session.flips = null;
  }
  toggle(id: string): void {
    const opening = !this.expanded.includes(id);
    this.expanded = opening ? [...this.expanded, id] : this.expanded.filter((x) => x !== id);
    const row = this.result?.rows.find((item) => item.id === id);
    if (opening && row && (row.source === 'GGG Exchange' || row.history_item)) void this.inspect(row);
  }
  async inspect(row: FlipRow): Promise<void> {
    this.detailRequest?.abort();
    const request = this.detailRequest = new AbortController();
    this.historyRow = row.id; this.history = null; this.ninjaHistory = null; this.historyError = ''; this.historyLoading = true;
    this.historyLimit = 100;
    try {
      if (!this.result) return;
      if (row.source === 'GGG Exchange' && row.alternatives.some((pair) => pair.selected)) {
        const market = row.alternatives.find((pair) => pair.selected)!.market;
        const history = await this.api.gggHistory(this.result.league, market, this.result.start, this.result.end, request.signal);
        if (!request.signal.aborted) this.history = history;
      } else if (row.history_category && row.history_item && (row.history_source === 'exchange' || row.history_source === 'stash')) {
        const history = await this.api.economyHistory(this.result.league, row.history_category, row.history_source,
          row.history_item, '', request.signal);
        if (!request.signal.aborted) this.ninjaHistory = history;
      } else throw new Error('Supporting history is unavailable for this source.');
    } catch (error) {
      if (!request.signal.aborted) this.historyError = error instanceof Error ? error.message : String(error);
    } finally { if (this.detailRequest === request) this.historyLoading = false; }
  }
  async datasetChanged(force = true): Promise<void> {
    if (!this.compareLeague) {
      this.flushSettings();
      this.referenceRequest?.abort();
      if (this.referenceTimer) clearInterval(this.referenceTimer);
      this.referenceTimer = null;
      this.periodRequest?.abort(); this.request?.abort(); this.detailRequest?.abort();
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = null;
      this.cancelSparklines();
      this.period = null; this.result = null; this.periodLeague = ''; this.loadedLeague = '';
      this.start = ''; this.end = ''; this.viewport = null;
      Object.assign(this, this.defaultFilters());
      this.isLoading = false; this.periodLoading = false; this.historyLoading = false;
      this.referenceTime = null; this.referenceLabel = ''; this.error = ''; this.referenceError = '';
      this.currentLaunch = null; this.selectedLaunch = null;
      this.history = null; this.ninjaHistory = null; this.historyRow = '';
      this.historyError = '';
      return;
    }
    const reference = this.loadReference();
    this.cancelSparklines();
    this.periodRequest?.abort(); this.request?.abort(); this.detailRequest?.abort();
    this.isLoading = false;
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; this.offset = 0; }
    const request = this.periodRequest = new AbortController();
    const league = this.compareLeague;
    const changed = this.periodLeague !== league;
    this.flushSettings();
    if (changed) {
      if (this.periodLeague) Object.assign(this, this.defaultFilters());
      this.result = null; this.period = null; this.start = ''; this.end = ''; this.offset = 0;
      this.viewport = null;
    }
    this.periodLoading = true; this.error = '';
    try {
      const restore = changed || !this.start || !this.end;
      const [period, saved] = await Promise.all([
        this.api.analysisPeriod(league, request.signal),
        restore ? this.loadSavedPeriod(league, request.signal) : Promise.resolve(null),
        reference,
      ]);
      if (request.signal.aborted || league !== this.compareLeague) return;
      if (saved) {
        this.setRange(saved.start, saved.end);
        this.viewport = saved.viewport ?? null;
        if (saved.filters) Object.assign(this, saved.filters);
      }
      if (this.selectedLaunch?.start != null && !this.selectedLaunch.approximate) {
        period.start = this.selectedLaunch.start;
      }
      this.period = period; this.periodLeague = league;
      this.updateReference();
      if (this.canAnalyze) {
        const points = observationPoints(period.hours, period.days).filter((point) => point >= this.minimum && point <= this.maximum);
        const savedStart = new Date(this.start).getTime() / 1000, savedEnd = new Date(this.end).getTime() / 1000;
        if (!this.start || !this.end) {
          if (points.length >= 2) this.setRange(points[0]!, points.at(-1)!);
          else { this.start = ''; this.end = ''; }
          this.offset = 0; force = true;
        } else if (!Number.isFinite(savedStart) || !Number.isFinite(savedEnd)
          || savedStart < this.minimum || savedEnd > this.maximum || savedStart >= savedEnd) {
          this.offset = 0; force = true;
        }
      }
      if (this.canAnalyze && this.start && this.end && (force || !this.result || this.loadedLeague !== league)) await this.refresh(false);
      else if (this.result) {
        void this.loadSparklines(this.result);
        void this.loadCurrentAvailability(this.result);
      }
    } catch (error) {
      if (!request.signal.aborted) { this.period = null; this.result = null; this.error = error instanceof Error ? error.message : String(error); }
    } finally { if (this.periodRequest === request) this.periodLoading = false; }
  }
  private async loadSavedPeriod(league: string, signal: AbortSignal): Promise<FlipPeriodSelection | null> {
    this.settingsError = '';
    try {
      const saved = await this.session.loadFlipPeriod(league, signal);
      if (saved && (!Number.isSafeInteger(saved.start) || !Number.isSafeInteger(saved.end)
        || saved.start < 0 || saved.start >= saved.end || saved.start % 3600 !== 0 || saved.end % 3600 !== 0
        || !Number.isFinite(new Date(saved.end * 1000).getTime()))) {
        throw new Error('Saved period contains invalid hour timestamps.');
      }
      return saved;
    } catch (error) {
      if (!signal.aborted && league === this.compareLeague) {
        this.settingsError = `Unable to restore Fliper period: ${error instanceof Error ? error.message : String(error)}`;
      }
      return null;
    }
  }
  private setRange(start: number, end: number): void {
    this.selectedStart = start; this.selectedEnd = end;
    this.start = localInput(start); this.end = localInput(end);
  }
  private defaultFilters(): FlipFilters {
    return { minPrice: '', maxPrice: '', minVolume: '', minConfidence: '', strictStart: false,
      search: '', category: '', venue: '', sort: 'percent-desc', presence: '' };
  }
  private filterSettings(): FlipFilters {
    return { minPrice: this.minPrice, maxPrice: this.maxPrice, minVolume: this.minVolume,
      minConfidence: this.minConfidence, strictStart: this.strictStart, search: this.search,
      category: this.category, venue: this.venue, sort: this.sort, presence: this.presence };
  }
  commitViewport(viewport: FlipViewport | null): void {
    this.viewport = viewport;
    this.queueSettingsSave();
  }
  queueSettingsSave(): void {
    if (!this.canAnalyze) return;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    try {
      this.pendingSettings = { league: this.compareLeague,
        settings: { ...this.enteredRange(), viewport: this.viewport, filters: this.filterSettings() } };
      this.settingsTimer = setTimeout(() => this.flushSettings(), 200);
    } catch (error) {
      this.pendingSettings = null;
      this.settingsError = `Unable to save Fliper settings: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  private flushSettings(): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    const pending = this.pendingSettings; this.pendingSettings = null;
    if (pending) void this.persistSettings(pending.league, pending.settings);
  }
  filterEdited(): void {
    this.cancelSparklines(); this.queueSettingsSave();
  }
  commitPeriod(range: { start: number; end: number }): void {
    this.setRange(range.start, range.end); void this.savePeriod(); void this.refresh();
  }
  searchChangedByUser(): void {
    this.queueSettingsSave();
    this.cancelSparklines();
    this.request?.abort();
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.searchTimer = null; void this.refresh(); }, 250);
  }
  async changePage(direction: number): Promise<void> {
    this.offset = Math.max(0, this.offset + direction * 100); await this.refresh(false);
  }
  async analyze(): Promise<void> {
    const league = this.compareLeague;
    this.offset = 0;
    await this.datasetChanged();
    if (league === this.compareLeague) await this.savePeriod();
  }
  private enteredRange(): { start: number; end: number } {
    // Retain absolute timestamps when a band selection falls in a repeated local DST hour.
    const enteredStart = this.start === localInput(this.selectedStart) ? this.selectedStart : new Date(this.start).getTime() / 1000;
    const enteredEnd = this.end === localInput(this.selectedEnd) ? this.selectedEnd : new Date(this.end).getTime() / 1000;
    if (!Number.isFinite(enteredStart) || !Number.isFinite(enteredEnd)
      || enteredStart % 3600 !== 0 || enteredEnd % 3600 !== 0
      || localInput(enteredStart) !== this.start || localInput(enteredEnd) !== this.end) {
      throw new Error('Enter a valid local date and time in yyyy-mm-dd hh:mm format.');
    }
    const start = Math.max(this.minimum, Math.min(this.maximum, enteredStart));
    const end = Math.max(this.minimum, Math.min(this.maximum, enteredEnd));
    if (start >= end) throw new Error('End must be after start.');
    return { start, end };
  }
  async savePeriod(): Promise<void> {
    if (!this.canAnalyze) return;
    const league = this.compareLeague;
    try {
      const range = this.enteredRange();
      if (this.settingsTimer) clearTimeout(this.settingsTimer);
      this.settingsTimer = null; this.pendingSettings = null;
      await this.persistSettings(league, {
        ...range, viewport: this.viewport, filters: this.filterSettings(),
      });
    } catch (error) {
      if (league === this.compareLeague) {
        this.settingsError = `Unable to save Fliper period: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  private async persistSettings(league: string, settings: FlipPeriodSelection): Promise<void> {
    try {
      await this.session.saveFlipPeriod(league, settings);
      if (league === this.compareLeague) this.settingsError = '';
    } catch (error) {
      if (league === this.compareLeague) {
        this.settingsError = `Unable to save Fliper settings: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  async refresh(resetOffset = true): Promise<void> {
    this.cancelSparklines();
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    if (!this.period || this.periodLeague !== this.compareLeague) { await this.datasetChanged(); return; }
    if (!this.periodLoading) this.queueSettingsSave();
    if (resetOffset) this.offset = 0;
    this.request?.abort(); this.detailRequest?.abort();
    const request = this.request = new AbortController();
    this.isLoading = true; this.error = ''; this.history = null; this.ninjaHistory = null; this.historyRow = '';
    this.excludedLimit = 100;
    try {
      if (!this.canAnalyze) throw new Error('Known league bounds are required before analysis.');
      const { start, end } = this.enteredRange();
      this.setRange(start, end);
      const min = decimal(this.minPrice, 'Minimum starting price'), max = decimal(this.maxPrice, 'Maximum starting price');
      const volume = decimal(this.minVolume, 'Minimum GGG item volume');
      if (min !== undefined && max !== undefined && Number(min) > Number(max)) throw new Error('Minimum starting price must not exceed maximum.');
      const filters: Record<string, string> = { offset: String(this.offset), limit: '100', sort: this.sort,
        search: this.search, category: this.category, venue: this.venue };
      if (min !== undefined) filters.min_price = min;
      if (max !== undefined) filters.max_price = max;
      if (volume !== undefined) filters.min_volume = volume;
      if (this.minConfidence) filters.min_confidence = this.minConfidence;
      if (this.strictStart) filters.strict_start = 'true';
      if (this.presence) {
        if (!this.targetLeagueId) throw new Error('Select a Target league before filtering current presence.');
        filters.presence = this.presence; filters.current_league = this.targetLeagueId;
      }
      const league = this.compareLeague;
      const result = await this.api.flips(league, start, end, filters, request.signal);
      if (!request.signal.aborted && league === this.compareLeague) {
        this.result = result; this.loadedLeague = league; this.offset = result.offset;
        void this.loadSparklines(result);
        void this.loadCurrentAvailability(result);
      }
    } catch (error) {
      if (!request.signal.aborted) { this.result = null; this.error = error instanceof Error ? error.message : String(error); }
    } finally { if (this.request === request) this.isLoading = false; }
  }
}
