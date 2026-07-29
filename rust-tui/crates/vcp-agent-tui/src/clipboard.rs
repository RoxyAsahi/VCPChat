use std::{
    fmt,
    io::{self, Seek, Write},
    process::{Command, Stdio},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use wait_timeout::ChildExt;
use xai_ratatui_textarea::ClipboardProvider;

const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
const TMUX_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardDelivery {
    Confirmed,
    Unverified,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClipboardRoute {
    native: bool,
    tmux: bool,
    osc52: bool,
    tmux_passthrough: bool,
}

impl ClipboardRoute {
    fn current() -> Self {
        let tmux = std::env::var_os("TMUX").is_some();
        let remote = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
            .iter()
            .any(|name| std::env::var_os(name).is_some());
        Self {
            native: true,
            tmux,
            osc52: tmux || remote,
            tmux_passthrough: tmux,
        }
    }
}

pub struct SystemClipboard {
    native: Option<arboard::Clipboard>,
    route: ClipboardRoute,
    last_delivery: ClipboardDelivery,
}

impl fmt::Debug for SystemClipboard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SystemClipboard")
            .field("route", &self.route)
            .field("last_delivery", &self.last_delivery)
            .finish_non_exhaustive()
    }
}

impl Default for SystemClipboard {
    fn default() -> Self {
        Self {
            native: arboard::Clipboard::new().ok(),
            route: ClipboardRoute::current(),
            last_delivery: ClipboardDelivery::Failed,
        }
    }
}

impl ClipboardProvider for SystemClipboard {
    fn get(&mut self) -> Option<String> {
        self.native.as_mut()?.get_text().ok()
    }

    fn set(&mut self, text: &str) {
        if text.is_empty() || text.len() > MAX_CLIPBOARD_BYTES {
            self.last_delivery = ClipboardDelivery::Failed;
            return;
        }
        let native_ok = self.route.native
            && self
                .native
                .as_mut()
                .is_some_and(|clipboard| clipboard.set_text(text).is_ok());
        let tmux_ok = self.route.tmux && write_tmux_buffer(text);
        let should_emit_osc52 = self.route.osc52 || (!native_ok && !tmux_ok);
        let osc52_ok = should_emit_osc52 && write_osc52(text, self.route.tmux_passthrough).is_ok();
        self.last_delivery = resolve_delivery(native_ok, tmux_ok, osc52_ok, self.route);
    }
}

fn resolve_delivery(
    native_ok: bool,
    tmux_ok: bool,
    osc52_ok: bool,
    route: ClipboardRoute,
) -> ClipboardDelivery {
    if native_ok || tmux_ok || (osc52_ok && route.tmux_passthrough) {
        ClipboardDelivery::Confirmed
    } else if osc52_ok {
        ClipboardDelivery::Unverified
    } else {
        ClipboardDelivery::Failed
    }
}

fn write_tmux_buffer(text: &str) -> bool {
    let mut spool = match tempfile::tempfile() {
        Ok(file) => file,
        Err(_) => return false,
    };
    if spool.write_all(text.as_bytes()).is_err() || spool.rewind().is_err() {
        return false;
    }
    let mut child = match Command::new("tmux")
        .args(["load-buffer", "-"])
        .stdin(Stdio::from(spool))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    match child.wait_timeout(TMUX_TIMEOUT) {
        Ok(Some(status)) => status.success(),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            false
        }
        Err(_) => false,
    }
}

fn write_osc52(text: &str, tmux_passthrough: bool) -> io::Result<()> {
    let sequence = osc52_sequence(text, tmux_passthrough);
    let mut stderr = io::stderr().lock();
    stderr.write_all(&sequence)?;
    stderr.flush()
}

fn osc52_sequence(text: &str, tmux_passthrough: bool) -> Vec<u8> {
    let encoded = STANDARD.encode(text.as_bytes());
    if tmux_passthrough {
        format!("\x1bPtmux;\x1b\x1b]52;c;{encoded}\x07\x1b\\").into_bytes()
    } else {
        format!("\x1b]52;c;{encoded}\x07").into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(tmux: bool) -> ClipboardRoute {
        ClipboardRoute {
            native: true,
            tmux,
            osc52: true,
            tmux_passthrough: tmux,
        }
    }

    #[test]
    fn delivery_requires_evidence_and_plain_osc52_is_unverified() {
        assert_eq!(
            resolve_delivery(false, false, true, route(false)),
            ClipboardDelivery::Unverified
        );
        assert_eq!(
            resolve_delivery(true, false, false, route(false)),
            ClipboardDelivery::Confirmed
        );
        assert_eq!(
            resolve_delivery(false, false, false, route(false)),
            ClipboardDelivery::Failed
        );
    }

    #[test]
    fn tmux_buffer_or_passthrough_is_confirmed() {
        assert_eq!(
            resolve_delivery(false, true, false, route(true)),
            ClipboardDelivery::Confirmed
        );
        assert_eq!(
            resolve_delivery(false, false, true, route(true)),
            ClipboardDelivery::Confirmed
        );
    }

    #[test]
    fn osc52_sequences_match_terminal_and_tmux_contracts() {
        assert_eq!(osc52_sequence("hi", false), b"\x1b]52;c;aGk=\x07");
        assert_eq!(
            osc52_sequence("hi", true),
            b"\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\"
        );
    }
}
