use std::collections::{BTreeMap, HashMap};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::{chaos_rates, failure, number, quotes, utc_hour, ApiError, Quote, CHAOS};
use crate::{analysis::league_start, ServiceState};
use market_core::{
    economy::{Line, Overview},
    ggg::{Item, Market},
};

const HOUR: i64 = 3600;

#[derive(Deserialize)]
pub(super) struct PriceQuery {
    league: String,
    category: String,
    current_league: String,
    compare_league: Option<String>,
    #[serde(default)]
    date: String,
    item: Option<String>,
    source: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Sample {
    time: i64,
    price: Option<String>,
    volume: Option<String>,
    granularity: String,
}

#[derive(Serialize)]
pub struct Trend {
    selected: Vec<Sample>,
    current: Vec<Sample>,
}

#[derive(Serialize)]
pub struct Prices {
    overview: Overview,
    launch: i64,
    current_launch: i64,
    current_league: String,
    trends: HashMap<String, Trend>,
    warnings: Vec<String>,
    collection: Option<market_core::ggg::ImportJob>,
    collection_error: Option<String>,
    dates: Vec<String>,
}

fn preferred_pair<'a>(
    indexed: &'a BTreeMap<String, Vec<Quote>>,
    rates: &HashMap<String, rust_decimal::Decimal>,
    item: &str,
) -> Option<&'a Quote> {
    indexed
        .get(item)?
        .iter()
        .filter(|pair| rates.contains_key(&pair.quote.id))
        .max_by(|a, b| {
            (a.quote.id == CHAOS)
                .cmp(&(b.quote.id == CHAOS))
                .then_with(|| a.volume.cmp(&b.volume))
                .then_with(|| b.market.cmp(&a.market))
        })
}

#[cfg(test)]
fn selected_pair(markets: &[Market], item: &str) -> Option<(String, String, String, String)> {
    let indexed = quotes(markets);
    let rates = chaos_rates(&indexed);
    let pair = preferred_pair(&indexed, &rates, item)?;
    let price = pair.rate.checked_mul(*rates.get(&pair.quote.id)?)?;
    Some((
        number(price),
        number(pair.volume),
        pair.quote.name.clone(),
        number(pair.rate),
    ))
}

fn hourly_samples(
    markets: &[(i64, Market)],
    items: &[Item],
    start: i64,
    end: i64,
) -> HashMap<String, Vec<Sample>> {
    let mut hours = BTreeMap::<i64, Vec<Market>>::new();
    for (hour, market) in markets {
        hours.entry(*hour).or_default().push(market.clone());
    }
    let mut output: HashMap<_, Vec<_>> = items
        .iter()
        .map(|item| (item.id.clone(), Vec::new()))
        .collect();
    for hour in (start..=end).step_by(HOUR as usize) {
        let indexed = quotes(hours.get(&hour).map(Vec::as_slice).unwrap_or_default());
        let rates = chaos_rates(&indexed);
        for item in items {
            let pair = preferred_pair(&indexed, &rates, &item.id);
            let price = pair
                .and_then(|pair| pair.rate.checked_mul(rates[&pair.quote.id]))
                .map(number);
            output
                .get_mut(&item.id)
                .expect("item indexed")
                .push(Sample {
                    time: hour,
                    price,
                    volume: pair.map(|pair| number(pair.volume)),
                    granularity: "hourly".into(),
                });
        }
    }
    output
}

fn timestamp(value: &str) -> Result<i64, ApiError> {
    if value.len() == 10 {
        NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .map(|date| date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp())
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
    } else {
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|date| date.timestamp())
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
    }
}

fn counterpart<'a>(
    category: &str,
    line: &Line,
    overview: &'a Option<Overview>,
) -> Option<&'a Line> {
    use market_core::analysis::FlipItemIdentity;
    let identity = FlipItemIdentity::from_line(category, line);
    if category == "ClusterJewel" && identity.cluster_level.is_none() {
        return None;
    }
    let mut matches = overview
        .iter()
        .flat_map(|overview| &overview.lines)
        .filter(|candidate| FlipItemIdentity::from_line(category, candidate) == identity);
    let first = matches.next()?;
    matches.next().is_none().then_some(first)
}

