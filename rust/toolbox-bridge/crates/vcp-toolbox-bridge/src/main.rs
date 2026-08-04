use std::collections::HashMap;
use std::env;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncWriteExt, stdin, stdout};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::codec::{FramedRead, LinesCodec};
use vcp_agent_vcp::{
    DirectToolboxHost, ToolboxApprovalResponse, ToolboxConnection, ToolboxWsChannel, ToolboxWsEvent,
};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Invoke {
        request_id: String,
        tool_name: String,
        #[serde(default)]
        arguments: Value,
    },
    Interrupt {
        request_id: String,
    },
    ApprovalResponse {
        request_id: String,
        approved: bool,
        reason: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Clone)]
struct PendingApproval {
    expires_at_ms: i64,
}

const MAX_COMMAND_BYTES: usize = 2 * 1024 * 1024;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = env::var("VCP_TOOLBOX_URL")?;
    let key = env::var("VCP_TOOLBOX_API_KEY")?;
    let device_name =
        env::var("VCP_TOOLBOX_DEVICE_NAME").unwrap_or_else(|_| "vcpchat-codex-agent".to_string());
    let reconnect_base_ms = reconnect_base_delay_ms();
    let connection = ToolboxConnection::new(&url, key)?;
    let host = Arc::new(DirectToolboxHost::new(connection)?);
    let output = Arc::new(Mutex::new(stdout()));
    let pending_approvals = Arc::new(StdMutex::new(HashMap::<String, PendingApproval>::new()));
    let seen_approvals = Arc::new(StdMutex::new(HashMap::<String, i64>::new()));
    let (approval_tx, approval_rx) = mpsc::channel::<ToolboxApprovalResponse>(32);
    let (event_tx, mut event_rx) = mpsc::channel::<Value>(128);

    let event_output = Arc::clone(&output);
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let _ = write_json(&event_output, &event).await;
        }
    });
    spawn_log_observer(
        Arc::clone(&host),
        device_name,
        approval_rx,
        event_tx.clone(),
        Arc::clone(&pending_approvals),
        seen_approvals,
        reconnect_base_ms,
    );
    spawn_info_observer(Arc::clone(&host), event_tx, reconnect_base_ms);

    write_json(&output, &json!({ "type": "ready", "protocolVersion": 1 })).await?;

    let mut lines = FramedRead::new(stdin(), LinesCodec::new_with_max_length(MAX_COMMAND_BYTES));
    while let Some(line) = lines.next().await {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                write_json(
                    &output,
                    &json!({
                        "type": "error",
                        "code": "command-too-large",
                        "message": error.to_string(),
                    }),
                )
                .await?;
                // A malformed over-limit control frame means the stdio
                // protocol is no longer trustworthy. Exit fail-closed rather
                // than leaving observer tasks alive without a command owner.
                std::process::exit(2);
            }
        };
        let command: Command = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                write_json(
                    &output,
                    &json!({
                        "type": "error",
                        "code": "invalid-command",
                        "message": error.to_string(),
                    }),
                )
                .await?;
                continue;
            }
        };
        match command {
            Command::Invoke {
                request_id,
                tool_name,
                arguments,
            } => {
                let host = Arc::clone(&host);
                let output = Arc::clone(&output);
                tokio::spawn(async move {
                    let args = arguments.as_object().cloned().unwrap_or_default();
                    let result = host.invoke_legacy_tool(&tool_name, &args).await;
                    let payload = match result {
                        Ok(result) => {
                            json!({ "type": "result", "requestId": request_id, "result": result })
                        }
                        Err(error) => json!({
                            "type": "result",
                            "requestId": request_id,
                            "result": { "ok": false, "error": error.to_string() },
                        }),
                    };
                    let _ = write_json(&output, &payload).await;
                });
            }
            Command::Interrupt { request_id } => {
                let result = host.interrupt(&request_id).await;
                write_json(
                    &output,
                    &json!({
                        "type": "interruptResult",
                        "requestId": request_id,
                        "interrupted": result.unwrap_or(false),
                    }),
                )
                .await?;
            }
            Command::ApprovalResponse {
                request_id,
                approved,
                reason,
            } => {
                let pending = pending_approvals
                    .lock()
                    .ok()
                    .and_then(|mut approvals| approvals.remove(&request_id));
                let Some(pending) = pending else {
                    write_json(
                        &output,
                        &approval_result(&request_id, false, "approval-not-pending"),
                    )
                    .await?;
                    continue;
                };
                if pending.expires_at_ms <= now_ms() {
                    write_json(
                        &output,
                        &approval_result(&request_id, false, "approval-expired"),
                    )
                    .await?;
                    continue;
                }
                let (completion_tx, completion_rx) = oneshot::channel();
                if approval_tx
                    .send(ToolboxApprovalResponse {
                        request_id: request_id.clone(),
                        approved,
                        reason,
                        completion: Some(completion_tx),
                    })
                    .await
                    .is_err()
                {
                    write_json(
                        &output,
                        &approval_result(&request_id, false, "vcplog-offline"),
                    )
                    .await?;
                    continue;
                }
                let result = tokio::time::timeout(Duration::from_secs(10), completion_rx).await;
                let (written, error) = match result {
                    Ok(Ok(Ok(()))) => (true, None),
                    Ok(Ok(Err(error))) => (false, Some(error)),
                    Ok(Err(_)) => (false, Some("vcplog-writer-stopped".to_string())),
                    Err(_) => (false, Some("vcplog-write-timeout".to_string())),
                };
                write_json(
                    &output,
                    &json!({
                        "type": "approvalResult",
                        "requestId": request_id,
                        "written": written,
                        "error": error,
                    }),
                )
                .await?;
            }
            Command::Shutdown => {
                fail_closed_pending(&approval_tx, &pending_approvals).await;
                break;
            }
        }
    }
    Ok(())
}

