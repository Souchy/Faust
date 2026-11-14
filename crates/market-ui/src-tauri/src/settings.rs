use std::{collections::BTreeMap, fs, io, path::Path};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ClientSettings(Mutex<()>);

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Period {
    start: i64,
    end: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    viewport: Option<Viewport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    filters: Option<Filters>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Viewport {
    start: f64,
    end: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Filters {
    min_price: String,
    max_price: String,
    min_volume: String,
    min_confidence: String,
    strict_start: bool,
    search: String,
    category: String,
    venue: String,
    sort: String,
    presence: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Settings {
    #[serde(default)]
    flip_periods: BTreeMap<String, Period>,
    #[serde(default)]
    compare_league: String,
    #[serde(flatten)]
    other: BTreeMap<String, serde_json::Value>,
}

fn validate(league: &str, period: &Period) -> io::Result<()> {
    if league.trim().is_empty()
        || league.len() > 200
        || period.start < 0
        || period.start >= period.end
        || period.start % 3600 != 0
        || period.end % 3600 != 0
        || period.end > 8_640_000_000_000
        || period.viewport.as_ref().is_some_and(|view| {
            !view.start.is_finite()
                || !view.end.is_finite()
                || view.start < 0.0
                || view.start >= view.end
                || view.end > 8_640_000_000_000.0
        })
        || period.filters.as_ref().is_some_and(|filters| {
            !matches!(
                filters.presence.as_str(),
                "" | "observed" | "not_observed" | "unknown" | "ambiguous"
            ) || !matches!(
                filters.sort.as_str(),
                "percent-desc" | "percent-asc" | "value-desc" | "value-asc"
            ) || !matches!(
                filters.min_confidence.as_str(),
                "" | "Low" | "Medium" | "High"
            ) || !matches!(filters.venue.as_str(), "" | "exchange" | "trade")
        })
    {
        return Err(io::Error::other(
            "Invalid league or Flip period timestamps.",
        ));
    }
    Ok(())
}

fn read(path: &Path) -> io::Result<Settings> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(error) => return Err(error),
    };
    let settings: Settings = serde_json::from_slice(&bytes)?;
    for (league, period) in &settings.flip_periods {
        validate(league, period)?;
    }
    validate_compare(&settings.compare_league)?;
    Ok(settings)
}

fn validate_compare(league: &str) -> io::Result<()> {
    if league.len() > 200 || (!league.is_empty() && league.trim() != league) {
        return Err(io::Error::other("Invalid Compare league."));
    }
    Ok(())
}

fn save(path: &Path, league: String, period: Period) -> io::Result<()> {
    validate(&league, &period)?;
    let mut settings = read(path)?;
    settings.flip_periods.insert(league, period);
    write(path, &settings)
}

fn save_compare(path: &Path, league: String) -> io::Result<()> {
    validate_compare(&league)?;
    let mut settings = read(path)?;
    settings.compare_league = league;
    write(path, &settings)
}

fn write(path: &Path, settings: &Settings) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Settings directory is missing."))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(temporary.as_file_mut(), settings)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[tauri::command]
pub async fn load_compare_league(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(report)?
        .join("faust.settings.json");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClientSettings>();
        let _guard = state.0.blocking_lock();
        Ok::<_, io::Error>(read(&path)?.compare_league)
    })
    .await
    .map_err(report)?
    .map_err(report)
}

#[tauri::command]
pub async fn save_compare_league(app: tauri::AppHandle, league: String) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(report)?
        .join("faust.settings.json");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClientSettings>();
        let _guard = state.0.blocking_lock();
        save_compare(&path, league)
    })
    .await
    .map_err(report)?
    .map_err(report)
}

fn report(error: impl std::fmt::Display) -> String {
    eprintln!("Client settings: {error}");
    error.to_string()
}

#[tauri::command]
pub async fn load_flip_period(
    app: tauri::AppHandle,
    league: String,
) -> Result<Option<Period>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(report)?
        .join("faust.settings.json");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClientSettings>();
        let _guard = state.0.blocking_lock();
        Ok::<_, io::Error>(read(&path)?.flip_periods.get(&league).cloned())
    })
    .await
    .map_err(report)?
    .map_err(report)
}