pub(super) async fn ninja_prices(
    State(state): State<ServiceState>,
    Query(query): Query<PriceQuery>,
) -> Result<Json<Prices>, ApiError> {
    let source = query.source.as_deref().unwrap_or("stash");
    if !matches!(source, "exchange" | "stash") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Expected a poe.ninja source.".into(),
        ));
    }
    let overview = if query.date.is_empty() {
        state
            .economy_store
            .current_economy(&query.league, &query.category, source)
            .await
            .map_err(failure)?
            .ok_or((StatusCode::NOT_FOUND, "No saved poe.ninja overview.".into()))?
    } else {
        state
            .economy_store
            .historical_economy(&query.league, &query.category, source, &query.date)
            .await
            .map_err(failure)?
    };
    let selected_launch = league_start::lookup(&state, &query.league).await?;
    let current_launch = league_start::lookup(&state, &query.current_league).await?;
    let launch = selected_launch.start.ok_or((
        StatusCode::CONFLICT,
        "Selected league launch unavailable.".into(),
    ))?;
    let current_launch = current_launch.start.ok_or((
        StatusCode::CONFLICT,
        "Current league launch unavailable.".into(),
    ))?;
    let end = timestamp(&overview.fetched_at)?;
    let start = if query.item.is_some() {
        launch
    } else {
        (end - 7 * 86400).max(launch)
    };
    let date = |time: i64| {
        chrono::DateTime::from_timestamp(time, 0)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string()
    };
    let mut selected = state
        .economy_store
        .economy_price_histories(
            &query.league,
            &query.category,
            source,
            &date(start),
            &format!("{}~", date(end)),
            query.item.as_deref(),
        )
        .await
        .map_err(failure)?;
    let current_source = market_core::economy::categories()
        .into_iter()
        .find(|category| category.id == query.category)
        .and_then(|category| {
            if category.sources.iter().any(|mode| mode == source) {
                Some(source.to_owned())
            } else {
                category.sources.first().cloned()
            }
        })
        .unwrap_or_else(|| source.to_owned());
    let mut current_overview = state
        .economy_store
        .current_economy(&query.current_league, &query.category, &current_source)
        .await
        .map_err(failure)?;
    if current_overview.is_none() {
        let dates = state
            .economy_store
            .economy_dates(&query.current_league, &query.category, &current_source)
            .await
            .map_err(failure)?;
        if let Some(date) = dates.first() {
            current_overview = Some(
                state
                    .economy_store
                    .historical_economy(
                        &query.current_league,
                        &query.category,
                        &current_source,
                        date,
                    )
                    .await
                    .map_err(failure)?,
            );
        }
    }
    let current_item = query
        .item
        .as_ref()
        .and_then(|id| overview.lines.iter().find(|line| &line.id == id))
        .and_then(|line| {
            counterpart(&query.category, line, &current_overview).map(|line| line.id.as_str())
        });
    let mut current = if query.item.is_some() && current_item.is_none() {
        BTreeMap::new()
    } else {
        state
            .economy_store
            .economy_price_histories(
                &query.current_league,
                &query.category,
                &current_source,
                &date(current_launch + start - launch),
                &format!("{}~", date(current_launch + end - launch)),
                current_item,
            )
            .await
            .map_err(failure)?
    };
    let to_samples = |points: Vec<market_core::economy::Point>,
                      lower: i64,
                      upper: i64|
     -> Result<Vec<Sample>, ApiError> {
        points
            .into_iter()
            .filter(|point| point.currency == "Chaos Orb")
            .map(|point| {
                Ok(Sample {
                    time: timestamp(&point.date)?,
                    price: Some(point.price),
                    volume: point.volume,
                    granularity: point.granularity,
                })
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|samples| {
                samples
                    .into_iter()
                    .filter(|point| point.time >= lower && point.time <= upper)
                    .collect()
            })
    };
    let mut trends = HashMap::new();
    for line in &overview.lines {
        if query.item.as_ref().is_some_and(|id| id != &line.id) {
            continue;
        }
        let current_points = counterpart(&query.category, line, &current_overview)
            .and_then(|line| current.remove(&line.id))
            .unwrap_or_default();
        trends.insert(
            line.id.clone(),
            Trend {
                selected: to_samples(selected.remove(&line.id).unwrap_or_default(), start, end)?,
                current: to_samples(
                    current_points,
                    current_launch + start - launch,
                    current_launch + end - launch,
                )?,
            },
        );
    }
    let warnings = if selected_launch.approximate {
        vec!["Selected league launch is approximate; comparison uses saved dataset bounds.".into()]
    } else {
        vec![]
    };
    Ok(Json(Prices {
        overview,
        launch,
        current_launch,
        current_league: query.current_league,
        trends,
        warnings,
        collection: None,
        collection_error: None,
        dates: vec![],
    }))
}

