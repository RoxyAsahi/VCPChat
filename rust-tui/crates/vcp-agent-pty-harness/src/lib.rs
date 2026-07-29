//! VCP-only PTY acceptance harness. The spawn/resize/drain structure is a
//! controlled extraction from xAI's Apache-2.0 pager PTY harness. It has no
//! dependency on Grok Agent, inference, pager, sandbox, or product crates.

use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};

pub mod keys {
    pub const CTRL_C: &[u8] = b"\x03";
    pub const CTRL_ENTER: &[u8] = b"\x1b[13;5u";
    pub const CTRL_O: &[u8] = b"\x0f";
    pub const CTRL_S: &[u8] = b"\x13";
    pub const ENTER: &[u8] = b"\r";
    pub const ESC: &[u8] = b"\x1b";
    pub const DOWN: &[u8] = b"\x1b[B";
    pub const PAGE_DOWN: &[u8] = b"\x1b[6~";
}

pub struct PtyHarness {
    child: Box<dyn Child + Send + Sync>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: mpsc::Receiver<Vec<u8>>,
    parser: vt100::Parser,
    raw: Vec<u8>,
    terminal_query_cursor: usize,
    exit_status: Option<ExitStatus>,
}

impl PtyHarness {
    pub fn spawn(
        binary: &Path,
        rows: u16,
        cols: u16,
        args: &[&str],
        env: &BTreeMap<String, String>,
        cwd: Option<&Path>,
    ) -> Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut command = CommandBuilder::new(binary);
        for argument in args {
            command.arg(argument);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("spawn PTY child {}", binary.display()))?;
        drop(pair.slave);
        let writer = pair.master.take_writer()?;
        let reader = spawn_reader(pair.master.try_clone_reader()?);
        Ok(Self {
            child,
            master: pair.master,
            writer,
            reader,
            parser: vt100::Parser::new(rows, cols, 1_000),
            raw: Vec::new(),
            terminal_query_cursor: 0,
            exit_status: None,
        })
    }

    pub fn inject(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut parser = vt100::Parser::new(rows, cols, 1_000);
        parser.process(&self.raw);
        self.parser = parser;
        Ok(())
    }

    pub fn update(&mut self, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self
                .reader
                .recv_timeout(remaining.min(Duration::from_millis(25)))
            {
                Ok(chunk) => {
                    self.parser.process(&chunk);
                    self.raw.extend_from_slice(&chunk);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            self.answer_terminal_queries();
        }
    }

    pub fn wait_for_text(&mut self, needle: &str, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            self.update(Duration::from_millis(50));
            if self.full_text().contains(needle) {
                return Ok(());
            }
            if self.poll_exit()?.is_some() {
                bail!(
                    "PTY child exited before {needle:?}; screen={:?}",
                    self.screen_contents()
                );
            }
        }
        bail!(
            "timed out waiting for {needle:?}; screen={:?}",
            self.screen_contents()
        )
    }

    pub fn wait_for_exit_and_drain(&mut self, timeout: Duration) -> Result<u32> {
        let deadline = Instant::now() + timeout;
        loop {
            self.update(Duration::from_millis(25));
            if let Some(status) = self.poll_exit()? {
                self.update(Duration::from_millis(100));
                return Ok(status.exit_code());
            }
            if Instant::now() >= deadline {
                bail!(
                    "PTY child did not exit; screen={:?}",
                    self.screen_contents()
                );
            }
        }
    }

    pub fn raw_output(&self) -> &[u8] {
        &self.raw
    }

    pub fn screen_contents(&self) -> String {
        self.parser.screen().contents()
    }

    pub fn full_text(&self) -> String {
        self.screen_contents()
    }

    fn poll_exit(&mut self) -> Result<Option<ExitStatus>> {
        if let Some(status) = self.exit_status.clone() {
            return Ok(Some(status));
        }
        let status = self.child.try_wait()?;
        if let Some(status) = &status {
            self.exit_status = Some(status.clone());
        }
        Ok(status)
    }

    fn answer_terminal_queries(&mut self) {
        let pending = &self.raw[self.terminal_query_cursor..];
        let query_count = pending
            .windows(4)
            .filter(|window| *window == b"[6n")
            .count();
        self.terminal_query_cursor = self.raw.len().saturating_sub(3);
        for _ in 0..query_count {
            let _ = self.writer.write_all(b"[1;1R");
            let _ = self.writer.flush();
        }
    }
}

impl Drop for PtyHarness {
    fn drop(&mut self) {
        if self.exit_status.is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn spawn_reader(mut reader: Box<dyn Read + Send>) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        loop {
            let mut buffer = vec![0; 16 * 1024];
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    buffer.truncate(count);
                    if sender.send(buffer).is_err() {
                        break;
                    }
                }
            }
        }
    });
    receiver
}

/// Decode OSC52 clipboard writes from raw terminal output. Supports BEL or ST
/// terminators and ignores malformed/non-clipboard control sequences.
pub fn decode_osc52_payloads(raw: &[u8]) -> Vec<Vec<u8>> {
    let mut decoded = Vec::new();
    let prefix = b"\x1b]52;";
    let mut cursor = 0;
    while let Some(relative) = raw[cursor..]
        .windows(prefix.len())
        .position(|w| w == prefix)
    {
        let start = cursor + relative + prefix.len();
        let Some(separator) = raw[start..].iter().position(|byte| *byte == b';') else {
            break;
        };
        let payload_start = start + separator + 1;
        let tail = &raw[payload_start..];
        let bel = tail.iter().position(|byte| *byte == 0x07);
        let st = tail.windows(2).position(|window| window == b"\x1b\\");
        let Some(length) = bel.into_iter().chain(st).min() else {
            break;
        };
        if let Ok(value) = STANDARD.decode(&tail[..length]) {
            decoded.push(value);
        }
        cursor = payload_start + length + if st == Some(length) { 2 } else { 1 };
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::decode_osc52_payloads;

    #[test]
    fn decodes_bel_and_st_terminated_osc52() {
        let raw = b"x\x1b]52;c;aGVsbG8=\x07y\x1b]52;c;5Lit5paH\x1b\\z";
        assert_eq!(
            decode_osc52_payloads(raw),
            [b"hello".to_vec(), "中文".as_bytes().to_vec()]
        );
    }

    #[test]
    fn ignores_invalid_or_unterminated_sequences() {
        assert!(decode_osc52_payloads(b"\x1b]52;c;not-base64!\x07\x1b]52;c;eA==").is_empty());
    }
}
