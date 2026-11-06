//! The host web view's memory target, on Windows: low while the window is out of sight (hidden
//! to the tray, or minimised), normal while it shows. WebView2 then gives back what it can of
//! the view's memory (caches, decoded images, freed pages) while scripts go on running and the
//! node's link stays open, as its documentation describes the setting for an inactive app;
//! set back to normal, the view is as it was. In the same view kept open a while, a
//! memory-pressure signal like it took the view's renderer from 148 MB to 52 MB. `sync`
//! reads the window's state and sets the target when it changed; it is called where the
//! window is shown or hidden and on its focus and size events, minimising among them.

use tauri::{AppHandle, Manager, Runtime};

/// Sets the target for the host window as it is now: low when hidden or minimised.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window(crate::cophylad::HOST_LABEL) else { return };
    let out_of_sight = !window.is_visible().unwrap_or(true) || window.is_minimized().unwrap_or(false);
    #[cfg(windows)]
    windows::apply(app, out_of_sight);
    #[cfg(not(windows))]
    let _ = out_of_sight;
}

#[cfg(windows)]
mod windows {
    use std::sync::atomic::{AtomicU8, Ordering};

    use tauri::{AppHandle, Manager, Runtime};
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
    use windows_core_wv2::Interface;

    const UNSET: u8 = 0;
    const NORMAL: u8 = 1;
    const LOW: u8 = 2;
    /// The target last set, so a focus or size event that changes nothing calls nothing.
    static LEVEL: AtomicU8 = AtomicU8::new(UNSET);

    pub fn apply<R: Runtime>(app: &AppHandle<R>, low: bool) {
        let want = if low { LOW } else { NORMAL };
        // Nothing to undo before the first time it goes low: a web view starts at normal.
        let was = LEVEL.load(Ordering::Relaxed);
        if was == want || (was == UNSET && !low) {
            return;
        }
        let Some(webview) = app.get_webview(crate::cophylad::HOST_LABEL) else { return };
        LEVEL.store(want, Ordering::Relaxed);
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        let asked = webview.with_webview(move |w| {
            // SAFETY: the controller and the core are this web view's live WebView2 objects, used
            // on the thread with_webview runs on, which is the one that owns them.
            let result = unsafe { w.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_19>()).and_then(|core| core.SetMemoryUsageTargetLevel(level)) };
            match result {
                Ok(()) => log::debug!("web view memory target {}", if low { "low" } else { "normal" }),
                // A runtime older than 1.0.1823 has no target: the view keeps what it has.
                Err(e) => log::debug!("web view memory target: {e}"),
            }
        });
        if let Err(e) = asked {
            LEVEL.store(was, Ordering::Relaxed);
            log::debug!("web view memory target: {e}");
        }
    }
}
