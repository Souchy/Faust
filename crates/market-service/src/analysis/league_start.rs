use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::{ApiError, failure};
use crate::ServiceState;

#[derive(Default)]
pub(crate) struct LeagueStarts(pub Mutex<HashMap<String, (Instant, LeagueStart)>>);

#[derive(Clone, Serialize)]
pub(crate) struct LeagueStart {
    league: String,
    pub(crate) start: Option<i64>,
    pub(crate) approximate: bool,
}

#[derive(Deserialize)]
pub(crate) struct LeagueQuery {
    league: String,
}

#[derive(Deserialize)]
struct OfficialLeague {
    id: String,
    #[serde(rename = "startAt")]
    start: Option<DateTime<Utc>>,
}

pub(super) async fn league_start(
    State(state): State<ServiceState>,
    Query(query): Query<LeagueQuery>,
) -> Result<Json<LeagueStart>, ApiError> {
    lookup(&state, &query.league).await.map(Json)
}

pub(crate) async fn lookup(state: &ServiceState, league: &str) -> Result<LeagueStart, ApiError> {
    let query = LeagueQuery {
        league: league.into(),
    };
    market_core::ggg::validate_league(&query.league)
        .map_err(|error| (StatusCode::BAD_REQUEST, error))?;
    let mut cache = state.league_starts.0.lock().await;
    if let Some((checked, value)) = cache.get(&query.league)
        && checked.elapsed() < Duration::from_secs(3600)
    {
        return Ok(value.clone());
    }
    if let Some(start) = state
        .economy_store
        .league_launch(&query.league)
        .await
        .map_err(failure)?
    {
        return Ok(LeagueStart {
            league: query.league,
            start: Some(start),
            approximate: false,
        });
    }
    let mut url =
        reqwest::Url::parse("https://www.pathofexile.com/api/leagues/").map_err(failure)?;
    url.path_segments_mut()
        .expect("hierarchical URL")
        .pop_if_empty()
        .push(&query.league);
    url.query_pairs_mut().append_pair("compact", "1");
    let client = reqwest::Client::builder()
        .user_agent(state.user_agent.as_ref())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(failure)?;
    let response = client.get(url).send().await.map_err(failure)?;
    let official = if response.status() == StatusCode::NOT_FOUND {
        None
    } else {
        let official: OfficialLeague = response
            .error_for_status()
            .map_err(failure)?
            .json()
            .await
            .map_err(failure)?;
        if official.id != query.league {
            return Err(failure(
                "Official league metadata belongs to a different league.",
            ));
        }
        official.start.map(|start| start.timestamp())
    };
    let (published, source) = if official.is_some() {
        (official, "GGG")
    } else {
        (wiki_start(&client, &query.league).await?, "PoE Wiki")
    };
    if let Some(start) = published {
        state
            .economy_store
            .save_league_launch(&query.league, start, source)
            .await
            .map_err(failure)?;
    }
    let result = resolve_start(state, &query.league, published).await?;
    // Coverage can change during imports; cache only authoritative launch timestamps.
    if !result.approximate {
        cache.insert(query.league, (Instant::now(), result.clone()));
    }
    Ok(result)
}

async fn wiki_start(client: &reqwest::Client, league: &str) -> Result<Option<i64>, ApiError> {
    let title = format!("{}_league", league.replace(' ', "_"));
    let response: serde_json::Value = client
        .get("https://www.poewiki.net/w/api.php")
        .query(&[
            ("action", "query"),
            ("prop", "revisions"),
            ("titles", title.as_str()),
            ("rvprop", "content"),
            ("rvslots", "main"),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(failure)?
        .error_for_status()
        .map_err(failure)?
        .json()
        .await
        .map_err(failure)?;
    parse_wiki_start(&response, league)
}

fn parse_wiki_start(response: &serde_json::Value, league: &str) -> Result<Option<i64>, ApiError> {
    let pages = response
        .pointer("/query/pages")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| failure("Wiki launch metadata has no pages."))?;
    for page in pages.values() {
        if page.get("missing").is_some() {
            continue;
        }
        let content = page
            .pointer("/revisions/0/slots/main/*")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| failure("Wiki launch metadata has no revision content."))?;
        let field = |key: &str| {
            content.lines().find_map(|line| {
                let (name, value) = line.trim().strip_prefix('|')?.split_once('=')?;
                (name.trim() == key).then(|| value.trim())
            })
        };
        if !field("id").is_some_and(|ids| ids.split(',').any(|id| id.trim() == league)) {
            return Err(failure(
                "Wiki launch metadata does not identify the requested league.",
            ));
        }
        if let Some(date) = field("release_date") {
            return DateTime::parse_from_rfc3339(date)
                .map(|date| Some(date.timestamp()))
                .map_err(|error| failure(format!("Invalid wiki release datetime: {error}")));
        }
    }
    Ok(None)
}

