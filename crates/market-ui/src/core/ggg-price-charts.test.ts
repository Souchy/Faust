import { describe, expect, it } from 'vitest';
import { alignedSamples, comparisonChart, historyPoints } from './ggg-price-charts';
import type { GggPrices, GggPriceSample } from './api-types';
import { economyOverview } from '../testing/fixtures';

const sample = (time: number, price: string | null, volume = '10'): GggPriceSample => ({ time, price, volume });

describe('League-age comparison charts', () => {
  it('aligns launch ages without altering source timestamps or inventing samples', () => {
    const data: GggPrices = { overview: economyOverview(), launch: 3600, current_launch: 90000,
      current_league: 'New', trends: {}, warnings: [] };
    const trend = alignedSamples(data, { selected: [sample(7200, '10')], current: [sample(93600, '100')] });
    expect(trend.current).toEqual([{ ...sample(7200, '100'), original_time: 93600 }]);
    const chart = comparisonChart(trend, 3600, ['Old', 'New'])!;
    expect(chart.points[0]?.x).toBe(chart.points[1]?.x);
    expect(chart.points[0]?.y).toBeGreaterThan(chart.points[1]!.y);
    expect(chart.currentSegments).toHaveLength(1);
    expect(chart.points[1]?.label).toContain('New · Day 1');
  });

  it('keeps missing hourly samples as gaps and shares the volume scale', () => {
    const chart = comparisonChart({ selected: [sample(0, '10', '10'), sample(3600, null), sample(7200, '20', '20')],
      current: [sample(0, '100', '100'), sample(3600, '90', '80')] })!;
    expect(chart.segments).toHaveLength(2);
    expect(chart.currentSegments).toHaveLength(1);
    expect(chart.volume.max).toBe(100);
    expect(chart.volume.bars).toContain('V50.8');
    expect(chart.currentVolume).toContain('V4');
  });

  it('preserves daily granularity and avoids joining across missing days', () => {
    const points = [0, 86400, 3 * 86400].map(time => ({ ...sample(time, '10'), granularity: 'daily' as const }));
    expect(historyPoints(points)).toHaveLength(3);
    expect(historyPoints(points)[0]?.granularity).toBe('daily');
    expect(comparisonChart({ selected: points, current: [] })?.segments).toHaveLength(2);
  });
});
