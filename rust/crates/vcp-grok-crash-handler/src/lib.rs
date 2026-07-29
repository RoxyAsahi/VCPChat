//! Controlled terminal-restoration subset of Grok Build's xai-crash-handler.

mod terminal;

pub use terminal::{MOUSE_TRACKING_RESET, RESTORE_SEQ};

use std::sync::Once;

static PANIC_HOOK: Once = Once::new();

pub fn install_panic_restore_hook() {
    PANIC_HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            terminal::restore_in_signal_handler();
            previous(info);
        }));
    });
}

#[cfg(windows)]
mod platform {
    const EXCEPTION_ACCESS_VIOLATION: i32 = 0xC0000005_u32 as i32;
    const EXCEPTION_STACK_OVERFLOW: i32 = 0xC00000FD_u32 as i32;
    const EXCEPTION_IN_PAGE_ERROR: i32 = 0xC0000006_u32 as i32;
    const EXCEPTION_ILLEGAL_INSTRUCTION: i32 = 0xC000001D_u32 as i32;
    const EXCEPTION_ARRAY_BOUNDS_EXCEEDED: i32 = 0xC000008C_u32 as i32;
    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

    fn is_fatal_exception(code: i32) -> bool {
        matches!(
            code,
            EXCEPTION_ACCESS_VIOLATION
                | EXCEPTION_STACK_OVERFLOW
                | EXCEPTION_IN_PAGE_ERROR
                | EXCEPTION_ILLEGAL_INSTRUCTION
                | EXCEPTION_ARRAY_BOUNDS_EXCEEDED
        )
    }

    unsafe extern "system" fn basic_filter(
        _info: *const windows_sys::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
    ) -> i32 {
        EXCEPTION_CONTINUE_SEARCH
    }

    unsafe extern "system" fn restore_filter(
        info: *const windows_sys::Win32::System::Diagnostics::Debug::EXCEPTION_POINTERS,
    ) -> i32 {
        unsafe {
            if !info.is_null()
                && !(*info).ExceptionRecord.is_null()
                && is_fatal_exception((*(*info).ExceptionRecord).ExceptionCode)
            {
                crate::terminal::restore_in_signal_handler();
            }
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    pub fn install() {
        unsafe {
            windows_sys::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter(Some(
                basic_filter,
            ));
        }
    }

    pub fn enable() {
        unsafe {
            windows_sys::Win32::System::Diagnostics::Debug::SetUnhandledExceptionFilter(Some(
                restore_filter,
            ));
        }
    }

    pub fn disable() {
        install();
    }
}

#[cfg(unix)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};

    static mut ORIGINAL_TERMIOS: libc::termios = unsafe { std::mem::zeroed() };
    static mut HAS_TERMIOS: bool = false;
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    unsafe extern "C" fn restore_handler(
        signal: libc::c_int,
        _info: *mut libc::siginfo_t,
        _context: *mut libc::c_void,
    ) {
        unsafe {
            crate::terminal::restore_in_signal_handler();
            if *std::ptr::addr_of!(HAS_TERMIOS) {
                libc::tcsetattr(0, libc::TCSANOW, std::ptr::addr_of!(ORIGINAL_TERMIOS));
            }
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
        }
    }

    pub fn install() {
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return;
        }
        unsafe {
            let termios = &mut *std::ptr::addr_of_mut!(ORIGINAL_TERMIOS);
            if libc::tcgetattr(0, termios) == 0 {
                *std::ptr::addr_of_mut!(HAS_TERMIOS) = true;
            }
        }
    }

    pub fn enable() {
        install();
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = restore_handler as *const () as usize;
            action.sa_flags = libc::SA_SIGINFO | libc::SA_RESETHAND;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(libc::SIGBUS, &action, std::ptr::null_mut());
            libc::sigaction(libc::SIGSEGV, &action, std::ptr::null_mut());
        }
    }

    pub fn disable() {}
}

#[cfg(not(any(unix, windows)))]
mod platform {
    pub fn install() {}
    pub fn enable() {}
    pub fn disable() {}
}

pub fn install_terminal_restore_only() {
    platform::install();
    install_panic_restore_hook();
}

pub fn enable_terminal_escape_restore() {
    platform::enable();
}

pub fn disable_terminal_escape_restore() {
    platform::disable();
}
