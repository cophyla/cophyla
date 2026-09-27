// Windows: the view's frame hands WebView2 the files dropped on it, and a handler on that frame
// answers it with their paths (dropped.rs).

use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2Frame2, ICoreWebView2WebMessageReceivedEventArgs, ICoreWebView2WebMessageReceivedEventArgs2, ICoreWebView2_4};
use webview2_com::{FrameCreatedEventHandler, FrameWebMessageReceivedEventHandler};
use windows_core_wv2::{Interface, HSTRING, PWSTR};

pub fn listen<R: Runtime>(window: &WebviewWindow<R>) {
    let asked = window.with_webview(|w| {
        // SAFETY: the controller and the core are this window's live WebView2 objects, used on
        // the thread with_webview runs on, which is the one that owns them; the handlers run on it too.
        let result = unsafe {
            w.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_4>()).and_then(|core| {
                let handler = FrameCreatedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let frame: ICoreWebView2Frame2 = args.Frame()?.cast()?;
                    let answer = FrameWebMessageReceivedEventHandler::create(Box::new(|frame, args| {
                        let (Some(frame), Some(args)) = (frame, args) else { return Ok(()) };
                        let mut source = PWSTR::null();
                        args.Source(&mut source)?;
                        if !super::from_view(&webview2_com::take_pwstr(source)) {
                            return Ok(());
                        }
                        let mut json = PWSTR::null();
                        args.WebMessageAsJson(&mut json)?;
                        let Some(id) = super::message_id(&webview2_com::take_pwstr(json)) else { return Ok(()) };
                        // None read is an answer too: the view stops waiting and the drop does nothing.
                        let paths = paths(&args).unwrap_or_else(|e| {
                            log::warn!("dropped files: {e}");
                            Vec::new()
                        });
                        let answer = serde_json::to_string(&super::Answer { cophyla: super::MESSAGE, id, paths }).unwrap_or_default();
                        frame.cast::<ICoreWebView2Frame2>()?.PostWebMessageAsJson(&HSTRING::from(answer))
                    }));
                    let mut token = Default::default();
                    frame.add_WebMessageReceived(&answer, &mut token)
                }));
                let mut token = Default::default();
                core.add_FrameCreated(&handler, &mut token)
            })
        };
        if let Err(e) = result {
            log::warn!("dropped files handler: {e}");
        }
    });
    if let Err(e) = asked {
        log::warn!("dropped files handler: {e}");
    }
}

/// The paths of the files the message carries, in order; anything that is not a file is left out.
unsafe fn paths(args: &ICoreWebView2WebMessageReceivedEventArgs) -> windows_core_wv2::Result<Vec<String>> {
    let args: ICoreWebView2WebMessageReceivedEventArgs2 = args.cast()?;
    let objects = args.AdditionalObjects()?;
    let mut n = 0;
    objects.Count(&mut n)?;
    let mut paths = Vec::with_capacity(n as usize);
    for i in 0..n {
        let Ok(file) = objects.GetValueAtIndex(i)?.cast::<ICoreWebView2File>() else { continue };
        let mut path = PWSTR::null();
        file.Path(&mut path)?;
        paths.push(webview2_com::take_pwstr(path));
    }
    Ok(paths)
}
