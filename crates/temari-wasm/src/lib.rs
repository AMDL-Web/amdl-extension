//! Minimal wasm32 FairPlay SAMPLE-AES decryptor over vendored Temari v0.5.1 core.
//!
//! Vendored modules (`rounds`, `rounds_gen`, `template`) are from
//! `github.com/WorldObservationLog/Temari` (`bindings/go@v0.5.1`, MIT License;
//! see `third_party/temari/LICENSE`).

#![allow(dead_code)]

mod rounds;
mod rounds_gen;
mod template;

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;
use std::slice;

use rounds::Template;

const ALLOC_ALIGN: usize = 8;

struct State {
    templates: Vec<Option<Template>>,
    scratch: Vec<u8>,
}

impl State {
    const fn new() -> Self {
        Self {
            templates: Vec::new(),
            scratch: Vec::new(),
        }
    }
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State::new()) };
}

/// Allocate `len` bytes aligned to 8 bytes (suitable for both u8 buffers and u32 tables).
/// Returns null on `len == 0` or allocation failure.
#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(len, ALLOC_ALIGN) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `len > 0` and `ALLOC_ALIGN` is a valid power of two.
    unsafe { alloc(layout) }
}

/// Free a buffer previously allocated by `wasm_alloc(len)`.
#[no_mangle]
pub extern "C" fn wasm_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(len, ALLOC_ALIGN) {
        // SAFETY: caller passes pointer and exact length returned by `wasm_alloc`.
        unsafe { dealloc(ptr, layout) };
    }
}

/// Parse a 40020 key-server JSON payload into a cached Template.
/// Returns a 1-based handle on success, or 0 on parse/validation error.
#[no_mangle]
pub extern "C" fn template_new(json_ptr: *const u8, json_len: usize) -> u32 {
    if json_ptr.is_null() || json_len == 0 {
        return 0;
    }
    // SAFETY: caller provides a valid pointer/length in wasm linear memory.
    let bytes = unsafe { slice::from_raw_parts(json_ptr, json_len) };
    let Ok(json_str) = std::str::from_utf8(bytes) else {
        return 0;
    };
    let Ok(tmpl) = template::template_from_json(json_str) else {
        return 0;
    };

    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        for (idx, slot) in state.templates.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(tmpl);
                return (idx + 1) as u32;
            }
        }
        state.templates.push(Some(tmpl));
        state.templates.len() as u32
    })
}

/// Free a previously allocated Template handle.
#[no_mangle]
pub extern "C" fn template_free(handle: u32) {
    if handle == 0 {
        return;
    }
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let idx = (handle - 1) as usize;
        if let Some(slot) = state.templates.get_mut(idx) {
            *slot = None;
        }
    });
}

/// Decrypt `count` samples in place inside `buf_ptr[..buf_len]`.
///
/// `table_ptr` points to `count * 2` little-endian `u32` values: `(offset, size)` pairs
/// relative to `buf_ptr`. For each sample, its 16-byte-aligned prefix is decrypted via
/// Temari single-lane `decrypt_region_into` through a reused scratch buffer, and any
/// trailing bytes (`size % 16`) are left untouched.
///
/// Returns `0` on success, or a negative status code on error:
/// - `-1`: invalid template handle
/// - `-2`: null buffer or table pointer
/// - `-3`: sample range out of bounds
#[no_mangle]
pub extern "C" fn decrypt_samples(
    handle: u32,
    buf_ptr: *mut u8,
    buf_len: usize,
    table_ptr: *const u32,
    count: usize,
) -> i32 {
    if count == 0 {
        return 0;
    }
    if handle == 0 {
        return -1;
    }
    if buf_ptr.is_null() || table_ptr.is_null() {
        return -2;
    }

    // SAFETY: caller passes valid wasm linear-memory pointers for `buf_len` and `count * 2` u32s.
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len) };
    let table = unsafe { slice::from_raw_parts(table_ptr, count * 2) };

    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        let State { templates, scratch } = &mut *state;
        let idx = (handle - 1) as usize;
        let Some(Some(tmpl)) = templates.get(idx) else {
            return -1;
        };

        for i in 0..count {
            let off = table[i * 2] as usize;
            let sz = table[i * 2 + 1] as usize;
            let Some(end) = off.checked_add(sz) else {
                return -3;
            };
            if end > buf_len {
                return -3;
            }
            let head = (sz / 16) * 16;
            if head == 0 {
                continue;
            }
            if scratch.len() < head {
                scratch.resize(head, 0);
            }
            let sample = &mut buf[off..off + head];
            let out = &mut scratch[..head];
            rounds::decrypt_region_into(tmpl, sample, out);
            sample.copy_from_slice(out);
        }

        0
    })
}
