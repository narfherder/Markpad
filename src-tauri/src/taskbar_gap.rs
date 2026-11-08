//! Keeps a maximized frameless window one pixel short of any screen edge that
//! holds an auto-hide taskbar.
//!
//! When a window's client area covers the whole monitor, Explorer treats it as
//! a full-screen app and stops raising the auto-hide taskbar. tao leaves the
//! 1px gap itself, but only where Explorer's appbar query
//! (`ABM_GETAUTOHIDEBAR`) reports an auto-hide bar, and Explorer can get into a
//! state where that query — and `ABM_GETAUTOHIDEBAREX` — report no bar on any
//! edge while `ABM_GETSTATE` says auto-hide is on and `ABM_GETTASKBARPOS` puts
//! the taskbar at the bottom. Seen on a two-monitor setup, lasting across app
//! restarts; Chromium falls back to the taskbar's own position for the same
//! reason. This subclass sits in front of tao's and finds the taskbars
//! directly: a taskbar window on the monitor whose edge the work area does not
//! exclude is an auto-hide one. Nothing here sends a message to Explorer, so
//! it can run inside WM_NCCALCSIZE.

use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowExW, GetWindowPlacement, GetWindowRect, SetWindowPos, NCCALCSIZE_PARAMS,
    SWP_ASYNCWINDOWPOS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE, WINDOWPLACEMENT, WM_DISPLAYCHANGE, WM_NCCALCSIZE,
    WM_NCDESTROY, WM_SETTINGCHANGE,
};

const SUBCLASS_ID: usize = 0x4D50_4741; // "MPGA"

const LEFT: u8 = 1;
const TOP: u8 = 2;
const RIGHT: u8 = 4;
const BOTTOM: u8 = 8;

/// Explorer moves its taskbars shortly after it broadcasts a setting change.
const SETTLE_DELAY: Duration = Duration::from_millis(400);

pub fn install(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let raw = hwnd.0 as isize;
    // Subclasses must be installed from the thread that owns the window.
    let _ = window.run_on_main_thread(move || {
        let hwnd = HWND(raw as _);
        let installed = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0) };
        // The window-state plugin may already have maximized the window, before
        // this subclass existed to shape it.
        if installed.as_bool() && is_maximized(hwnd) {
            reframe(hwnd);
        }
    });
}

unsafe extern "system" fn subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    match msg {
        WM_NCCALCSIZE if wparam.0 != 0 => {
            let params = lparam.0 as *mut NCCALCSIZE_PARAMS;
            let monitor = unsafe { MonitorFromRect(&(*params).rgrc[0], MONITOR_DEFAULTTONULL) };
            // tao's handler runs here and sets the rect to the work area.
            let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
            if !monitor.is_invalid() && is_maximized(hwnd) {
                keep_gap(unsafe { &mut (*params).rgrc[0] }, monitor);
            }
            return result;
        }
        WM_SETTINGCHANGE | WM_DISPLAYCHANGE => reframe_later(hwnd.0 as isize),
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

fn keep_gap(rect: &mut RECT, monitor: HMONITOR) {
    let Some(info) = monitor_info(monitor) else { return };
    let screen = info.rcMonitor;
    let edges = autohide_edges(monitor, &info);
    if edges & LEFT != 0 && rect.left <= screen.left {
        rect.left = screen.left + 1;
    }
    if edges & TOP != 0 && rect.top <= screen.top {
        rect.top = screen.top + 1;
    }
    if edges & RIGHT != 0 && rect.right >= screen.right {
        rect.right = screen.right - 1;
    }
    if edges & BOTTOM != 0 && rect.bottom >= screen.bottom {
        rect.bottom = screen.bottom - 1;
    }
}

/// Edges of `monitor` that hold an auto-hide taskbar: a taskbar window on that
/// monitor whose edge is not reserved out of the work area, which is exactly
/// what auto-hide changes.
fn autohide_edges(monitor: HMONITOR, info: &MONITORINFO) -> u8 {
    let (screen, work) = (info.rcMonitor, info.rcWork);
    let mut edges = 0;
    for class in [w!("Shell_TrayWnd"), w!("Shell_SecondaryTrayWnd")] {
        let mut after = None;
        while let Ok(bar) = unsafe { FindWindowExW(None, after, class, PCWSTR::null()) } {
            after = Some(bar);
            if unsafe { MonitorFromWindow(bar, MONITOR_DEFAULTTONEAREST) } != monitor {
                continue;
            }
            let mut r = RECT::default();
            if unsafe { GetWindowRect(bar, &mut r) }.is_err() {
                continue;
            }
            let edge = if r.right - r.left >= r.bottom - r.top {
                if r.top + r.bottom > screen.top + screen.bottom {
                    BOTTOM
                } else {
                    TOP
                }
            } else if r.left + r.right > screen.left + screen.right {
                RIGHT
            } else {
                LEFT
            };
            let reserved = match edge {
                LEFT => work.left > screen.left,
                TOP => work.top > screen.top,
                RIGHT => work.right < screen.right,
                _ => work.bottom < screen.bottom,
            };
            if !reserved {
                edges |= edge;
            }
        }
    }
    edges
}

/// Re-runs WM_NCCALCSIZE once Explorer has had time to move its taskbars
/// after a setting or display change.
fn reframe_later(raw: isize) {
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE_DELAY);
        let hwnd = HWND(raw as _);
        if is_maximized(hwnd) {
            reframe(hwnd);
        }
    });
}

fn reframe(hwnd: HWND) {
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED
                | SWP_NOMOVE
                | SWP_NOSIZE
                | SWP_NOZORDER
                | SWP_NOOWNERZORDER
                | SWP_NOACTIVATE
                | SWP_ASYNCWINDOWPOS,
        )
    };
}

fn monitor_info(monitor: HMONITOR) -> Option<MONITORINFO> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(monitor, &mut info) }
        .as_bool()
        .then_some(info)
}

fn is_maximized(hwnd: HWND) -> bool {
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut placement) }.is_ok()
        && placement.showCmd == SW_MAXIMIZE.0 as u32
}