fn spawn_log_observer(
    host: Arc<DirectToolboxHost>,
    device_name: String,
    mut approval_rx: mpsc::Receiver<ToolboxApprovalResponse>,
    event_tx: mpsc::Sender<Value>,
    pending: Arc<StdMutex<HashMap<String, PendingApproval>>>,
    seen: Arc<StdMutex<HashMap<String, i64>>>,
    reconnect_base_ms: u64,
) {
    tokio::spawn(async move {
        let mut attempt = 0_u32;
        loop {
            let pending_for_event = Arc::clone(&pending);
            let seen_for_event = Arc::clone(&seen);
            let tx = event_tx.clone();
            let connected_tx = event_tx.clone();
            let result = host
                .run_log_websocket_with_status(
                    &device_name,
                    &mut approval_rx,
                    move |status| {
                        let _ = connected_tx.try_send(json!({
                            "type": "event",
                            "channel": "log-status",
                            "event": {
                                "state": "connected",
                                "endpoint": status.endpoint,
                                "latencyMs": status.latency_ms,
                            },
                        }));
                    },
                    move |event| {
                        if let Some(value) =
                            log_event_value(event, &pending_for_event, &seen_for_event)
                        {
                            let _ = tx.try_send(value);
                        }
                    },
                )
                .await;
            attempt = attempt.saturating_add(1);
            let _ = event_tx
                .send(json!({
                    "type": "event",
                    "channel": "log-status",
                    "event": {
                        "state": "disconnected",
                        "attempt": attempt,
                        "error": result.err().map(|error| error.to_string()),
                    },
                }))
                .await;
            let delay_ms = reconnect_delay_ms(attempt, reconnect_base_ms, now_ms() as u64);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
    });
}

fn spawn_info_observer(
    host: Arc<DirectToolboxHost>,
    event_tx: mpsc::Sender<Value>,
    reconnect_base_ms: u64,
) {
    tokio::spawn(async move {
        let mut attempt = 0_u32;
        loop {
            let tx = event_tx.clone();
            let connected_tx = event_tx.clone();
            let result = host
                .observe_websocket_with_status(
                    ToolboxWsChannel::Info,
                    move |status| {
                        let _ = connected_tx.try_send(json!({
                            "type": "event",
                            "channel": "info-status",
                            "event": {
                                "state": "connected",
                                "endpoint": status.endpoint,
                                "latencyMs": status.latency_ms,
                            },
                        }));
                    },
                    move |event| {
                        if let ToolboxWsEvent::Info(value) = event {
                            let _ = tx.try_send(
                                json!({ "type": "event", "channel": "info", "event": value }),
                            );
                        }
                    },
                )
                .await;
            attempt = attempt.saturating_add(1);
            let _ = event_tx
                .send(json!({
                    "type": "event",
                    "channel": "info-status",
                    "event": {
                        "state": "disconnected",
                        "attempt": attempt,
                        "error": result.err().map(|error| error.to_string()),
                    },
                }))
                .await;
            let delay_ms = reconnect_delay_ms(attempt, reconnect_base_ms, now_ms() as u64);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }
    });
}

fn reconnect_base_delay_ms() -> u64 {
    let configured = env::var("VCP_TOOLBOX_RECONNECT_BASE_MS").ok();
    reconnect_base_delay_ms_for(configured.as_deref())
}

fn reconnect_base_delay_ms_for(configured: Option<&str>) -> u64 {
    configured
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000)
        .clamp(250, 60_000)
}

/// Exponential reconnect with bounded ±20% jitter. The seed is injected so
/// the policy is deterministic in tests and does not require a new RNG/
/// telemetry dependency in the bridge process.
fn reconnect_delay_ms(attempt: u32, base_ms: u64, jitter_seed: u64) -> u64 {
    let base_ms = base_ms.clamp(250, 60_000);
    let exponent = attempt.saturating_sub(1).min(5);
    let capped = base_ms.saturating_mul(1_u64 << exponent).min(60_000);
    let span = (capped / 5).max(1);
    let range = span.saturating_mul(2).saturating_add(1);
    let offset = (jitter_seed % range) as i64 - span as i64;
    ((capped as i64 + offset).max(250) as u64).min(60_000)
}

