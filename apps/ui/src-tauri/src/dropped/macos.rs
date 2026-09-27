// macOS: wry's web view hands a drop to WebKit in `performDragOperation:` while Tauri's own drag
// and drop is off. That method is wrapped, once, for the whole class: on the host web view the
// wrapper keeps the paths the drag carries (the Finder's `NSFilenamesPboardType`, read as wry's
// collect_paths reads it), then always calls wry's, which is when WebKit hands the drop to the
// page. The class's method is swapped rather than the view given a subclass of its own: the
// view may already be under a KVO subclass, and swapping its class again would break that.

use std::ffi::c_void;
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;

use objc2::runtime::{AnyObject, Bool, Imp, ProtocolObject, Sel};
use objc2::sel;
use objc2_app_kit::NSDraggingInfo;
use objc2_foundation::{NSArray, NSString};
use tauri::{Runtime, WebviewWindow};

/// The host window's web view: the one whose drops are kept.
static HOST: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());
/// Wry's `performDragOperation:`, which every drop is handed on to.
static WRY: OnceLock<Imp> = OnceLock::new();

/// `- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender`.
type PerformDragOperation = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut ProtocolObject<dyn NSDraggingInfo>) -> Bool;

pub fn listen<R: Runtime>(window: &WebviewWindow<R>) {
    let asked = window.with_webview(|w| {
        let view = w.inner();
        if view.is_null() {
            return;
        }
        HOST.store(view, Ordering::Release);
        // SAFETY: `inner()` is this window's live WKWebView (wry's WryWebView), on the main
        // thread with_webview runs on. `instance_method` finds WryWebView's own method under a
        // KVO subclass too.
        let class = unsafe { &*view.cast::<AnyObject>() }.class();
        let Some(method) = class.instance_method(sel!(performDragOperation:)) else {
            log::warn!("dropped files: the web view has no performDragOperation:");
            return;
        };
        // Wry's is kept before the wrapper takes its place, so the wrapper always has it.
        if WRY.set(method.implementation()).is_ok() {
            // SAFETY: the wrapper has the method's signature, and it is swapped in on the main
            // thread, where AppKit calls it.
            unsafe { method.set_implementation(std::mem::transmute::<PerformDragOperation, Imp>(perform_drag_operation)) };
        }
    });
    if let Err(e) = asked {
        log::warn!("dropped files handler: {e}");
    }
}

/// Wry's `performDragOperation:`, after keeping the paths of files dropped on the host web view.
unsafe extern "C-unwind" fn perform_drag_operation(this: *mut AnyObject, cmd: Sel, sender: *mut ProtocolObject<dyn NSDraggingInfo>) -> Bool {
    if ptr::eq(this.cast::<c_void>(), HOST.load(Ordering::Acquire)) {
        // SAFETY: AppKit passes the drag's info, alive for the call.
        if let Some(info) = unsafe { sender.as_ref() } {
            let paths = paths(info);
            if !paths.is_empty() {
                super::record(paths);
            }
        }
    }
    let Some(&wry) = WRY.get() else { return Bool::NO };
    // SAFETY: WRY is the method's own implementation, which has this signature.
    unsafe { std::mem::transmute::<Imp, PerformDragOperation>(wry)(this, cmd, sender) }
}

/// The paths of the files a drag carries; none when it carries anything else.
fn paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
    // Deprecated for writing a pasteboard, and still what AppKit gives a drag of files as.
    // SAFETY: an AppKit constant, set before any drag.
    #[allow(deprecated)]
    let kind = unsafe { objc2_app_kit::NSFilenamesPboardType };
    let Some(list) = info.draggingPasteboard().propertyListForType(kind) else { return Vec::new() };
    let Ok(list) = list.downcast::<NSArray>() else { return Vec::new() };
    list.to_vec().into_iter().map(|p| p.downcast::<NSString>().map(|s| PathBuf::from(s.to_string()))).collect::<Result<_, _>>().unwrap_or_default()
}
