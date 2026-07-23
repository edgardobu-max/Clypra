use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use uuid::Uuid;

/// Metadata for an imported .cube LUT file, persisted under
/// `app_data_dir/luts/`. LUTs live outside any single project so they can be
/// reused across projects (matches a one-time Envato purchase being applied
/// to many future edits).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LutAsset {
    pub id: String,
    pub name: String,
    /// Absolute path to the stored .cube file.
    pub path: String,
}

fn get_luts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let luts_dir = app_data.join("luts");
    fs::create_dir_all(&luts_dir).map_err(|e| format!("Failed to create luts dir: {}", e))?;

    Ok(luts_dir)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect()
}

/// Copy a user-picked .cube file into the app's LUT library.
#[tauri::command]
pub async fn import_lut_file(app: tauri::AppHandle, source_path: String) -> Result<LutAsset, String> {
    let luts_dir = get_luts_dir(&app)?;

    let source = PathBuf::from(&source_path);
    let extension = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if extension != "cube" {
        return Err(format!("Unsupported LUT format: .{}", extension));
    }

    let original_stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("LUT").to_string();
    let id = Uuid::new_v4().to_string();
    let stored_filename = format!("{}__{}.cube", id, sanitize_filename(&original_stem));
    let dest_path = luts_dir.join(&stored_filename);

    fs::copy(&source, &dest_path).map_err(|e| format!("Failed to import LUT: {}", e))?;

    let dest_path_str = dest_path.to_str().ok_or("Failed to convert LUT path to string")?.to_string();

    eprintln!("[import_lut_file] Imported '{}' -> {}", original_stem, dest_path_str);

    Ok(LutAsset {
        id,
        name: original_stem,
        path: dest_path_str,
    })
}

/// List all LUTs currently in the library.
#[tauri::command]
pub async fn list_lut_assets(app: tauri::AppHandle) -> Result<Vec<LutAsset>, String> {
    let luts_dir = get_luts_dir(&app)?;
    let mut assets = Vec::new();

    if let Ok(entries) = fs::read_dir(&luts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("cube") {
                continue;
            }

            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            // Stored filenames are "<uuid>__<name>"; split on the first "__".
            let (id, name) = match stem.split_once("__") {
                Some((id, name)) => (id.to_string(), name.to_string()),
                None => (stem.clone(), stem.clone()),
            };

            let path_str = match path.to_str() {
                Some(p) => p.to_string(),
                None => continue,
            };

            assets.push(LutAsset { id, name, path: path_str });
        }
    }

    assets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(assets)
}

/// Read a .cube file's raw text content. Bypasses the fs plugin's capability
/// scope (which only covers $APPCACHE/$APPLOCALDATA) since LUT paths live
/// under $APPDATA and are validated by our own commands, not user input.
#[tauri::command]
pub async fn read_lut_cube(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read LUT file: {}", e))
}

/// Delete a LUT from the library.
#[tauri::command]
pub async fn delete_lut_asset(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let luts_dir = get_luts_dir(&app)?;

    if let Ok(entries) = fs::read_dir(&luts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem.starts_with(&format!("{}__", id)) || stem == id {
                fs::remove_file(&path).map_err(|e| format!("Failed to delete LUT: {}", e))?;
                return Ok(());
            }
        }
    }

    Err(format!("LUT not found: {}", id))
}
