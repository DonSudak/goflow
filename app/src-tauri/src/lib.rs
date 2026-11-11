use std::process::Command;

/// Command-line arguments of the app (`--project-dir`, `--godot-project` are read by the frontend).
#[tauri::command]
fn cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// Spawns Godot detached (`<exe> --path <project> -- --dialogue ... --cue ...`); returns its pid.
#[tauri::command]
fn launch_godot(exe: String, args: Vec<String>) -> Result<u32, String> {
    Command::new(&exe)
        .args(&args)
        .spawn()
        .map(|child| child.id())
        .map_err(|e| format!("Failed to start {exe}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![cli_args, launch_godot])
        .run(tauri::generate_context!())
        .expect("error while running Go Flow");
}
