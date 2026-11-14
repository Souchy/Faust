import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ClientSettings } from './client-settings';
import type { FlipPeriodSelection } from '../core/api-types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('client settings', () => {
  it('stores Compare through desktop IPC and reports errors', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValueOnce('Mirage').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Access denied'));
    const settings = new ClientSettings();
    expect(await settings.loadCompareLeague()).toBe('Mirage');
    await settings.saveCompareLeague('');
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_compare_league');
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_compare_league', { league: '' });
    await expect(settings.saveCompareLeague('Mirage')).rejects.toThrow('Access denied');
  });

  it('uses desktop IPC, not HTTP or browser storage, for its settings file', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    const period = { start: 3600, end: 7200 };
    vi.mocked(invoke).mockResolvedValueOnce(period).mockResolvedValueOnce(undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const settings = new ClientSettings();
    await expect(settings.loadFlipPeriod('Standard')).resolves.toEqual(period);
    await settings.saveFlipPeriod('Standard', period);
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_flip_period', { league: 'Standard' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'save_flip_period', { league: 'Standard', period });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not silently fall back if the desktop file cannot be saved', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockRejectedValue(new Error('Access denied'));
    await expect(new ClientSettings().saveFlipPeriod('Standard', { start: 0, end: 3600 }))
      .rejects.toThrow('Access denied');
  });

  it('uses browser-local persistence across client instances without a settings server', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    const settings = new ClientSettings();
    expect(await settings.loadCompareLeague()).toBe('');
    await settings.saveCompareLeague('Mirage');
    expect(await new ClientSettings().loadCompareLeague()).toBe('Mirage');
    await settings.saveCompareLeague('');
    expect(await new ClientSettings().loadCompareLeague()).toBe('');
    await expect(settings.saveCompareLeague(' invalid ')).rejects.toThrow('Invalid Compare');
    expect(await settings.loadFlipPeriod('Standard')).toBeNull();
    await settings.saveFlipPeriod('Standard', { start: 0, end: 3600 });
    await settings.saveFlipPeriod('Mirage', { start: 3600, end: 7200 });
    expect(await new ClientSettings().loadFlipPeriod('Standard')).toEqual({ start: 0, end: 3600 });
    expect(await new ClientSettings().loadFlipPeriod('Mirage')).toEqual({ start: 3600, end: 7200 });
    values.set('faust.flip-periods', 'broken JSON');
    await expect(settings.saveFlipPeriod('Standard', { start: 0, end: 3600 })).rejects.toThrow();
    expect(values.get('faust.flip-periods')).toBe('broken JSON');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps old period-only settings compatible and round-trips filters and fractional zoom', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    let raw = JSON.stringify({ Standard: { start: 0, end: 3600 } });
    vi.stubGlobal('localStorage', {
      getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; },
    });
    const settings = new ClientSettings();
    expect(await settings.loadFlipPeriod('Standard')).toEqual({ start: 0, end: 3600 });
    const selection: FlipPeriodSelection = {
      start: 0, end: 3600, viewport: { start: 123.5, end: 3456.7 },
      filters: { minPrice: '1', maxPrice: '10', minVolume: '20', minConfidence: 'High',
        strictStart: true, search: 'oil', category: 'Oil', venue: 'exchange', sort: 'value-desc', presence: 'observed' },
    };
    await settings.saveFlipPeriod('Standard', selection);
    expect(await new ClientSettings().loadFlipPeriod('Standard')).toEqual(selection);
    raw = JSON.stringify({ Standard: { ...selection, viewport: { start: 5, end: 2 } } });
    await expect(settings.loadFlipPeriod('Standard')).rejects.toThrow('zoom');
    raw = JSON.stringify({ Standard: { ...selection, filters: { ...selection.filters, presence: 'missing' } } });
    await expect(settings.loadFlipPeriod('Standard')).rejects.toThrow('filter');
  });
});
