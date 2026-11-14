import { DI, Registration } from 'aurelia';
import { describe, expect, it, vi } from 'vitest';
import { MarketApi } from '../core/market-api';
import { status } from '../testing/fixtures';
import { ClientSettings } from './client-settings';
import { MarketSession } from './market-session';

function workspace() {
  const api = new MarketApi('');
  vi.spyOn(api, 'leagues').mockResolvedValue([{ id: 'Standard', name: 'Standard' }]);
  vi.spyOn(api, 'status').mockResolvedValue(status());
  vi.spyOn(api, 'economyLeagues').mockResolvedValue([
    { id: 'Mirage', name: 'Mirage', live: false, archived: true },
    { id: 'Ancestors', name: 'Ancestors', live: false, archived: true },
  ]);
  vi.spyOn(api, 'selectLeague').mockResolvedValue({ id: 'Standard', name: 'Standard' });
  const settings = new ClientSettings();
  vi.spyOn(settings, 'saveCompareLeague').mockResolvedValue();
  const container = DI.createContainer().register(
    Registration.instance(MarketApi, api), Registration.instance(ClientSettings, settings),
    Registration.singleton(MarketSession, MarketSession),
  );
  return { session: container.get(MarketSession), settings };
}

describe('Compare league persistence', () => {
  it('does not overwrite a newer selection with a delayed restore', async () => {
    const { session, settings } = workspace();
    let finish!: (league: string) => void;
    vi.spyOn(settings, 'loadCompareLeague').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const loading = session.load();
    await session.selectCompareLeague('Ancestors');
    finish('Mirage');
    await loading;
    expect(session.compareLeague).toBe('Ancestors');
    expect(settings.saveCompareLeague).toHaveBeenCalledWith('Ancestors');
    expect(session.compareError).toBe('');
  });

  it('serializes writes and surfaces the latest failure without losing the selection', async () => {
    const { session, settings } = workspace();
    let finish!: () => void;
    vi.mocked(settings.saveCompareLeague).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('Access denied'));
    const first = session.selectCompareLeague('Mirage');
    await vi.waitFor(() => expect(settings.saveCompareLeague).toHaveBeenCalledOnce());
    const second = session.selectCompareLeague('Ancestors');
    expect(settings.saveCompareLeague).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(settings.saveCompareLeague).toHaveBeenLastCalledWith('Ancestors');
    expect(session.compareLeague).toBe('Ancestors');
    expect(session.compareError).toContain('Access denied');
  });

  it('reports restoration errors without blocking the target league', async () => {
    const { session, settings } = workspace();
    vi.spyOn(settings, 'loadCompareLeague').mockRejectedValue(new Error('Access denied'));
    await session.load();
    expect(session.compareError).toContain('Access denied');
    expect(session.compareLeague).toBe('');
    expect(session.selectedLeagueId).toBe('Standard');
  });
});
