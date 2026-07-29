//! Terminal restore sequences imported from Grok Build revision 02d9359.

pub const MOUSE_TRACKING_RESET: &[u8] = b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l";

pub const RESTORE_SEQ: &[u8] = b"\x1b[?2026l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[<u\x1b[?1049l";

#[cfg(unix)]
pub fn restore_in_signal_handler() {
    unsafe {
        libc::write(
            2,
            RESTORE_SEQ.as_ptr().cast::<libc::c_void>(),
            RESTORE_SEQ.len(),
        );
    }
}

#[cfg(windows)]
pub fn restore_in_signal_handler() {
    unsafe {
        use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE};
        let stderr = GetStdHandle(STD_ERROR_HANDLE);
        if !stderr.is_null() && stderr != -1_isize as *mut std::ffi::c_void {
            let mut written = 0;
            windows_sys::Win32::Storage::FileSystem::WriteFile(
                stderr,
                RESTORE_SEQ.as_ptr(),
                RESTORE_SEQ.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            );
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub fn restore_in_signal_handler() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_sequence_covers_every_enabled_terminal_mode() {
        for sequence in [
            b"\x1b[?2026l".as_slice(),
            b"\x1b[?25h".as_slice(),
            b"\x1b[?1000l".as_slice(),
            b"\x1b[?1002l".as_slice(),
            b"\x1b[?1003l".as_slice(),
            b"\x1b[?1015l".as_slice(),
            b"\x1b[?1006l".as_slice(),
            b"\x1b[?2004l".as_slice(),
            b"\x1b[?1004l".as_slice(),
            b"\x1b[<u".as_slice(),
            b"\x1b[?1049l".as_slice(),
        ] {
            assert!(
                RESTORE_SEQ
                    .windows(sequence.len())
                    .any(|part| part == sequence)
            );
        }
    }
}
