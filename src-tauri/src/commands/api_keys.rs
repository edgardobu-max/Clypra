//! Local storage for third-party API keys (OpenAI, Google, Anthropic, ElevenLabs...).
//!
//! Keys live in the operating system's credential vault (Windows Credential Manager,
//! macOS Keychain, Secret Service on Linux) through the `keyring` crate — never in the
//! project file, never in the frontend bundle and no longer in a plain-text file. The
//! frontend can only ask which providers have a key (`list_api_key_providers`); the key
//! values themselves are read by Rust code that talks to the provider (`read_api_key`).
//!
//! Older builds stored keys in `api_keys.json` in the app config folder. That file is
//! imported into the vault the first time any command runs, then deleted.

use keyring::Entry;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const SERVICE: &str = "com.clypra.editor";

/// Providers the UI can store keys for. The vault cannot be enumerated, so listing probes these.
const KNOWN_PROVIDERS: [&str; 4] = ["openai", "google", "anthropic", "elevenlabs"];

/// Providers are free-form ids ("openai", "google", "anthropic", "elevenlabs").
fn valid_provider(provider: &str) -> bool {
    !provider.is_empty() && provider.len() <= 32 && provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn entry(provider: &str) -> Result<Entry, String> {
    if !valid_provider(provider) {
        return Err("Invalid provider id".to_string());
    }
    Entry::new(SERVICE, &format!("api-key:{}", provider)).map_err(|e| format!("Credential vault unavailable: {}", e))
}

fn legacy_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("api_keys.json"))
}

/// Moves keys from the old plain-text file into the vault, then deletes the file.
/// The file is only deleted when every key was stored successfully.
fn migrate_legacy_file(app: &tauri::AppHandle) {
    let Some(path) = legacy_file(app) else { return };
    let Ok(text) = fs::read_to_string(&path) else { return };
    let Ok(keys) = serde_json::from_str::<BTreeMap<String, String>>(&text) else { return };

    let mut all_ok = true;
    for (provider, key) in &keys {
        match entry(provider).and_then(|e| e.set_password(key).map_err(|e| e.to_string())) {
            Ok(()) => {}
            Err(e) => {
                all_ok = false;
                eprintln!("[api_keys] could not migrate '{}' to the vault: {}", provider, e);
            }
        }
    }
    if all_ok {
        match fs::remove_file(&path) {
            Ok(()) => eprintln!("[api_keys] migrated {} key(s) from api_keys.json into the OS vault and deleted the file", keys.len()),
            Err(e) => eprintln!("[api_keys] migrated keys but could not delete {}: {}", path.display(), e),
        }
    }
}

/// Used by Rust-side provider calls. Not exposed as a command on purpose.
#[allow(dead_code)]
pub fn read_api_key(app: &tauri::AppHandle, provider: &str) -> Result<String, String> {
    migrate_legacy_file(app);
    entry(provider)?.get_password().map_err(|_| format!("No API key saved for '{}'", provider))
}

#[tauri::command]
pub fn set_api_key(app: tauri::AppHandle, provider: String, key: String) -> Result<(), String> {
    migrate_legacy_file(&app);
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    entry(&provider)?.set_password(&key).map_err(|e| format!("Could not save the key in the credential vault: {}", e))
}

#[tauri::command]
pub fn delete_api_key(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    migrate_legacy_file(&app);
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the key: {}", e)),
    }
}

/// Provider ids that have a saved key (values are never returned).
#[tauri::command]
pub fn list_api_key_providers(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    migrate_legacy_file(&app);
    Ok(KNOWN_PROVIDERS
        .iter()
        .filter(|p| entry(p).ok().and_then(|e| e.get_password().ok()).is_some())
        .map(|p| p.to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_validated() {
        assert!(valid_provider("openai"));
        assert!(valid_provider("eleven-labs2"));
        assert!(!valid_provider(""));
        assert!(!valid_provider("Open AI"));
        assert!(!valid_provider("../x"));
        assert!(entry("../x").is_err());
    }

    /// Round-trip through the real OS vault. Uses a throwaway provider id and cleans up after itself;
    /// skipped quietly when no vault is available (e.g. a headless CI box).
    #[test]
    fn vault_round_trip_set_read_delete() {
        let provider = format!("test-{}", std::process::id());
        let Ok(e) = entry(&provider) else {
            eprintln!("SKIPPED: credential vault unavailable");
            return;
        };
        if e.set_password("secret-value-123").is_err() {
            eprintln!("SKIPPED: credential vault not writable");
            return;
        }
        assert_eq!(e.get_password().unwrap(), "secret-value-123");
        e.delete_credential().unwrap();
        assert!(matches!(e.get_password(), Err(keyring::Error::NoEntry)));
    }
}
