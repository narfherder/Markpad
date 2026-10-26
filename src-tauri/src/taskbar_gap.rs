//! Keeps a maximized frameless window one pixel short of any screen edge that
//! holds an auto-hide taskbar.
//!
//! When a window's client area covers the whole monitor, Explorer treats it as
//! a full-screen app and stops raising the auto-hide taskbar. tao leaves the
//! 1px gap itself, but it asks Explorer where the auto-hide bars are from
//! inside WM_NCCALCSIZE, and that call intermittently comes back empty — the
//! window then covers the screen and the taskbar stays hidden until the window
//! is resized. This subclass sits in front of tao's and enforces the gap from
//! an answer fetched ahead of time on a background thread.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL,
};
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SHAppBarMessage, SetWindowSubclass, ABE_BOTTOM,
    ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETAUTOHIDEBAREX, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowPlacement, SetWindowPos, NCCALCSIZE_PARAMS, SIZE_MAXIMIZED, SWP_ASYNCWINDOWPOS,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    SW_MAXIMIZE, WINDOWPLACEMENT, WM_DISPLAYCHANGE, WM_NCCALCSIZE, WM_NCDESTROY,
    WM_SETTINGCHANGE, WM_SIZE,
};

const SUBCLASS_ID: usize = 0x4D50_4741; // "MPGA"

const LEFT: u8 = 1;
const TOP: u8 = 2;
const RIGHT: u8 = 4;
const BOTTOM: u8 = 8;
const EDGES: [(u8, u32); 4] = [
    (LEFT, ABE_LEFT),
    (TOP, ABE_TOP),
    (RIGHT, ABE_RIGHT),
    (BOTTOM, ABE_BOTTOM),
];

/// Explorer applies taskbar setting changes shortly after it broadcasts them.
const SETTLE_DELAY: Duration = Duration::from_millis(400);

/// Auto-hide edges per monitor handle.
static AUTOHIDE_EDGES: Mutex<Vec<(isize, u8)>> = Mutex::new(Vec::new());

pub fn install(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let raw = hwnd.0 as isize;
    // Subclasses must be installed from the thread that owns the window.
    let _ = window.run_on_main_thread(move || {
        let installed =
            unsafe { SetWindowSubclass(HWND(raw as _), Some(subclass_proc), SUBCLASS_ID, 0) };
        if installed.as_bool() {
            refresh(raw, Duration::ZERO);
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
                match cached_edges(monitor.0 as isize) {
                    Some(edges) => keep_gap(unsafe { &mut (*params).rgrc[0] }, monitor, edges),
                    None => refresh(hwnd.0 as isize, Duration::ZERO),
                }
            }
            return result;
        }
        WM_SIZE if wparam.0 == SIZE_MAXIMIZED as usize => {
            let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            if cached_edges(monitor.0 as isize).is_none() {
                refresh(hwnd.0 as isize, Duration::ZERO);
            }
        }
        WM_SETTINGCHANGE => refresh(hwnd.0 as isize, SETTLE_DELAY),
        WM_DISPLAYCHANGE => {
            lock_cache().clear();
            refresh(hwnd.0 as isize, SETTLE_DELAY);
        }
        WM_NCDESTROY => unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

fn keep_gap(rect: &mut RECT, monitor: HMONITOR, edges: u8) {
    let Some(screen) = monitor_rect(monitor) else { return };
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

/// Asks Explorer for the window's monitor off the UI thread, then reframes the
/// window if it is maximized and the answer changed.
fn refresh(raw: isize, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let hwnd = HWND(raw as _);
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        let Some(screen) = monitor_rect(monitor) else { return };
        let edges = query_edges(screen);
        if remember_edges(monitor.0 as isize, edges) != Some(edges) && is_maximized(hwnd) {
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
    });
}

fn query_edges(screen: RECT) -> u8 {
    let mut edges = 0;
    for (bit, edge) in EDGES {
        let mut data = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            uEdge: edge,
            rc: screen,
            ..Default::default()
        };
        if unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut data) } != 0 {
            edges |= bit;
        }
    }
    edges
}

fn monitor_rect(monitor: HMONITOR) -> Option<RECT> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetMonitorInfoW(monitor, &mut info) }
        .as_bool()
        .then_some(info.rcMonitor)
}

fn is_maximized(hwnd: HWND) -> bool {
    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        ..Default::default()
    };
    unsafe { GetWindowPlacement(hwnd, &mut placement) }.is_ok()
        && placement.showCmd == SW_MAXIMIZE.0 as u32
}

fn lock_cache() -> std::sync::MutexGuard<'static, Vec<(isize, u8)>> {
    AUTOHIDE_EDGES.lock().unwrap_or_else(PoisonError::into_inner)
}

fn cached_edges(monitor: isize) -> Option<u8> {
    lock_cache()
        .iter()
        .find(|(m, _)| *m == monitor)
        .map(|(_, edges)| *edges)
}

/// Stores the edges for a monitor and returns what was stored before.
fn remember_edges(monitor: isize, edges: u8) -> Option<u8> {
    let mut cache = lock_cache();
    match cache.iter_mut().find(|(m, _)| *m == monitor) {
        Some(entry) => Some(std::mem::replace(&mut entry.1, edges)),
        None => {
            cache.push((monitor, edges));
            None
        }
    }
}
