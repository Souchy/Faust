import { invoke, isTauri } from '@tauri-apps/api/core';
import type { FlipPeriodSelection } from '../core/api-types';

const storageKey = 'faust.flip-periods';

export class ClientSettings {
  async loadFlipPeriod(league: string): Promise<FlipPeriodSelection | null> {
    if (isTauri()) return invoke('load_flip_period', { league });
    const periods = this.readBrowserPeriods();
    return periods[league] ?? null;
  }

  async saveFlipPeriod(league: string, period: FlipPeriodSelection): Promise<void> {
    if (isTauri()) return invoke('save_flip_period', { league, period });
    const periods = this.readBrowserPeriods();
    const updated = this.validatePeriods({ ...periods, [league]: period });
    localStorage.setItem(storageKey, JSON.stringify(updated));
  }

  private readBrowserPeriods(): Record<string, FlipPeriodSelection> {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return {};
    return this.validatePeriods(JSON.parse(raw));
  }

  private validatePeriods(parsed: unknown): Record<string, FlipPeriodSelection> {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid client Flip period settings.');
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'object' || value === null
        || !('start' in value) || !('end' in value)
        || typeof value.start !== 'number' || typeof value.end !== 'number'
        || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
        || value.start < 0 || value.start >= value.end || value.start % 3600 || value.end % 3600
        || !Number.isFinite(new Date(value.end * 1000).getTime())) {
        throw new Error('Invalid client Flip period settings.');
      }
      if ('viewport' in value && value.viewport !== null && value.viewport !== undefined) {
        const view = value.viewport;
        if (typeof view !== 'object' || !('start' in view) || !('end' in view)
          || typeof view.start !== 'number' || typeof view.end !== 'number'
          || !Number.isFinite(view.start) || !Number.isFinite(view.end) || view.start < 0
          || view.start >= view.end || view.end > 8_640_000_000_000) {
          throw new Error('Invalid client Flip zoom settings.');
        }
      }
      if ('filters' in value && value.filters !== undefined) {
        const filters = value.filters;
        if (typeof filters !== 'object' || filters === null || Array.isArray(filters)
          || !('strictStart' in filters) || typeof filters.strictStart !== 'boolean'
          || ['minPrice', 'maxPrice', 'minVolume', 'minConfidence', 'search', 'category', 'venue', 'sort', 'presence']
            .some(key => !(key in filters) || typeof Reflect.get(filters, key) !== 'string')
          || !['', 'observed', 'not_observed', 'unknown', 'ambiguous'].includes(Reflect.get(filters, 'presence'))
          || !['percent-desc', 'percent-asc', 'value-desc', 'value-asc'].includes(Reflect.get(filters, 'sort'))
          || !['', 'Low', 'Medium', 'High'].includes(Reflect.get(filters, 'minConfidence'))
          || !['', 'exchange', 'trade'].includes(Reflect.get(filters, 'venue'))) {
          throw new Error('Invalid client Flip filter settings.');
        }
      }
    }
    return parsed as Record<string, FlipPeriodSelection>;
  }
}