#[tauri::command]
pub async fn save_flip_period(
    app: tauri::AppHandle,
    league: String,
    period: Period,
) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(report)?
        .join("faust.settings.json");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClientSettings>();
        let _guard = state.0.blocking_lock();
        save(&path, league, period)
    })
    .await
    .map_err(report)?
    .map_err(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_selection_survives_reopen_and_preserves_periods() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        assert_eq!(read(&path).unwrap().compare_league, "");
        save(
            &path,
            "Old".into(),
            Period {
                start: 0,
                end: 3600,
                ..Default::default()
            },
        )
        .unwrap();
        save_compare(&path, "Old".into()).unwrap();
        assert_eq!(read(&path).unwrap().compare_league, "Old");
        save_compare(&path, "".into()).unwrap();
        let settings = read(&path).unwrap();
        assert_eq!(settings.compare_league, "");
        assert_eq!(settings.flip_periods["Old"].end, 3600);
        assert!(save_compare(&path, " invalid ".into()).is_err());
        assert_eq!(read(&path).unwrap().compare_league, "");
    }

    #[test]
    fn legacy_periods_migrate_and_zoom_and_filters_survive_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("faust.settings.json");
        fs::write(
            &path,
            r#"{"flip_periods":{"Standard":{"start":0,"end":3600}}}"#,
        )
        .unwrap();
        assert!(read(&path).unwrap().flip_periods["Standard"]
            .viewport
            .is_none());
        let value = serde_json::json!({
            "start": 0, "end": 3600, "viewport": { "start": 123.5, "end": 3456.7 },
            "filters": { "minPrice": "1", "maxPrice": "10", "minVolume": "20",
                "minConfidence": "High", "strictStart": true, "search": "oil", "category": "Oil",
                "venue": "trade", "sort": "value-asc", "presence": "observed" }
        });
        let selection: Period = serde_json::from_value(value.clone()).unwrap();
        save(&path, "Standard".into(), selection).unwrap();
        let reopened = read(&path).unwrap();
        assert_eq!(
            serde_json::to_value(&reopened.flip_periods["Standard"]).unwrap(),
            value
        );
        let original = fs::read(&path).unwrap();
        let mut invalid = reopened.flip_periods["Standard"].clone();
        invalid.viewport = Some(Viewport {
            start: 5.0,
            end: 2.0,
        });
        assert!(save(&path, "Standard".into(), invalid).is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }

    #[test]
    fn client_file_survives_reopen_and_preserves_other_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config").join("faust.settings.json");
        assert!(read(&path).unwrap().flip_periods.is_empty());
        save(
            &path,
            "Standard".into(),
            Period {
                start: 0,
                end: 3600,
                ..Default::default()
            },
        )
        .unwrap();
        let mut existing = read(&path).unwrap();
        existing
            .other
            .insert("theme".into(), serde_json::json!("dark"));
        fs::write(&path, serde_json::to_vec(&existing).unwrap()).unwrap();
        save(
            &path,
            "Mirage".into(),
            Period {
                start: 7200,
                end: 10800,
                ..Default::default()
            },
        )
        .unwrap();
        save(
            &path,
            "Standard".into(),
            Period {
                start: 3600,
                end: 7200,
                ..Default::default()
            },
        )
        .unwrap();
        let reopened = read(&path).unwrap();
        assert_eq!(reopened.other["theme"], "dark");
        assert_eq!(
            reopened.flip_periods["Standard"],
            Period {
                start: 3600,
                end: 7200,
                ..Default::default()
            }
        );
        assert_eq!(
            reopened.flip_periods["Mirage"],
            Period {
                start: 7200,
                end: 10800,
                ..Default::default()
            }
        );
    }

    #[test]
    fn bad_settings_and_invalid_edits_are_not_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("faust.settings.json");
        assert!(save(
            &path,
            "Standard".into(),
            Period {
                start: 1,
                end: 3600,
                ..Default::default()
            }
        )
        .is_err());
        assert!(!path.exists());
        fs::write(&path, "broken JSON").unwrap();
        assert!(save(
            &path,
            "Standard".into(),
            Period {
                start: 0,
                end: 3600,
                ..Default::default()
            }
        )
        .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken JSON");
    }
}
