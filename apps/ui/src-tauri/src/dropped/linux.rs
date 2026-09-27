// Linux: WebKitGTK asks for a drag's data as it comes over the view, and gets it by drag.
// Where it is a list of file URIs (a file manager's drag), the paths are kept once that drag
// drops on the host web view, whichever of its data and its drop comes first; WebKitGTK's own
// handlers run after these, so the drop still reaches the page. A drag of anything else (a
// link, text) and one given up keep nothing. Wry connects no handlers of its own while Tauri's
// drag and drop is off.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use gtk::gdk::DragContext;
use gtk::prelude::WidgetExt;
use tauri::{Runtime, WebviewWindow};

/// The last drag over the host web view.
enum Drag {
    /// Its files came: the paths, waiting for it to drop.
    Carrying(DragContext, Vec<PathBuf>),
    /// It dropped before its files came.
    Dropped(DragContext),
    /// Its paths were kept.
    Kept(DragContext),
}

pub fn listen<R: Runtime>(window: &WebviewWindow<R>) {
    let asked = window.with_webview(|w| {
        let view = w.inner();
        let last: Rc<RefCell<Option<Drag>>> = Rc::default();
        let on_data = last.clone();
        view.connect_drag_data_received(move |_, context, _, _, data, _, _| {
            let uris = data.uris();
            if uris.is_empty() {
                return;
            }
            let Some(paths) = uris.iter().map(|u| glib::filename_from_uri(u).ok().map(|(path, _)| path)).collect::<Option<Vec<_>>>() else { return };
            let mut last = on_data.borrow_mut();
            match last.take() {
                Some(Drag::Dropped(c)) if &c == context => {
                    super::record(paths);
                    *last = Some(Drag::Kept(c));
                }
                Some(Drag::Kept(c)) if &c == context => *last = Some(Drag::Kept(c)),
                _ => *last = Some(Drag::Carrying(context.clone(), paths)),
            }
        });
        view.connect_drag_drop(move |_, context, _, _, _| {
            let mut last = last.borrow_mut();
            match last.take() {
                Some(Drag::Carrying(c, paths)) if &c == context => {
                    super::record(paths);
                    *last = Some(Drag::Kept(c));
                }
                _ => *last = Some(Drag::Dropped(context.clone())),
            }
            // Not handled: WebKitGTK drops it into the page.
            false
        });
    });
    if let Err(e) = asked {
        log::warn!("dropped files handler: {e}");
    }
}
