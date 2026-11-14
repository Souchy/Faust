use serde::{Deserialize, Serialize};

use crate::economy::Line;

#[derive(Clone, Debug)]
pub struct Observation {
    pub category: String,
    pub source: String,
    pub line: Line,
    pub observed_at: String,
    pub granularity: String,
    pub price: String,
    pub currency: String,
    pub archive: Option<String>,
    pub volume: Option<String>,
    pub confidence: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PairAlternative {
    pub market: String,
    pub quote: String,
    pub native_start: String,
    pub native_end: String,
    pub start_price: String,
    pub end_price: String,
    pub growth: String,
    pub growth_percent: String,
    pub start_volume: String,
    pub end_volume: String,
    pub selected: bool,
    #[serde(default)]
    pub start_observed_at: String,
    #[serde(default)]
    pub end_observed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FlipRow {
    pub id: String,
    pub name: String,
    pub category: String,
    pub venue: String,
    pub source: String,
    pub start_price: String,
    pub end_price: String,
    pub growth: String,
    pub growth_percent: String,
    pub start_observed_at: String,
    pub end_observed_at: String,
    pub pair: String,
    pub alternatives: Vec<PairAlternative>,
    pub native_start: String,
    pub native_end: String,
    pub history_category: Option<String>,
    pub history_source: Option<String>,
    pub history_item: Option<String>,
    #[serde(default)]
    pub history_archive: Option<String>,
    #[serde(default)]
    pub history_granularity: Option<String>,
    #[serde(default)]
    pub start_confidence: Option<String>,
    #[serde(default)]
    pub end_confidence: Option<String>,
    #[serde(default)]
    pub item_identity: Option<FlipItemIdentity>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(default)]
pub struct FlipItemIdentity {
    pub name: String,
    pub variant: Option<String>,
    pub base_type: Option<String>,
    pub links: Option<u64>,
    pub gem_level: Option<u64>,
    pub gem_quality: Option<u64>,
    pub corrupted: Option<bool>,
    pub map_tier: Option<u64>,
    pub cluster_level: Option<u64>,
}

impl FlipItemIdentity {
    pub fn from_line(category: &str, line: &Line) -> Self {
        let variant = line.variant.clone().filter(|variant| {
            let corrupted = variant.ends_with('c');
            let raw = variant.strip_suffix('c').unwrap_or(variant);
            let (level, quality) = raw.split_once('/').unwrap_or((raw, "0"));
            // Dumps encode gem attributes in Variant; live overviews expose separate fields.
            !(line.gem_level.is_some()
                && level.parse::<u64>().ok() == line.gem_level
                && quality.parse::<u64>().ok() == line.gem_quality
                && Some(corrupted) == line.corrupted)
        });
        Self {
            name: line.name.clone(),
            variant,
            base_type: line.base_type.clone(),
            links: line.links,
            gem_level: line.gem_level,
            gem_quality: line.gem_quality,
            corrupted: line.corrupted,
            map_tier: line.map_tier,
            cluster_level: if category == "ClusterJewel" {
                line.metadata
                    .get("levelRequired")
                    .and_then(serde_json::Value::as_u64)
            } else {
                None
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CurrentAvailability {
    pub league: String,
    pub items: Vec<CurrentItem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CurrentItem {
    pub id: String,
    pub status: String,
    pub price: Option<String>,
    pub listings: Option<u64>,
    pub fetched_at: Option<String>,
    pub source: Option<String>,
    pub detail: String,
    #[serde(default)]
    pub sparkline: Vec<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SparkPoint {
    pub time: i64,
    pub price: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Sparkline {
    pub id: String,
    pub points: Vec<SparkPoint>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Sparklines {
    pub series: Vec<Sparkline>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Excluded {
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Flips {
    pub league: String,
    pub start: i64,
    pub end: i64,
    pub rows: Vec<FlipRow>,
    pub excluded: Vec<Excluded>,
    pub warnings: Vec<String>,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
    #[serde(default)]
    pub excluded_total: usize,
    #[serde(default)]
    pub categories: Vec<String>,
}

fn page_size() -> usize {
    100
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Period {
    pub league: String,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub bounds_source: String,
    pub hours: Vec<i64>,
    pub days: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ArbitrageLoop {
    pub id: String,
    pub path: Vec<String>,
    pub rates: Vec<String>,
    pub market_ids: Vec<String>,
    pub return_percent: String,
    pub start_amount: String,
    pub end_amount: String,
    pub minimum_volume: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Arbitrage {
    pub league: String,
    pub hour: i64,
    pub complete: bool,
    pub loops: Vec<ArbitrageLoop>,
    pub warnings: Vec<String>,
}
