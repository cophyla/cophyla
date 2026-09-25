// A link the user clicked in a view (a URL in a terminal), opened in the system browser. The
// host page asks only while the click is fresh, and the view's bridge lets through only a web
// page; the shell checks again here, since this is where the page leaves the app: http or
// https, with a host and no credentials in it.

use tauri::Url;

/// The URL, if it is a web page the system browser may be handed.
pub fn web_page(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid: not a URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) || url.username() != "" || url.password().is_some() {
        return Err("invalid: only a web page opens".into());
    }
    Ok(url)
}

/// Opens a web page in the system browser.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    let page = web_page(&url)?;
    let mut child = browser(page.as_str()).spawn().map_err(|e| format!("unavailable: no browser to open the link: {e}"))?;
    // The opener hands the page on and exits; waited for, so it leaves nothing behind.
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// The command that hands a page to the system browser.
fn browser(url: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("rundll32.exe");
        cmd.args(["url.dll,FileProtocolHandler", url]).creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(url);
        cmd
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        cmd.arg(url);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_web_page_opens() {
        assert_eq!(web_page("https://example.com/a b?x=1&y=2").unwrap().as_str(), "https://example.com/a%20b?x=1&y=2");
        assert!(web_page("http://127.0.0.1:4817/").is_ok());
        for bad in ["javascript:alert(1)", "file:///C:/Windows/notepad.exe", "ms-settings:", "https://user:pw@example.com/", "https://user@example.com/", "not a url", ""] {
            assert!(web_page(bad).is_err(), "{bad} opened");
        }
    }
}
