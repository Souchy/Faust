import type { EconomyHistoryPoint, GggPriceSample, GggPrices, GggPriceTrend } from './api-types';
import { historySeries, number, type ChartSeries } from './economy';

export interface ComparisonChart extends ChartSeries {
  currentSegments: string[];
  currentDots: string;
  currentVolume: string;
}

export function alignedSamples(data: GggPrices, trend: GggPriceTrend): GggPriceTrend {
  return { selected: trend.selected, current: data.overview.league === data.current_league ? []
    : trend.current.map(point => ({ ...point, original_time: point.time, time: data.launch + point.time - data.current_launch })) };
}

export function historyPoints(samples: GggPriceSample[]): EconomyHistoryPoint[] {
  return samples.flatMap(point => point.price === null ? [] : [{
    date: new Date(point.time * 1000).toISOString(), price: point.price, currency: 'Chaos Orb',
    granularity: point.granularity ?? 'hourly', volume: point.volume,
  }]);
}

export function comparisonChart(trend: GggPriceTrend, launch?: number, labels = ['Selected league', 'Current league']): ComparisonChart | null {
  const selected = historyPoints(trend.selected), current = historyPoints(trend.current);
  const all = [...selected, ...current].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const base = historySeries(all)[0];
  if (!base) return null;
  const observations = [...trend.selected.map(sample => ({ sample, label: labels[0] })),
    ...trend.current.map(sample => ({ sample, label: labels[1] }))]
    .filter(({ sample }) => number(sample.price) !== null).sort((a, b) => a.sample.time - b.sample.time);
  base.points.forEach((point, index) => {
    const entry = observations[index]!;
    const age = launch === undefined ? '' : `Day ${1 + Math.floor((entry.sample.time - launch) / 86400)} · `;
    point.label = `${entry.label} · ${age}${new Date((entry.sample.original_time ?? entry.sample.time) * 1000).toLocaleString()} · ${entry.sample.price}c${entry.sample.volume === null ? '' : ` · ${entry.sample.volume} ${entry.sample.granularity === 'hourly' || !entry.sample.granularity ? 'item units/hour' : 'reported volume'}`}`;
  });
  if (launch !== undefined) {
    const start = Date.parse(all[0]!.date) / 1000, end = Date.parse(all.at(-1)!.date) / 1000;
    const count = Math.min(5, Math.max(1, all.length));
    base.dayTicks = Array.from({ length: count }, (_, index) => {
      const fraction = count === 1 ? 0 : index / (count - 1);
      const age = Math.max(0, start + fraction * (end - start) - launch);
      const hours = end - start < 3 * 86400 ? ` ${Math.floor(age % 86400 / 3600)}h` : '';
      return { position: (16 + fraction * 768) / 8, label: `Day ${1 + Math.floor(age / 86400)}${hours}` };
    });
  }
  const positions = new Map(all.map((point, index) => [`${point.date}|${point.price}`, base.points[index]!]));
  const plot = (points: EconomyHistoryPoint[]) => {
    const segments: string[] = [];
    const dots: string[] = [];
    const bars: string[] = [];
    let previous: EconomyHistoryPoint | null = null;
    for (const point of points) {
      const position = positions.get(`${point.date}|${point.price}`)!;
      const time = Date.parse(point.date);
      const xy = `${position.x},${position.y}`;
      const threshold = point.granularity === 'daily' ? 36 * 3600_000 : point.granularity === 'hourly' ? 90 * 60_000 : 45 * 60_000;
      if (previous && previous.granularity === point.granularity && time - Date.parse(previous.date) <= threshold) segments[segments.length - 1] += ` ${xy}`;
      else segments.push(xy);
      dots.push(`M${position.x - 2.5},${position.y} a2.5,2.5 0 1,0 5,0 a2.5,2.5 0 1,0 -5,0`);
      const volume = number(point.volume);
      if (volume !== null && volume >= 0) bars.push(`M${position.x},56 V${56 - volume / (base.volume.max || 1) * 52}`);
      previous = point;
    }
    return { segments, dots: dots.join(' '), bars: bars.join(' ') };
  };
  const a = plot(selected), b = plot(current);
  return { ...base, segments: a.segments, dots: a.dots, currentSegments: b.segments,
    currentDots: b.dots, currentVolume: b.bars, volume: { ...base.volume, bars: a.bars } };
}
