//! Local storage for third-party API keys (OpenAI, Google, Anthropic, ElevenLabs…).
//!
//! Keys live in `api_keys.json` inside the app's config directory, never in the
//! project file and never in the frontend bundle. The frontend can only ask which
//! providers have a key (`list_api_key_providers`); the key values themselves are
//! read by Rust code that talks to the provider (`read_api_key`).
//! NOTE: the file is plain text protected by the user's OS profile permissions —
//! move to the OS credential vault before distributing the app widely.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn keys_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("No config dir: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {}", e))?;
    Ok(dir.join("api_keys.json"))
}

fn load(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = keys_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("Corrupt api_keys.json: {}", e)),
        Err(_) => Ok(BTreeMap::new()),
    }
}

fn save(app: &tauri::AppHandle, keys: &BTreeMap<String, String>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(keys).map_err(|e| e.to_string())?;
    fs::write(keys_path(app)?, text).map_err(|e| format!("Cannot write api_keys.json: {}", e))
}

/// Providers are free-form ids ("openai", "google", "anthropic", "elevenlabs").
fn valid_provider(provider: &str) -> bool {
    !provider.is_empty() && provider.len() <= 32 && provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Used by Rust-side provider calls. Not exposed as a command on purpose.
#[allow(dead_code)]
pub fn read_api_key(app: &tauri::AppHandle, provider: &str) -> Result<String, String> {
    load(app)?.get(provider).cloned().ok_or_else(|| format!("No API key saved for '{}'", provider))
}

#[tauri::command]
pub fn set_api_key(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String> {
    if !valid_provider(&provider) {
        return Err("Invalid provider id".to_string());
    }
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    let mut keys = load(&app)?;
    keys.insert(provider, key);
    save(&app, &keys)
}

#[tauri::command]
pub fn delete_api_key(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let mut keys = load(&app)?;
    keys.remove(&provider);
    save(&app, &keys)
}

/// Provider ids that have a saved key (values are never returned).
#[tauri::command]
pub fn list_api_key_providers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load(&app)?.into_keys().collect())
}