async fn resolve_start(
    state: &ServiceState,
    league: &str,
    official: Option<i64>,
) -> Result<LeagueStart, ApiError> {
    Ok(if let Some(start) = official {
        LeagueStart {
            league: league.into(),
            start: Some(start),
            approximate: false,
        }
    } else {
        let period = state
            .economy_store
            .analysis_period(league)
            .await
            .map_err(failure)?;
        LeagueStart {
            league: league.into(),
            start: period.start,
            approximate: true,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    #[test]
    fn wiki_release_requires_exact_league_identity_and_explicit_timezone() {
        let response = |text: &str| {
            serde_json::json!({"query":{"pages":{"42":{
                "revisions":[{"slots":{"main":{"*":text}}}]
            }}}})
        };
        let text =
            "{{Event\n| release_date = 2026-07-24T18:00:00Z\n| id = Archive, Hardcore Archive\n}}";
        assert_eq!(
            parse_wiki_start(&response(text), "Archive").unwrap(),
            Some(1_784_916_000)
        );
        assert!(parse_wiki_start(&response(text), "Other").is_err());
        assert!(
            parse_wiki_start(
                &response(&text.replace("T18:00:00Z", " 18:00:00")),
                "Archive"
            )
            .is_err()
        );
        assert_eq!(
            parse_wiki_start(
                &serde_json::json!({"query":{"pages":{"-1":{"missing":""}}}}),
                "Missing"
            )
            .unwrap(),
            None
        );
        assert!(
            parse_wiki_start(
                &serde_json::json!({"error":{"info":"rate limited"}}),
                "Archive"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn official_launch_is_exact_and_missing_launch_uses_economy_database_coverage() {
        let directory = tempfile::tempdir().unwrap();
        let store = market_store::SqliteStore::connect(directory.path().join("main.sqlite3"))
            .await
            .unwrap();
        let economy = market_store::SqliteStore::connect(directory.path().join("economy.sqlite3"))
            .await
            .unwrap();
        economy
            .save_observations(
                "Archive",
                "stash",
                &[market_core::economy::Observation {
                    category: "Currency".into(),
                    line: market_core::economy::Line {
                        id: "divine".into(),
                        name: "Divine Orb".into(),
                        ..Default::default()
                    },
                    point: market_core::economy::Point {
                        date: "2026-01-01".into(),
                        price: "100".into(),
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
        let (selection, _) = tokio::sync::watch::channel(None);
        let state = ServiceState::new(store, "Test", selection).with_economy_store(economy);
        let official: OfficialLeague =
            serde_json::from_str(r#"{"id":"Current","startAt":"2026-11-13T19:00:00Z"}"#).unwrap();
        let launch = resolve_start(
            &state,
            "Current",
            official.start.map(|start| start.timestamp()),
        )
        .await
        .unwrap();
        assert_eq!(launch.start, Some(1_794_596_400));
        assert!(!launch.approximate);
        let fallback = resolve_start(&state, "Archive", None).await.unwrap();
        assert!(fallback.approximate);
        assert_eq!(fallback.start, Some(1_767_225_600));
        state
            .economy_store
            .save_league_launch("Archive", 1_767_222_000, "PoE Wiki")
            .await
            .unwrap();
        let corrected = state
            .economy_store
            .analysis_period("Archive")
            .await
            .unwrap();
        assert_eq!(corrected.start, Some(1_767_222_000));
        assert_eq!(corrected.bounds_source, "published");
        assert_eq!(corrected.days, vec!["2026-01-01"]);
        let saved = lookup(&state, "Archive").await.unwrap();
        assert_eq!(saved.start, corrected.start);
        assert!(!saved.approximate);
        let missing = resolve_start(&state, "Missing", None).await.unwrap();
        assert_eq!(missing.start, None);
        state
            .league_starts
            .0
            .lock()
            .await
            .insert("Current".into(), (Instant::now(), launch));
        let response = crate::router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/analysis/league-start?league=Current")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["approximate"], false);
        assert_eq!(body["league"], "Current");
    }
}
