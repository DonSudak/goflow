//! Go Flow desktop shell (local edition).
//!
//! Security model: the webview never names a program, argv or an arbitrary path.
//! - User folders (Godot project, narrative projects, dialogue output) and the Godot executable
//!   are chosen through native dialogs opened *here* (or CLI args) and persisted by Rust in
//!   `<app config>/godot-paths.json`, which the webview's fs scope explicitly denies.
//! - Those folders are added to the fs scope at runtime; the static scope is only `$APPDATA/**`.
//! - `play_in_godot` validates its inputs and builds the Godot argv itself.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

const PATHS_FILE: &str = "godot-paths.json";

/// What Rust persists (only Rust writes it).
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct StoredPaths {
    pub godot_project: Option<String>,
    pub projects_dir: Option<String>,
    pub dialogue_dir: Option<String>,
    pub godot_exe: Option<String>,
    pub auto_export: bool,
}

/// Effective settings handed to the webview (stored + CLI overrides + derived defaults).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GodotSettings {
    pub godot_project: String,
    pub projects_dir: String,
    pub dialogue_dir: String,
    pub manifest_path: String,
    pub godot_exe: String,
    pub auto_export: bool,
}

/// `--godot-project X` / `--project-dir X` (also `--flag=X`).
pub fn parse_cli(args: &[String]) -> (Option<String>, Option<String>) {
    let mut godot = None;
    let mut projects = None;
    for (i, arg) in args.iter().enumerate() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v.to_string())),
            None => (arg.as_str(), None),
        };
        let value = || inline.clone().or_else(|| args.get(i + 1).cloned());
        match flag {
            "--godot-project" => godot = value(),
            "--project-dir" => projects = value(),
            _ => {}
        }
    }
    (godot, projects)
}

pub fn resolve(stored: &StoredPaths, cli: (Option<String>, Option<String>), app_data: &Path) -> GodotSettings {
    let non_empty = |s: Option<String>| s.filter(|v| !v.trim().is_empty());
    let godot = non_empty(cli.0)
        .or_else(|| non_empty(stored.godot_project.clone()))
        .map(|g| g.trim_end_matches('/').to_string())
        .unwrap_or_default();
    let projects_dir = non_empty(cli.1)
        .or_else(|| non_empty(stored.projects_dir.clone()))
        .unwrap_or_else(|| {
            if godot.is_empty() {
                app_data.join("projects").to_string_lossy().into_owned()
            } else {
                format!("{godot}/narrative")
            }
        });
    let dialogue_dir = non_empty(stored.dialogue_dir.clone())
        .unwrap_or_else(|| if godot.is_empty() { String::new() } else { format!("{godot}/content/dialogue") });
    let manifest_path = if godot.is_empty() { String::new() } else { format!("{godot}/narrative/game_manifest.json") };
    GodotSettings {
        godot_project: godot,
        projects_dir,
        dialogue_dir,
        manifest_path,
        godot_exe: stored.godot_exe.clone().unwrap_or_default(),
        auto_export: stored.auto_export,
    }
}

pub fn is_godot_project(dir: &Path) -> bool {
    dir.is_dir() && dir.join("project.godot").is_file()
}

/// Existing executable regular file whose name contains "godot".
pub fn is_godot_exe(path: &Path) -> bool {
    let named_godot = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase().contains("godot"))
        .unwrap_or(false);
    let Ok(meta) = std::fs::metadata(path) else { return false };
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = path.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false);
    named_godot && meta.is_file() && executable
}

pub fn valid_dialogue_res(res: &str) -> bool {
    res.strip_prefix("res://")
        .and_then(|rest| rest.strip_suffix(".dialogue"))
        .map(|stem| !stem.is_empty() && !stem.contains("..") && stem.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '/' || c == '.' || c == '-'))
        .unwrap_or(false)
}

pub fn valid_cue(cue: &str) -> bool {
    !cue.is_empty() && cue.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn godot_argv(project: &Path, dialogue_res: &str, cue: &str) -> Vec<String> {
    vec![
        "--path".into(),
        project.to_string_lossy().into_owned(),
        "--".into(),
        "--dialogue".into(),
        dialogue_res.into(),
        "--cue".into(),
        cue.into(),
    ]
}

pub fn godot_import_argv(project: &Path) -> Vec<String> {
    vec!["--headless".into(), "--path".into(), project.to_string_lossy().into_owned(), "--import".into()]
}

// ---------- persistence ----------

fn paths_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(PATHS_FILE))
}