fn log_event_value(
    event: ToolboxWsEvent,
    pending: &Arc<StdMutex<HashMap<String, PendingApproval>>>,
    seen: &Arc<StdMutex<HashMap<String, i64>>>,
) -> Option<Value> {
    match event {
        ToolboxWsEvent::BackendApprovalRequest(value) => {
            let data = value.get("data").unwrap_or(&value);
            let request_id = data.get("requestId")?.as_str()?.to_string();
            let ttl_ms = data
                .get("approvalTtlMs")
                .and_then(Value::as_i64)
                .unwrap_or(120_000)
                .clamp(1_000, 10 * 60_000);
            let expires_at_ms = now_ms().saturating_add(ttl_ms);
            if let Ok(mut seen_ids) = seen.lock() {
                let now = now_ms();
                seen_ids.retain(|_, expires_at| *expires_at > now);
                if seen_ids.contains_key(&request_id) {
                    return None;
                }
                if seen_ids.len() >= 1_024 {
                    if let Some(oldest) = seen_ids
                        .iter()
                        .min_by_key(|(_, expires_at)| **expires_at)
                        .map(|(request_id, _)| request_id.clone())
                    {
                        seen_ids.remove(&oldest);
                    }
                }
                seen_ids.insert(request_id.clone(), expires_at_ms);
            }
            if let Ok(mut approvals) = pending.lock() {
                approvals.insert(request_id.clone(), PendingApproval { expires_at_ms });
            }
            Some(json!({
                "type": "event",
                "channel": "backend-approval",
                "event": {
                    "requestId": request_id,
                    "expiresAtMs": expires_at_ms,
                    "replay": value.get("_vcpReplay").and_then(Value::as_bool).unwrap_or(false),
                    "data": data,
                },
            }))
        }
        ToolboxWsEvent::Log(entry) => Some(json!({
            "type": "event",
            "channel": "log",
            "event": entry,
        })),
        ToolboxWsEvent::DistributedExecutionIgnored(value) => Some(json!({
            "type": "event",
            "channel": "distributed-ignored",
            "event": value,
        })),
        ToolboxWsEvent::Info(_) => None,
    }
}

async fn fail_closed_pending(
    approval_tx: &mpsc::Sender<ToolboxApprovalResponse>,
    pending: &Arc<StdMutex<HashMap<String, PendingApproval>>>,
) {
    let request_ids = pending
        .lock()
        .map(|mut approvals| approvals.drain().map(|(id, _)| id).collect::<Vec<_>>())
        .unwrap_or_default();
    for request_id in request_ids {
        let _ = approval_tx
            .send(ToolboxApprovalResponse {
                request_id,
                approved: false,
                reason: Some("VChat Workbench closed".to_string()),
                completion: None,
            })
            .await;
    }
}

fn approval_result(request_id: &str, written: bool, error: &str) -> Value {
    json!({
        "type": "approvalResult",
        "requestId": request_id,
        "written": written,
        "error": error,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

async fn write_json(
    output: &Arc<Mutex<tokio::io::Stdout>>,
    value: &Value,
) -> Result<(), std::io::Error> {
    let mut output = output.lock().await;
    output
        .write_all(
            serde_json::to_string(value)
                .unwrap_or_else(|_| "{}".to_string())
                .as_bytes(),
        )
        .await?;
    output.write_all(b"\n").await?;
    output.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_backoff_is_bounded_exponential_and_jittered() {
        let first = reconnect_delay_ms(1, 1_000, 0);
        let second = reconnect_delay_ms(2, 1_000, 1);
        let capped = reconnect_delay_ms(99, 60_000, u64::MAX);
        assert!((800..=1_200).contains(&first));
        assert!((1_600..=2_400).contains(&second));
        assert!((48_000..=60_000).contains(&capped));
        assert_eq!(reconnect_base_delay_ms_for(Some("1")), 250);
        assert_eq!(reconnect_base_delay_ms_for(Some("70000")), 60_000);
        assert_eq!(reconnect_base_delay_ms_for(Some("invalid")), 1_000);
    }

    #[test]
    fn backend_approval_replay_is_projected_once() {
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let seen = Arc::new(StdMutex::new(HashMap::new()));
        let approval = || {
            ToolboxWsEvent::BackendApprovalRequest(json!({
                "type": "tool_approval_request",
                "_vcpReplay": true,
                "data": {
                    "requestId": "approval-1",
                    "approvalTtlMs": 30_000,
                    "toolName": "PowerShellExecutor"
                }
            }))
        };

        assert!(log_event_value(approval(), &pending, &seen).is_some());
        assert!(log_event_value(approval(), &pending, &seen).is_none());
        assert_eq!(pending.lock().expect("pending lock").len(), 1);
    }
}
