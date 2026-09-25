// Declares every app command in the app manifest. Spike 07 found that a command defined with
// #[tauri::command] and registered in generate_handler! is reachable from every web view
// unless it is named here, silently. The list lives in commands.txt so the TypeScript test
// suite can check it against the sources and the capability files without a cargo build.
fn main() {
    let commands: Vec<&'static str> = include_str!("commands.txt")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    // The manifest wants a 'static slice; a build script runs once, so leaking it is free.
    let commands: &'static [&'static str] = Box::leak(commands.into_boxed_slice());
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri-build");
    println!("cargo:rerun-if-changed=commands.txt");
}
