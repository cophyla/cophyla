// Round 2. Round 1 used a bare `tauri_build::build()`, and the view window could call
// every app command even though it holds no capability. Declaring the commands in the app
// manifest is what puts them under the ACL.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["host_ping", "record_cmd"]),
        ),
    )
    .expect("failed to run tauri-build");
}
