// The launcher's Windows resources: the product icon (what the Start Menu shortcut shows)
// and the version strings. The icon is the desktop shell's, not a copy.
fn main() {
    let icon = "../../ui/src-tauri/icons/icon.ico";
    println!("cargo:rerun-if-changed={icon}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon(icon);
        res.set("ProductName", "Cophyla");
        res.set("FileDescription", "Cophyla");
        res.set("OriginalFilename", "Cophyla.exe");
        res.compile().expect("failed to compile the launcher's Windows resources");
    }
}