pub(super) async fn prices(
    State(state): State<ServiceState>,
    Query(query): Query<PriceQuery>,
) -> Result<Json<Prices>, ApiError> {
    market_core::ggg::validate_league(&query.league)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    market_core::ggg::validate_league(&query.current_league)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    if !market_core::economy::categories().iter().any(|category| {
        category.id == query.category && category.sources.iter().any(|s| s == "exchange")
    }) {
        return Err((
            StatusCode::BAD_REQUEST,
            "GGG prices require an exchange category.".into(),
        ));
    }
    let now = Utc::now().timestamp().div_euclid(HOUR) * HOUR - HOUR;
    let before = if query.date.is_empty() {
        now
    } else {
        NaiveDate::parse_from_str(&query.date, "%Y-%m-%d")
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?
            .and_hms_opt(23, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp()
            .min(now)
    };
    let selected_launch = league_start::lookup(&state, &query.league).await?;
    let comparison = query
        .compare_league
        .as_deref()
        .unwrap_or(&query.current_league);
    market_core::ggg::validate_league(comparison)
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let current_launch = league_start::lookup(&state, comparison).await?;
    let launch = selected_launch.start.ok_or((
        StatusCode::CONFLICT,
        "Selected league launch unavailable.".into(),
    ))?;
    let current_launch_time = current_launch.start.ok_or((
        StatusCode::CONFLICT,
        "Current league launch unavailable.".into(),
    ))?;
    let latest = state
        .economy_store
        .latest_ggg_hour(&query.league, before)
        .await
        .map_err(failure)?;
    let end = latest.unwrap_or(before);
    let all_items = state
        .economy_store
        .ggg_items(&query.league, &query.category)
        .await
        .map_err(failure)?;
    let items = all_items
        .into_iter()
        .filter(|item| item.id != CHAOS && query.item.as_ref().is_none_or(|id| id == &item.id))
        .collect::<Vec<_>>();
    if query.item.is_some() && items.is_empty() {
        return Err((
            StatusCode::NOT_FOUND,
            "GGG item is not in this league/category.".into(),
        ));
    }
    let start = if query.item.is_some() {
        launch.div_euclid(HOUR) * HOUR
    } else {
        (end - 7 * 86400 + HOUR).max(launch.div_euclid(HOUR) * HOUR)
    };
    if end - start > 2 * 366 * 86400 {
        return Err((
            StatusCode::BAD_REQUEST,
            "GGG history exceeds two years.".into(),
        ));
    }
    let selected_markets = state
        .economy_store
        .ggg_price_markets(
            &query.league,
            start,
            end,
            &query.category,
            query.item.as_deref(),
        )
        .await
        .map_err(failure)?;
    let current_start = (current_launch_time + (start - launch)).div_euclid(HOUR) * HOUR;
    let current_end = (current_launch_time + (end - launch)).div_euclid(HOUR) * HOUR;
    let current_end = current_end.min(now);
    let current_markets = if query.league != comparison && current_end >= current_start {
        state
            .economy_store
            .ggg_price_markets(
                comparison,
                current_start,
                current_end,
                &query.category,
                query.item.as_deref(),
            )
            .await
            .map_err(failure)?
    } else {
        Vec::new()
    };
    let mut selected = hourly_samples(&selected_markets, &items, start, end);
    let mut current = if query.league == comparison {
        HashMap::new()
    } else {
        hourly_samples(&current_markets, &items, current_start, current_end)
    };
    let latest_markets = state
        .economy_store
        .ggg_markets(&query.league, end)
        .await
        .map_err(failure)?;
    let indexed = quotes(&latest_markets);
    let rates = chaos_rates(&indexed);
    let divine = rates
        .get("Metadata/Items/Currency/CurrencyModValues")
        .map(|rate| number(*rate));
    let mut trends = HashMap::new();
    let lines = items
        .into_iter()
        .map(|item| {
            let pair = preferred_pair(&indexed, &rates, &item.id).and_then(|pair| {
                Some((
                    number(pair.rate.checked_mul(rates[&pair.quote.id])?),
                    number(pair.volume),
                    pair.quote.name.clone(),
                    number(pair.rate),
                ))
            });
            let samples = selected.remove(&item.id).unwrap_or_default();
            let change = samples
                .first()
                .and_then(|first| first.price.as_ref())
                .and_then(|first| {
                    let first = first.parse::<rust_decimal::Decimal>().ok()?;
                    let last = pair.as_ref()?.0.parse::<rust_decimal::Decimal>().ok()?;
                    last.checked_sub(first)?
                        .checked_div(first)?
                        .checked_mul(rust_decimal::Decimal::ONE_HUNDRED)
                        .map(number)
                });
            trends.insert(
                item.id.clone(),
                Trend {
                    selected: samples,
                    current: current.remove(&item.id).unwrap_or_default(),
                },
            );
            Line {
                id: item.id,
                name: item.name,
                icon: item.icon,
                price: pair.as_ref().map(|p| p.0.clone()),
                volume: pair.as_ref().map(|p| p.1.clone()),
                pair: pair.as_ref().map(|p| p.2.clone()),
                pair_rate: pair.as_ref().map(|p| p.3.clone()),
                change,
                ..Default::default()
            }
        })
        .collect();
    let mut warnings = vec!["GGG traded hourly prices and item-unit volume. Missing prices/conversions remain gaps; no poe.ninja substitution.".into()];
    if latest.is_none() {
        warnings.push("No completed GGG hours saved for this league/date yet.".into());
    }
    if selected_launch.approximate || current_launch.approximate {
        warnings.push(
            "League-age alignment is approximate because a published launch is unavailable.".into(),
        );
    }
    let (collection, collection_error) =
        crate::ggg::collection_status(&state, &query.current_league).await;
    let target_launch = league_start::lookup(&state, &query.current_league).await?;
    let collection_start = target_launch
        .start
        .ok_or((
            StatusCode::CONFLICT,
            "Target league launch unavailable.".into(),
        ))?
        .div_euclid(HOUR)
        * HOUR;
    let collection = if now >= collection_start && now - collection_start <= 2 * 366 * 86400 {
        Some(
            crate::ggg::archive_status(
                &state,
                &crate::ggg::Range {
                    league: query.current_league.clone(),
                    start: collection_start,
                    end: now,
                },
            )
            .await?,
        )
    } else {
        collection
    };
    let dates = state
        .economy_store
        .ggg_dates(&query.league)
        .await
        .map_err(failure)?;
    Ok(Json(Prices {
        overview: Overview {
            league: query.league,
            category: query.category,
            source: "ggg".into(),
            fetched_at: utc_hour(end),
            quote_currency: "Chaos Orb".into(),
            rates: divine
                .map(|value| BTreeMap::from([("Divine Orb".into(), value)]))
                .unwrap_or_default(),
            lines,
        },
        launch,
        current_launch: current_launch_time,
        current_league: comparison.to_owned(),
        trends,
        warnings,
        collection,
        collection_error,
        dates,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn collection_completion_is_visible_from_saved_empty_hours_without_an_in_memory_job() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("test.sqlite3");
        let store = market_store::SqliteStore::connect(&path).await.unwrap();
        let end = Utc::now().timestamp().div_euclid(HOUR) * HOUR - HOUR;
        store
            .save_league_launch("Test", end - HOUR, "GGG")
            .await
            .unwrap();
        for hour in [end - HOUR, end] {
            let page = serde_json::from_value(
                serde_json::json!({"next_change_id":hour+HOUR,"markets":[]}),
            )
            .unwrap();
            store.record_ggg_hour("Test", hour, &page).await.unwrap();
        }
        store
            .save_league_launch("Old", end - 24 * HOUR, "GGG")
            .await
            .unwrap();
        drop(store);
        let store = market_store::SqliteStore::connect(&path).await.unwrap();
        let (sender, _) = tokio::sync::watch::channel(None);
        let state = ServiceState::new(store, "test", sender);
        let result = prices(
            State(state.clone()),
            Query(PriceQuery {
                league: "Test".into(),
                current_league: "Test".into(),
                category: "Currency".into(),
                date: String::new(),
                item: None,
                source: None,
                compare_league: None,
            }),
        )
        .await
        .unwrap()
        .0;
        let collection = result.collection.unwrap();
        assert_eq!(collection.status, "completed");
        assert_eq!(collection.completed_hours, 2);
        assert_eq!(collection.total_hours, 2);
        assert!(result.overview.lines.is_empty());
        let compared = prices(
            State(state),
            Query(PriceQuery {
                league: "Test".into(),
                current_league: "Test".into(),
                compare_league: Some("Old".into()),
                category: "Currency".into(),
                date: String::new(),
                item: None,
                source: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(compared.overview.league, "Test");
        assert_eq!(compared.current_league, "Old");
        assert_eq!(compared.current_launch, end - 24 * HOUR);
        assert_eq!(compared.collection.unwrap().total_hours, 2);
    }

    #[tokio::test]
    async fn ninja_comparisons_match_variants_across_ids_and_preserve_daily_granularity() {
        let directory = tempfile::tempdir().unwrap();
        let store = market_store::SqliteStore::connect(directory.path().join("test.sqlite3"))
            .await
            .unwrap();
        store.save_league_launch("Old", 0, "GGG").await.unwrap();
        store.save_league_launch("New", 86400, "GGG").await.unwrap();
        let old = Line {
            id: "archive-id".into(),
            name: "Fireball".into(),
            gem_level: Some(20),
            price: Some("10".into()),
            ..Default::default()
        };
        store
            .save_observations(
                "Old",
                "stash",
                &[market_core::economy::Observation {
                    category: "SkillGem".into(),
                    line: old.clone(),
                    point: market_core::economy::Point {
                        date: "1970-01-01".into(),
                        price: "10".into(),
                        currency: "Chaos Orb".into(),
                        granularity: "daily".into(),
                        volume: None,
                        confidence: None,
                    },
                }],
                None,
            )
            .await
            .unwrap();
        let new = Line {
            id: "live-id".into(),
            price: Some("100".into()),
            volume: Some("20".into()),
            ..old.clone()
        };
        let different = Line {
            id: "different-level".into(),
            gem_level: Some(21),
            ..new.clone()
        };
        store
            .save_economy(&Overview {
                league: "New".into(),
                category: "SkillGem".into(),
                source: "stash".into(),
                fetched_at: "1970-01-02T00:00:00Z".into(),
                quote_currency: "Chaos Orb".into(),
                rates: BTreeMap::new(),
                lines: vec![new, different],
            })
            .await
            .unwrap();
        let (sender, _) = tokio::sync::watch::channel(None);
        let state = ServiceState::new(store, "test", sender);
        for item in [None, Some("archive-id".to_owned())] {
            let result = ninja_prices(
                State(state.clone()),
                Query(PriceQuery {
                    league: "Old".into(),
                    current_league: "New".into(),
                    category: "SkillGem".into(),
                    date: "1970-01-01".into(),
                    source: Some("stash".into()),
                    compare_league: None,
                    item,
                }),
            )
            .await
            .unwrap()
            .0;
            let trend = &result.trends["archive-id"];
            assert_eq!(trend.selected.len(), 1);
            assert_eq!(trend.selected[0].granularity, "daily");
            assert_eq!(trend.current.len(), 1);
            assert_eq!(trend.current[0].price.as_deref(), Some("100"));
            assert_eq!(trend.current[0].granularity, "snapshot");
            assert_eq!(trend.current[0].volume.as_deref(), Some("20"));
        }
        let reversed = ninja_prices(
            State(state),
            Query(PriceQuery {
                league: "New".into(),
                current_league: "Old".into(),
                compare_league: None,
                category: "SkillGem".into(),
                date: String::new(),
                source: Some("stash".into()),
                item: Some("live-id".into()),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(reversed.overview.league, "New");
        assert_eq!(
            reversed.trends["live-id"].selected[0].price.as_deref(),
            Some("100")
        );
        assert_eq!(
            reversed.trends["live-id"].current[0].price.as_deref(),
            Some("10")
        );
        assert_eq!(reversed.trends["live-id"].current[0].granularity, "daily");
    }

    #[tokio::test]
    async fn canonical_sql_matches_decimal_pair_selection_without_cross_hour_conversions() {
        let directory = tempfile::tempdir().unwrap();
        let store = market_store::SqliteStore::connect(directory.path().join("test.sqlite3"))
            .await
            .unwrap();
        store
            .save_ggg_fallback_items(&["oil", "divine", CHAOS].map(|id| Item {
                id: id.into(),
                name: id.into(),
                category: if id == "oil" { "Oil" } else { "Currency" }.into(),
                icon: None,
            }))
            .await
            .unwrap();
        let fixtures = [
            vec![
                ("oil", CHAOS, 10, 100),
                ("oil", "divine", 100, 2),
                ("divine", CHAOS, 1, 200),
            ],
            vec![("oil", "divine", 100, 2)],
            vec![("oil", "divine", 100, 2), ("divine", CHAOS, 1, 300)],
            vec![
                ("oil", CHAOS, 0, 0),
                ("oil", "divine", 100, 2),
                ("divine", CHAOS, 1, 200),
            ],
        ];
        for (index, entries) in fixtures.iter().enumerate() {
            let hour = index as i64 * HOUR;
            let markets = entries.iter().map(|(a,b,va,vb)| {
                let values = serde_json::json!({(*a):*va,(*b):*vb});
                serde_json::json!({"league":"Test","market_id":format!("{a}|{b}"),"market_pair":[a,b],
                    "volume_traded":values,"lowest_stock":values,"highest_stock":values,"lowest_ratio":values,"highest_ratio":values})
            }).collect::<Vec<_>>();
            let page = serde_json::from_value(
                serde_json::json!({"next_change_id":hour+HOUR,"markets":markets}),
            )
            .unwrap();
            store.record_ggg_hour("Test", hour, &page).await.unwrap();
            let raw = store.ggg_markets("Test", hour).await.unwrap();
            for item in [None, Some("oil")] {
                let canonical = store
                    .ggg_price_markets("Test", hour, hour, "Oil", item)
                    .await
                    .unwrap();
                assert!(canonical.len() <= 2);
                assert_eq!(
                    selected_pair(&raw, "oil"),
                    selected_pair(
                        &canonical
                            .into_iter()
                            .map(|(_, market)| market)
                            .collect::<Vec<_>>(),
                        "oil"
                    )
                );
            }
        }
        assert!(store
            .ggg_price_markets("Test", HOUR, HOUR, "Oil", None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn prices_use_economy_database_and_latest_complete_hour_without_per_item_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let store = market_store::SqliteStore::connect(directory.path().join("main.sqlite3"))
            .await
            .unwrap();
        let economy = market_store::SqliteStore::connect(directory.path().join("economy.sqlite3"))
            .await
            .unwrap();
        economy
            .save_league_launch("Test", HOUR, "GGG")
            .await
            .unwrap();
        let oil = "Metadata/Items/Currency/OilGold";
        economy
            .save_ggg_fallback_items(&[
                Item {
                    id: oil.into(),
                    name: "Golden Oil".into(),
                    category: "Oil".into(),
                    icon: None,
                },
                Item {
                    id: CHAOS.into(),
                    name: "Chaos Orb".into(),
                    category: "Currency".into(),
                    icon: None,
                },
            ])
            .await
            .unwrap();
        let page = serde_json::from_value(serde_json::json!({
            "next_change_id": HOUR * 2,
            "markets": [{"league":"Test","market_id":"oil-chaos","market_pair":[oil, CHAOS],
                "volume_traded":{oil:10,CHAOS:100},
                "lowest_stock":{oil:1,CHAOS:1},"highest_stock":{oil:1,CHAOS:1},
                "lowest_ratio":{oil:1,CHAOS:1},"highest_ratio":{oil:1,CHAOS:1}}]
        }))
        .unwrap();
        economy.record_ggg_hour("Test", HOUR, &page).await.unwrap();
        let (_sender, _) = tokio::sync::watch::channel(None);
        let state =
            ServiceState::new(store.clone(), "test", _sender).with_economy_store(economy.clone());
        let query = || {
            Query(PriceQuery {
                league: "Test".into(),
                current_league: "Test".into(),
                category: "Oil".into(),
                date: String::new(),
                item: None,
                source: None,
                compare_league: None,
            })
        };
        let result = prices(State(state.clone()), query()).await.unwrap().0;
        assert_eq!(result.overview.lines[0].price.as_deref(), Some("10"));
        assert_eq!(result.overview.lines[0].volume.as_deref(), Some("10"));
        assert_eq!(result.overview.source, "ggg");
        assert!(store
            .latest_ggg_hour("Test", HOUR * 2)
            .await
            .unwrap()
            .is_none());
        let empty =
            serde_json::from_value(serde_json::json!({"next_change_id":HOUR * 3,"markets":[]}))
                .unwrap();
        economy
            .record_ggg_hour("Test", HOUR * 2, &empty)
            .await
            .unwrap();
        let result = prices(State(state), query()).await.unwrap().0;
        assert!(result.overview.lines[0].price.is_none());
        assert_eq!(result.trends[oil].selected.last().unwrap().price, None);
        assert_eq!(result.overview.fetched_at, utc_hour(HOUR * 2));
    }

    #[test]
    fn hourly_quotes_prefer_chaos_and_do_not_fill_missing_prices() {
        let item = |id: &str| Item {
            id: id.into(),
            name: id.into(),
            category: "Currency".into(),
            icon: None,
        };
        let market = |a: &str, b: &str, va: &str, vb: &str| Market {
            id: format!("{a}|{b}"),
            a: item(a),
            b: item(b),
            volume_a: va.into(),
            volume_b: vb.into(),
            low_stock_a: "0".into(),
            low_stock_b: "0".into(),
            high_stock_a: "0".into(),
            high_stock_b: "0".into(),
            low_ratio_a: "1".into(),
            low_ratio_b: "1".into(),
            high_ratio_a: "1".into(),
            high_ratio_b: "1".into(),
        };
        let markets = vec![
            market("oil", CHAOS, "10", "100"),
            market("oil", "divine", "100", "2"),
            market("divine", CHAOS, "1", "200"),
        ];
        assert_eq!(selected_pair(&markets, "oil").unwrap().0, "10");
        assert_eq!(selected_pair(&markets[1..], "oil").unwrap().0, "4");
        let samples = hourly_samples(
            &markets.into_iter().map(|m| (3600, m)).collect::<Vec<_>>(),
            &[item("oil")],
            3600,
            10800,
        );
        assert_eq!(samples["oil"][0].price.as_deref(), Some("10"));
        assert_eq!(samples["oil"][1].price, None);
        assert_eq!(samples["oil"][2].volume, None);
    }
}
