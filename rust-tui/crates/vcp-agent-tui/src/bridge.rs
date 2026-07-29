use std::{io, sync::mpsc, thread, time::Duration};

use tokio::{
    io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::windows::named_pipe::ClientOptions,
    sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
};

use crate::protocol::{UiAction, UiInbound};

/// Local-only named-pipe bridge to the existing JS Host. The terminal keeps
/// inherited stdin/stdout for crossterm; protocol traffic never shares the
/// screen stream, so JSON cannot corrupt the alternate screen.
pub struct HostBridge {
    actions: UnboundedSender<UiAction>,
    inbound: mpsc::Receiver<UiInbound>,
}

impl HostBridge {
    pub fn connect(pipe_name: String) -> io::Result<Self> {
        if pipe_name.trim().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "bridge pipe name is empty",
            ));
        }
        let (actions, action_rx) = unbounded_channel();
        let (inbound_tx, inbound) = mpsc::channel();
        thread::Builder::new()
            .name("vcp-agent-tui-bridge".into())
            .spawn(move || run_bridge_thread(pipe_name, action_rx, inbound_tx))?;
        Ok(Self { actions, inbound })
    }

    pub fn send(&self, action: UiAction) {
        let _ = self.actions.send(action);
    }

    pub fn try_recv(&self) -> Option<UiInbound> {
        self.inbound.try_recv().ok()
    }
}

fn run_bridge_thread(
    pipe_name: String,
    action_rx: UnboundedReceiver<UiAction>,
    inbound_tx: mpsc::Sender<UiInbound>,
) {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = inbound_tx.send(UiInbound::HostClosed {
                reason: error.to_string(),
            });
            return;
        }
    };
    runtime.block_on(run_bridge(pipe_name, action_rx, inbound_tx));
}

async fn run_bridge(
    pipe_name: String,
    mut actions: UnboundedReceiver<UiAction>,
    inbound_tx: mpsc::Sender<UiInbound>,
) {
    loop {
        let pipe = match ClientOptions::new().open(&pipe_name) {
            Ok(pipe) => pipe,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(80)).await;
                continue;
            }
        };
        let (reader, mut writer) = tokio::io::split(pipe);
        let mut lines = BufReader::new(reader).lines();
        if write_action(&mut writer, &UiAction::Ready).await.is_err() {
            continue;
        }
        loop {
            tokio::select! {
                maybe_action = actions.recv() => {
                    let Some(action) = maybe_action else { return; };
                    if write_action(&mut writer, &action).await.is_err() { break; }
                }
                line = lines.next_line() => match line {
                    Ok(Some(line)) => match serde_json::from_str::<UiInbound>(&line) {
                        Ok(event) => { let _ = inbound_tx.send(event); }
                        Err(error) => { let _ = inbound_tx.send(UiInbound::HostClosed { reason: format!("invalid host message: {error}") }); }
                    },
                    Ok(None) => break,
                    Err(error) => { let _ = inbound_tx.send(UiInbound::HostClosed { reason: error.to_string() }); break; }
                },
            }
        }
    }
}

async fn write_action<W: AsyncWrite + Unpin>(writer: &mut W, action: &UiAction) -> io::Result<()> {
    let line = serde_json::to_string(action)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}