fn load_stored<R: Runtime>(app: &AppHandle<R>) -> StoredPaths {
    paths_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_stored<R: Runtime>(app: &AppHandle<R>, stored: &StoredPaths) -> Result<(), String> {
    let file = paths_file(app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(file, serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn effective<R: Runtime>(app: &AppHandle<R>) -> GodotSettings {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let data = app.path().app_data_dir().unwrap_or_default();
    resolve(&load_stored(app), parse_cli(&args), &data)
}

/// Adds the user folders to the webview fs scope.
fn apply_scope<R: Runtime>(app: &AppHandle<R>, s: &GodotSettings) {
    let scope = app.fs_scope();
    for dir in [&s.projects_dir, &s.dialogue_dir] {
        if !dir.is_empty() {
            let _ = scope.allow_directory(dir, true);
        }
    }
    if !s.manifest_path.is_empty() {
        let _ = scope.allow_file(&s.manifest_path);
    }
}

// ---------- commands ----------

#[tauri::command]
fn get_godot_settings<R: Runtime>(app: AppHandle<R>) -> GodotSettings {
    effective(&app)
}

/// Opens a native dialog for `kind` (godotProject | projectsDir | dialogueDir | godotExe), validates and persists it.
/// Returns `None` when the user cancels.
#[tauri::command]
async fn pick_godot_path<R: Runtime>(app: AppHandle<R>, kind: String) -> Result<Option<GodotSettings>, String> {
    let dialog = app.dialog().file();
    let picked = if kind == "godotExe" { dialog.blocking_pick_file() } else { dialog.blocking_pick_folder() };
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let value = path.to_string_lossy().into_owned();

    let mut stored = load_stored(&app);
    match kind.as_str() {
        "godotProject" if is_godot_project(&path) => stored.godot_project = Some(value),
        "godotProject" => return Err("The folder has no project.godot".into()),
        "projectsDir" if path.is_dir() => stored.projects_dir = Some(value),
        "dialogueDir" if path.is_dir() => stored.dialogue_dir = Some(value),
        "godotExe" if is_godot_exe(&path) => stored.godot_exe = Some(value),
        "godotExe" => return Err("Not an executable Godot binary (file name must contain \"godot\")".into()),
        _ => return Err(format!("Invalid choice for {kind}")),
    }
    save_stored(&app, &stored)?;
    let settings = effective(&app);
    apply_scope(&app, &settings);
    Ok(Some(settings))
}

/// Clears a stored folder so the derived default applies again.
#[tauri::command]
fn reset_godot_path<R: Runtime>(app: AppHandle<R>, kind: String) -> Result<GodotSettings, String> {
    let mut stored = load_stored(&app);
    match kind.as_str() {
        "godotProject" => stored.godot_project = None,
        "projectsDir" => stored.projects_dir = None,
        "dialogueDir" => stored.dialogue_dir = None,
        "godotExe" => stored.godot_exe = None,
        _ => return Err(format!("Unknown setting {kind}")),
    }
    save_stored(&app, &stored)?;
    let settings = effective(&app);
    apply_scope(&app, &settings);
    Ok(settings)
}

#[tauri::command]
fn set_auto_export<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<GodotSettings, String> {
    let mut stored = load_stored(&app);
    stored.auto_export = enabled;
    save_stored(&app, &stored)?;
    Ok(effective(&app))
}

/// Godot project to run: only the Rust-held (dialog-chosen or CLI) value, never a webview argument.
/// Rejected when it is not a Godot project, lives in app data/config, or when a webview-writable folder
/// (projects / dialogue dir) contains the project root (the webview could then rewrite project.godot).
pub fn trusted_godot_project(s: &GodotSettings, app_dirs: &[PathBuf]) -> Result<PathBuf, String> {
    if s.godot_project.is_empty() {
        return Err("Choose the Godot project in Settings → Godot first".into());
    }
    let project = std::fs::canonicalize(&s.godot_project).map_err(|_| "Godot project folder does not exist".to_string())?;
    if !is_godot_project(&project) {
        return Err("Godot project folder must contain project.godot".into());
    }
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    if app_dirs.iter().any(|d| project.starts_with(canon(&d.to_string_lossy()))) {
        return Err("Godot project must not be inside the app data folder".into());
    }
    for writable in [&s.projects_dir, &s.dialogue_dir] {
        if !writable.is_empty() && project.starts_with(canon(writable)) {
            return Err(format!("Editor-writable folder {writable} must not contain the Godot project root"));
        }
    }
    Ok(project)
}

/// `<godot exe> --path <godot project> -- --dialogue <res> --cue <cue>`; returns the pid.
/// Executable and project come from Rust-held settings; only the two validated strings come from the webview.
/// A freshly written `.dialogue` must be imported (compiled by Dialogue Manager) before the game can load it,
/// so the project is imported headless first (fixed argv) and only then started at the cue.
#[tauri::command]
async fn play_in_godot<R: Runtime>(app: AppHandle<R>, dialogue_res: String, cue: String) -> Result<u32, String> {
    if !valid_dialogue_res(&dialogue_res) {
        return Err(format!("Invalid dialogue path {dialogue_res}"));
    }
    if !valid_cue(&cue) {
        return Err(format!("Invalid cue {cue}"));
    }
    let settings = effective(&app);
    let app_dirs: Vec<PathBuf> = [app.path().app_data_dir(), app.path().app_config_dir()].into_iter().flatten().collect();
    let project = trusted_godot_project(&settings, &app_dirs)?;
    let exe = load_stored(&app).godot_exe.map(PathBuf::from).filter(|p| is_godot_exe(p));
    let exe = exe.ok_or("Choose the Godot executable in Settings → Godot first")?;
    let imported = Command::new(&exe)
        .args(godot_import_argv(&project))
        .status()
        .map_err(|e| format!("Failed to run the Godot import: {e}"))?;
    if !imported.success() {
        return Err(format!("Godot import failed ({imported})"));
    }
    Command::new(&exe)
        .args(godot_argv(&project, &dialogue_res, &cue))
        .spawn()
        .map(|child| child.id())
        .map_err(|e| format!("Failed to start Godot: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            apply_scope(handle, &effective(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_godot_settings, pick_godot_path, reset_godot_path, set_auto_export, play_in_godot])
        .run(tauri::generate_context!())
        .expect("error while running Go Flow");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_overrides_and_defaults() {
        let args: Vec<String> = ["--godot-project", "/g/ut/", "--project-dir=/tmp/n"].iter().map(|s| s.to_string()).collect();
        let s = resolve(&StoredPaths { projects_dir: Some("/stored".into()), ..Default::default() }, parse_cli(&args), Path::new("/data"));
        assert_eq!(s.godot_project, "/g/ut");
        assert_eq!(s.projects_dir, "/tmp/n");
        assert_eq!(s.dialogue_dir, "/g/ut/content/dialogue");
        assert_eq!(s.manifest_path, "/g/ut/narrative/game_manifest.json");
        let d = resolve(&StoredPaths::default(), (None, None), Path::new("/data"));
        assert_eq!(d.projects_dir, "/data/projects");
        assert_eq!(d.dialogue_dir, "");
    }

    #[test]
    fn validates_dialogue_and_cue() {
        assert!(valid_dialogue_res("res://content/dialogue/bar-night.dialogue"));
        assert!(valid_dialogue_res("res://content/dialogue/bar_night_v2.dialogue"));
        assert!(!valid_dialogue_res("res://../../etc/passwd.dialogue"));
        assert!(!valid_dialogue_res("res://a b.dialogue"));
        assert!(!valid_dialogue_res("/abs/x.dialogue"));
        assert!(!valid_dialogue_res("res://x.dialogue --script evil.gd"));
        assert!(valid_cue("n_UN5wxIMe"));
        assert!(!valid_cue("start; rm -rf"));
        assert!(!valid_cue("--script"));
        assert!(!valid_cue(""));
    }

    #[test]
    fn godot_exe_must_be_named_godot_and_executable() {
        assert!(!is_godot_exe(Path::new("/bin/sh")));
        let dir = std::env::temp_dir().join(format!("goflow-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("godot4");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        assert!(!is_godot_exe(&exe)); // not executable yet
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(is_godot_exe(&exe));
        }
        assert!(!is_godot_project(&dir));
        std::fs::write(dir.join("project.godot"), "").unwrap();
        assert!(is_godot_project(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn godot_project_must_be_trusted() {
        let root = std::env::temp_dir().join(format!("goflow-trust-{}", std::process::id()));
        let game = root.join("game");
        std::fs::create_dir_all(game.join("narrative")).unwrap();
        std::fs::write(game.join("project.godot"), "").unwrap();
        let g = game.to_string_lossy().to_string();
        let ok = resolve(&StoredPaths { godot_project: Some(g.clone()), ..Default::default() }, (None, None), &root.join("data"));
        assert!(trusted_godot_project(&ok, &[root.join("data")]).is_ok());
        // projects dir = project root -> webview could rewrite project.godot
        let bad = resolve(&StoredPaths { godot_project: Some(g.clone()), projects_dir: Some(g.clone()), ..Default::default() }, (None, None), &root.join("data"));
        assert!(trusted_godot_project(&bad, &[]).is_err());
        // inside app data
        assert!(trusted_godot_project(&ok, &[root.clone()]).is_err());
        assert!(trusted_godot_project(&resolve(&StoredPaths::default(), (None, None), &root), &[]).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn argv_is_fixed_shape() {
        assert_eq!(
            godot_argv(Path::new("/g"), "res://content/dialogue/a.dialogue", "start"),
            vec!["--path", "/g", "--", "--dialogue", "res://content/dialogue/a.dialogue", "--cue", "start"]
        );
    }
}
