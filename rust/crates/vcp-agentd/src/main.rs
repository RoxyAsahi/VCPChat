//! Supervised VCP Agent daemon. It has no credentials and no network listener.

use anyhow::Result;
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{Stdout, stdin, stdout};
use tokio::sync::mpsc;
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};
use vcp_agent_core::CoreRuntime;
use vcp_agent_host::{
    HostCommand, HostEvent, RuntimeOverrides, TuiSettingsUpdate, load_config, start,
    start_without_index_rebuild,
};
use vcp_agent_protocol::{
    PROTOCOL_REVISION, PROTOCOL_VERSION, WireMessage, codec, read_message, validate_direct_command,
    validate_direct_daemon_message, write_message,
};

fn build_revision() -> &'static str {
    option_env!("VCP_AGENT_BUILD_REVISION").unwrap_or("unknown")
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().skip(1).any(|arg| arg == "--direct") {
        return direct_main().await;
    }
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<WireMessage>(256);
    let mut runtime = CoreRuntime::new(outbound_tx.clone());
    let mut reader = FramedRead::new(stdin(), codec());
    let mut writer = FramedWrite::new(stdout(), codec());

    let ready = WireMessage::new("ready").put(
        "probe",
        serde_json::json!({
            "available": true,
            "runtime": "rust",
            "details": "VCP Rust daemon; credentials remain in the host"
        }),
    );
    let mut ready = ready;
    ready.protocol_version = Some(PROTOCOL_VERSION);
    write_message(&mut writer, &ready).await?;

    loop {
        tokio::select! {
            outbound = outbound_rx.recv() => {
                match outbound {
                    Some(message) => write_message(&mut writer, &message).await?,
                    None => break,
                }
            }
            inbound = read_message(&mut reader) => {
                match inbound? {
                    Some(message) if message.kind == "shutdown" => {
                        let ack = WireMessage::new("ack").with_request_id(message.request_id.unwrap_or_default()).put("ok", true);
                        write_message(&mut writer, &ack).await?;
                        break;
                    }
                    Some(message) if message.kind == "hello" => {
                        if message.protocol_version != Some(PROTOCOL_VERSION) {
                            let fatal = WireMessage::new("fatal").put("error", format!("protocol mismatch: expected {PROTOCOL_VERSION}"));
                            write_message(&mut writer, &fatal).await?;
                            break;
                        }
                        let ack = WireMessage::new("ack")
                            .with_request_id(message.request_id.unwrap_or_default())
                            .put("ok", true)
                            .put("result", serde_json::json!({ "protocolVersion": PROTOCOL_VERSION }));
                        write_message(&mut writer, &ack).await?;
                    }
                    Some(message) => {
                        if let Err(error) = runtime.handle(message).await {
                            let fatal = WireMessage::new("fatal").put("error", error.to_string());
                            write_message(&mut writer, &fatal).await?;
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }
    Ok(())
}

/// Rust-hosted daemon mode used by VCPChat after the JS/Pi bridge is retired.
/// The daemon reads the shared VCP settings itself; Electron only sends UI
/// intent and forwards these framed events to its restricted preload API.
async fn direct_main() -> Result<()> {
    let mut overrides = RuntimeOverrides::default();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--settings-path" => overrides.settings_path = args.next().map(PathBuf::from),
            "--agents-dir" => overrides.agents_dir = args.next().map(PathBuf::from),
            "--model" => overrides.model = args.next(),
            "--agent" => overrides.agent = args.next(),
            "--resume" => overrides.resume = args.next(),
            "--workspace" => overrides.workspace = args.next().map(PathBuf::from),
            "--always-approve" | "--yolo" => overrides.always_approve = true,
            "--control" => overrides.control_only = true,
            _ => {}
        }
    }
    // GUI transport starts as a lease-free control Host.  Selecting a Topic
    // must not acquire it or restart this stdio process; a writable Host is
    // created only by `switch-attachment` immediately before a real turn.
    let initial_overrides = overrides.clone();
    let config = load_config(overrides)?;
    let mut active_overrides = (!config.control_only).then_some(initial_overrides.clone());
    let mut host = start(config)?;
    let mut reader = FramedRead::new(stdin(), codec());
    let mut writer = FramedWrite::new(stdout(), codec());
    let mut ready = WireMessage::new("ready").put(
        "probe",
        serde_json::json!({
            "available": true, "runtime": "rust", "hosted": true,
            "details": "VCP Rust daemon with direct ToolBox host"
        }),
    );
    ready.protocol_version = Some(PROTOCOL_VERSION);
    ready
        .payload
        .insert("protocolRevision".into(), PROTOCOL_REVISION.into());
    ready
        .payload
        .insert("buildRevision".into(), build_revision().into());
    write_direct_message(&mut writer, &ready).await?;
    let mut recent_ids = HashSet::new();
    let mut recent_order = VecDeque::new();
    let mut event_sequence = 0_u64;
    loop {
        tokio::select! {
            Some(event) = host.events.recv() => {
                if let Some(mut message) = host_event_message(event) {
                    if message.kind == "event" {
                        event_sequence = event_sequence.saturating_add(1);
                        project_event_envelope(
                            &mut message,
                            &host.session_id,
                            &host.topic_id,
                            event_sequence,
                        );
                    }
                    project_topic_snapshot_watermark(&mut message, event_sequence);
                    write_direct_message(&mut writer, &message).await?;
                }
            }
            inbound = read_message(&mut reader) => match inbound? {
                Some(message) => {
                    if let Err(error) = validate_direct_command(&message) {
                        let fatal = WireMessage::new("fatal").put("error", error.to_string());
                        write_direct_message(&mut writer, &fatal).await?;
                        break;
                    }
                    let request_id = message.request_id.clone().expect("validated requestId");
                    if !recent_ids.insert(request_id.clone()) {
                        let fatal = WireMessage::new("fatal").put("error", "duplicate requestId");
                        write_direct_message(&mut writer, &fatal).await?;
                        break;
                    }
                    recent_order.push_back(request_id);
                    if recent_order.len() > 1024 && let Some(old) = recent_order.pop_front() {
                        recent_ids.remove(&old);
                    }
                    if message.kind == "shutdown" {
                        host.shutdown().await;
                        let ack = WireMessage::new("ack")
                            .with_request_id(message.request_id.expect("validated requestId"))
                            .put("ok", true);
                        write_direct_message(&mut writer, &ack).await?;
                        break;
                    }
                    if message.kind == "switch-attachment" {
                        let mut lifecycle = Vec::new();
                        let response = switch_direct_attachment(
                            &mut host,
                            &initial_overrides,
                            &mut active_overrides,
                            &message,
                            &mut lifecycle,
                        ).await;
                        // These lifecycle events are informational; the ACK is
                        // the only success authority for the Electron manager.
                        // They are still emitted with final daemon identities
                        // so observers never infer a switch from a Host warning
                        // or an uncorrelated status frame.
                        for mut event in lifecycle {
                            event_sequence = event_sequence.saturating_add(1);
                            project_event_envelope(
                                &mut event,
                                &host.session_id,
                                &host.topic_id,
                                event_sequence,
                            );
                            write_direct_message(&mut writer, &event).await?;
                        }
                        write_direct_message(&mut writer, &response).await?;
                        continue;
                    }
                    if message.kind == "close-session" {
                        let response = close_direct_attachment(
                            &mut host,
                            &initial_overrides,
                            &mut active_overrides,
                            &message,
                        ).await;
                        write_direct_message(&mut writer, &response).await?;
                        continue;
                    }
                    if message.kind == "hello" {
                        let ack = WireMessage::new("ack")
                            .with_request_id(message.request_id.expect("validated requestId"))
                            .put("ok", true)
                            .put("result", serde_json::json!({"protocolVersion": PROTOCOL_VERSION, "hosted": true}));
                        write_direct_message(&mut writer, &ack).await?;
                        continue;
                    }
                    if let Some(response) = dispatch_direct(&host, message) {
                        write_direct_message(&mut writer, &response).await?;
                    }
                }
                None => { host.shutdown().await; break; }
            }
        }
    }
    Ok(())
}

fn direct_ack(request_id: String, result: serde_json::Value) -> WireMessage {
    WireMessage::new("ack")
        .with_request_id(request_id)
        .put("ok", true)
        .put("result", result)
}

fn direct_error(request_id: String, code: &str, error: impl Into<String>) -> WireMessage {
    WireMessage::new("ack")
        .with_request_id(request_id)
        .put("ok", false)
        .put(
            "result",
            serde_json::json!({ "code": code, "error": error.into() }),
        )
}

fn control_overrides(base: &RuntimeOverrides) -> RuntimeOverrides {
    let mut control = base.clone();
    control.control_only = true;
    control.resume = None;
    control
}

fn attachment_overrides(base: &RuntimeOverrides, message: &WireMessage) -> RuntimeOverrides {
    let mut target = base.clone();
    target.control_only = false;
    target.resume = message.string("topicId").map(ToOwned::to_owned);
    if let Some(value) = message.string("agentId") {
        target.agent = Some(value.to_string());
    }
    if let Some(value) = message.string("model") {
        target.model = Some(value.to_string());
    }
    if let Some(value) = message.string("workspaceRoot") {
        target.workspace = Some(PathBuf::from(value));
    }
    target.always_approve = matches!(message.string("permissionMode"), Some("always-approve"));
    target
}

async fn restore_control_host(
    host: &mut vcp_agent_host::RunningHost,
    base: &RuntimeOverrides,
) -> Result<()> {
    let config = load_config(control_overrides(base))?;
    *host = start_without_index_rebuild(config)?;
    Ok(())
}

async fn switch_direct_attachment(
    host: &mut vcp_agent_host::RunningHost,
    base: &RuntimeOverrides,
    active_overrides: &mut Option<RuntimeOverrides>,
    message: &WireMessage,
    lifecycle: &mut Vec<WireMessage>,
) -> WireMessage {
    let request_id = message.request_id.clone().unwrap_or_default();
    if let Some(expected_session) = message.session_id.as_deref() {
        if active_overrides.is_none() || expected_session != host.session_id {
            return direct_error(
                request_id,
                "attachment-mismatch",
                "current Rust attachment does not match sessionId",
            );
        }
    }

    let target = attachment_overrides(base, message);
    let next_config = match load_config(target.clone()) {
        Ok(config) => config,
        Err(error) => {
            let code = if error.to_string().contains("workspace") {
                "invalid-workspace"
            } else {
                "invalid-topic"
            };
            return direct_error(request_id, code, error.to_string());
        }
    };

    if active_overrides.is_some() {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        if host
            .commands
            .send(HostCommand::PrepareSwitch { reply: reply_tx })
            .is_err()
        {
            return direct_error(
                request_id,
                "attachment-busy",
                "current Rust attachment is unavailable",
            );
        }
        match reply_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(reason)) => {
                return direct_error(
                    request_id,
                    &reason,
                    "current Topic has a running turn, approval, or queued interaction",
                );
            }
            Err(_) => {
                return direct_error(
                    request_id,
                    "attachment-busy",
                    "current Rust attachment stopped before it could be released",
                );
            }
        }
    }

    let previous = active_overrides.clone();
    let previous_identity = previous
        .as_ref()
        .map(|_| (host.session_id.clone(), host.topic_id.clone()));
    host.shutdown().await;
    match start_without_index_rebuild(next_config) {
        Ok(next) => {
            if let Some((session_id, topic_id)) = previous_identity {
                lifecycle.push(attachment_lifecycle_event(
                    "session.detached",
                    &session_id,
                    &topic_id,
                    serde_json::json!({ "reason": "switch-attachment" }),
                ));
            }
            lifecycle.push(attachment_lifecycle_event(
                "session.attached",
                &next.session_id,
                &next.topic_id,
                serde_json::json!({ "reason": "switch-attachment" }),
            ));
            lifecycle.push(attachment_lifecycle_event(
                "runtime.ready",
                &next.session_id,
                &next.topic_id,
                serde_json::json!({ "attachment": true }),
            ));
            let result = serde_json::json!({
                "sessionId": next.session_id,
                "topicId": next.topic_id,
                "agentId": target.agent.clone().unwrap_or_else(|| "Nova".to_string()),
                "model": target.model.clone().unwrap_or_default(),
                "workspaceRoot": target.workspace.as_ref().map(|path| path.display().to_string()).unwrap_or_default(),
                "attached": true,
            });
            *host = next;
            *active_overrides = Some(target);
            direct_ack(request_id, result)
        }
        Err(error) => {
            // Acquiring the target lease failed after the old Host was safely
            // closed. Restore the previous attachment (or control Host) so a
            // rejected switch never leaves a live daemon with a phantom UI
            // attachment.
            let restore = previous.clone().unwrap_or_else(|| control_overrides(base));
            match load_config(restore).and_then(start_without_index_rebuild) {
                Ok(restored) => {
                    *host = restored;
                    *active_overrides = previous;
                }
                Err(restore_error) => {
                    return direct_error(
                        request_id,
                        "attachment-restore-failed",
                        format!("{error}; restore failed: {restore_error}"),
                    );
                }
            }
            let code = if error.to_string().contains("lease") || error.to_string().contains("TOPIC")
            {
                "topic-in-use"
            } else {
                "invalid-topic"
            };
            direct_error(request_id, code, error.to_string())
        }
    }
}

/// Lifecycle projection for direct-daemon attachment changes.  The nested
/// event carries all durable routing values before the outbound projector adds
/// `sequence`, `eventId`, `timestamp` and `runtime`; consumers can therefore
/// observe old and new attachments without guessing from the currently active
/// Host at write time.
fn attachment_lifecycle_event(
    event_type: &str,
    session_id: &str,
    topic_id: &str,
    payload: serde_json::Value,
) -> WireMessage {
    let mut message = WireMessage::new("event").put(
        "event",
        serde_json::json!({
            "type": event_type,
            "sessionId": session_id,
            "topicId": topic_id,
            "payload": payload,
        }),
    );
    message.session_id = Some(session_id.to_string());
    message
}

async fn close_direct_attachment(
    host: &mut vcp_agent_host::RunningHost,
    base: &RuntimeOverrides,
    active_overrides: &mut Option<RuntimeOverrides>,
    message: &WireMessage,
) -> WireMessage {
    let request_id = message.request_id.clone().unwrap_or_default();
    if active_overrides.is_none() || message.session_id.as_deref() != Some(host.session_id.as_str())
    {
        return direct_error(
            request_id,
            "attachment-mismatch",
            "current Rust attachment does not match sessionId",
        );
    }
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if host
        .commands
        .send(HostCommand::PrepareSwitch { reply: reply_tx })
        .is_err()
        || !matches!(reply_rx.await, Ok(Ok(())))
    {
        return direct_error(
            request_id,
            "attachment-busy",
            "current Topic has a running turn, approval, or queued interaction",
        );
    }
    host.shutdown().await;
    match restore_control_host(host, base).await {
        Ok(()) => {
            *active_overrides = None;
            direct_ack(request_id, serde_json::json!({ "closed": true }))
        }
        Err(error) => direct_error(request_id, "attachment-restore-failed", error.to_string()),
    }
}

async fn write_direct_message(
    writer: &mut FramedWrite<Stdout, LengthDelimitedCodec>,
    message: &WireMessage,
) -> Result<()> {
    validate_direct_daemon_message(message)?;
    write_message(writer, message).await?;
    Ok(())
}

fn dispatch_direct(
    host: &vcp_agent_host::RunningHost,
    message: WireMessage,
) -> Option<WireMessage> {
    let request_id = message.request_id.clone().unwrap_or_default();
    let mut ack = WireMessage::new("ack")
        .with_request_id(request_id.clone())
        .put("ok", true);
    match message.kind.as_str() {
        // A GUI session is an ephemeral attachment to one durable Agent Topic.
        // Return both identities so hosts never have to guess which checkpoint
        // should be resumed after their renderer reloads.
        "create-session" => {
            ack = ack.put(
                "result",
                serde_json::json!({
                    "sessionId": host.session_id,
                    "topicId": host.topic_id,
                }),
            );
            Some(ack)
        }
        "close-session" => { let _ = host.commands.send(HostCommand::Shutdown); Some(ack) }
        "import-attachment" => {
            let path = PathBuf::from(message.string("path").unwrap_or(""));
            let _ = host.commands.send(HostCommand::ImportAttachment { request_id, path });
            Some(ack)
        }
        "start-turn" => {
            let prompt = message.string("prompt").unwrap_or("").trim().to_string();
            let attachments = message
                .value("attachments")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            if prompt.is_empty() && attachments.is_empty() {
                Some(ack.put("ok", false).put("result", serde_json::json!({"error":"prompt or attachment is required"})))
            } else {
                // v1.5 requires turnId in the declared envelope. An incomplete
                // frame is rejected before dispatch; never revive a legacy
                // payload identity here.
                let turn_id = message.turn_id.clone();
                let _ = host.commands.send(HostCommand::StartTurn { prompt, attachments, turn_id });
                Some(ack)
            }
        }
        "cancel-turn" => { let _ = host.commands.send(HostCommand::Cancel); Some(ack) }
        "steer-turn" => { let _ = host.commands.send(HostCommand::Steer { prompt: message.string("prompt").unwrap_or("").to_string() }); Some(ack) }
        "follow-up-turn" => { let _ = host.commands.send(HostCommand::FollowUp { prompt: message.string("prompt").unwrap_or("").to_string() }); Some(ack) }
        "list-topics" => { let _ = host.commands.send(HostCommand::ListTopics { request_id, agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "read-topic" => { let _ = host.commands.send(HostCommand::ReadTopic { request_id, topic_id: message.string("topicId").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "search-topics" => { let _ = host.commands.send(HostCommand::SearchTopics { request_id, query: message.string("query").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned), limit: message.value("limit").and_then(serde_json::Value::as_u64).and_then(|value| usize::try_from(value).ok()).unwrap_or(20) }); Some(ack) }
        "search-topic-messages" => { let _ = host.commands.send(HostCommand::SearchTopicMessages { request_id, query: message.string("query").unwrap_or("").to_string(), topic_id: message.string("topicId").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned), limit: message.value("limit").and_then(serde_json::Value::as_u64).and_then(|value| usize::try_from(value).ok()).unwrap_or(50) }); Some(ack) }
        "get-index-status" => { let _ = host.commands.send(HostCommand::GetIndexStatus { request_id }); Some(ack) }
        "rebuild-topic-index" => { let _ = host.commands.send(HostCommand::RebuildTopicIndex { request_id }); Some(ack) }
        "takeover-topic" => { let _ = host.commands.send(HostCommand::RequestTopicTakeover { request_id: request_id.clone(), topic_id: message.string("topicId").unwrap_or("").to_string(), requester_id: request_id, agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "list-interaction-queue" => { let _ = host.commands.send(HostCommand::ListInteractionQueue { request_id }); Some(ack) }
        "rename-topic" => { let _ = host.commands.send(HostCommand::RenameTopic { request_id, topic_id: message.string("topicId").unwrap_or("").to_string(), title: message.string("title").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "delete-topic" => { let _ = host.commands.send(HostCommand::DeleteTopic { request_id, topic_id: message.string("topicId").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "clear-interaction-queue" => { let _ = host.commands.send(HostCommand::ClearInteractionQueue { request_id }); Some(ack) }
        "set-workbench-presence" => {
            let mounted = message.bool("mounted").unwrap_or(false);
            let _ = host.commands.send(HostCommand::WorkbenchPresence { request_id, mounted });
            Some(ack)
        }
        "replace-interaction-queue" => {
            let Some(interactions) = message.value("interactions").and_then(serde_json::Value::as_array) else {
                return Some(ack.put("ok", false).put("result", serde_json::json!({"error":"interactions must be an array"})));
            };
            let _ = host.commands.send(HostCommand::ReplaceInteractionQueue { request_id, interactions: interactions.clone() });
            Some(ack)
        }
        "compact" => { let _ = host.commands.send(HostCommand::Compact); Some(ack) }
        "get-settings" => { let _ = host.commands.send(HostCommand::GetSettings { request_id }); Some(ack) }
        "update-settings" => {
            let update = message.value("settings").cloned().and_then(|value| serde_json::from_value::<TuiSettingsUpdate>(value).ok());
            if let Some(update) = update { let _ = host.commands.send(HostCommand::UpdateSettings { request_id, update }); Some(ack) } else { Some(ack.put("ok", false).put("result", serde_json::json!({"error":"invalid settings payload"}))) }
        }
        "approval" => {
            let approval_id = message.string("approvalId").unwrap_or("").to_string();
            let allowed = message.bool("allowed").or_else(|| message.string("decision").map(|value| value == "allow")).unwrap_or(false);
            let binding = Some((
                message.string("sessionId").or(message.session_id.as_deref()).unwrap_or("").to_string(),
                message.string("turnId").or(message.turn_id.as_deref()).unwrap_or("").to_string(),
                message.string("toolCallId").or(message.tool_call_id.as_deref()).unwrap_or("").to_string(),
                message.string("argumentsHash").unwrap_or("").to_string(),
            ));
            let _ = host.commands.send(HostCommand::Approval { approval_id, allowed, binding }); Some(ack)
        }
        "toolbox-approval" => {
            let approval_request_id = message.string("approvalRequestId").unwrap_or("").to_string();
            let approved = message.bool("approved").unwrap_or(false);
            let reason = message.string("reason").map(ToOwned::to_owned);
            let _ = host.commands.send(HostCommand::ToolboxApproval {
                request_id,
                approval_request_id,
                approved,
                reason,
            });
            Some(ack)
        }
        _ => Some(ack.put("ok", false).put("result", serde_json::json!({"error": format!("unsupported direct daemon command: {}", message.kind)}))),
    }
}

fn project_event_envelope(
    message: &mut WireMessage,
    default_session_id: &str,
    topic_id: &str,
    sequence: u64,
) {
    if message.kind != "event" {
        return;
    }
    // Rust Host puts routing identity in the framed-message envelope. GUI
    // stores and TUI projections consume the nested `event` value, though;
    // without this projection their Tool cards have no stable toolCallId and
    // are silently discarded. These are correlation identifiers, never
    // credentials or raw tool arguments.
    let session_id = message
        .session_id
        .clone()
        .unwrap_or_else(|| default_session_id.to_string());
    let turn_id = message.turn_id.clone();
    let tool_call_id = message.tool_call_id.clone();
    let Some(serde_json::Value::Object(event)) = message.payload.get_mut("event") else {
        return;
    };
    event
        .entry("sessionId")
        .or_insert(serde_json::Value::String(session_id.clone()));
    if let Some(value) = turn_id {
        event
            .entry("turnId")
            .or_insert(serde_json::Value::String(value));
    }
    if let Some(value) = tool_call_id {
        event
            .entry("toolCallId")
            .or_insert(serde_json::Value::String(value));
    }
    event
        .entry("topicId")
        .or_insert(serde_json::Value::String(topic_id.to_string()));
    event
        .entry("sequence")
        .or_insert(serde_json::Value::from(sequence));
    event
        .entry("eventId")
        .or_insert(serde_json::Value::String(format!(
            "{session_id}:{sequence}"
        )));
    event.entry("timestamp").or_insert(serde_json::Value::from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    ));
    event
        .entry("runtime")
        .or_insert(serde_json::Value::String("rust".to_string()));
}

fn project_topic_snapshot_watermark(message: &mut WireMessage, event_sequence: u64) {
    if message.kind != "control-event" || message.string("kind") != Some("topic-read-only") {
        return;
    }
    if let Some(serde_json::Value::Object(payload)) = message.payload.get_mut("payload") {
        payload
            .entry("snapshotSequence")
            .or_insert(serde_json::Value::from(event_sequence));
    }
}

fn host_event_message(event: HostEvent) -> Option<WireMessage> {
    match event {
        HostEvent::Wire(message) => {
            Some(message)
        }
        HostEvent::Warning(message) => Some(WireMessage::new("event").put("event", serde_json::json!({"type":"runtime.warning", "payload":{"message":message}}))),
        HostEvent::ToolboxWs { channel, kind, payload } => Some(WireMessage::new("event").put("event", serde_json::json!({"type":"toolbox.ws", "payload":{"channel":channel,"kind":kind,"value":payload}}))),
        HostEvent::Approval(request) => Some(WireMessage::new("event").put("event", serde_json::json!({"type":"approval.requested", "sessionId":request.session_id, "turnId":request.turn_id, "toolCallId":request.tool_call_id, "payload":{"approvalId":request.approval_id,"toolName":request.tool_name,"riskLevel":request.risk,"reason":request.reason,"argumentSummary":request.argument_summary,"argumentsHash":request.arguments_hash,"expiresAtMs":request.expires_at_ms}}))),
        HostEvent::Control { request_id, kind, payload } => {
            Some(WireMessage::new("control-event")
                .put("kind", kind)
                .put("payload", payload)
                .with_request_id(request_id))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_events_copy_routing_ids_into_the_nested_event() {
        let mut message = WireMessage::new("event").put(
            "event",
            serde_json::json!({ "type": "tool.completed", "payload": { "toolName": "FileOperator" } }),
        );
        message.session_id = Some("session-1".into());
        message.turn_id = Some("turn-1".into());
        message.tool_call_id = Some("call-1".into());

        let mut projected = host_event_message(HostEvent::Wire(message)).expect("wire event");
        project_event_envelope(&mut projected, "session-default", "topic-1", 7);
        let event = projected.value("event").expect("nested event");
        assert_eq!(
            event.get("sessionId").and_then(serde_json::Value::as_str),
            Some("session-1")
        );
        assert_eq!(
            event.get("turnId").and_then(serde_json::Value::as_str),
            Some("turn-1")
        );
        assert_eq!(
            event.get("toolCallId").and_then(serde_json::Value::as_str),
            Some("call-1")
        );
        assert_eq!(
            event.get("topicId").and_then(serde_json::Value::as_str),
            Some("topic-1")
        );
        assert_eq!(
            event.get("sequence").and_then(serde_json::Value::as_u64),
            Some(7)
        );
        assert_eq!(
            event.get("eventId").and_then(serde_json::Value::as_str),
            Some("session-1:7")
        );
        assert_eq!(
            event.get("runtime").and_then(serde_json::Value::as_str),
            Some("rust")
        );
        assert!(
            event
                .get("timestamp")
                .and_then(serde_json::Value::as_u64)
                .is_some()
        );
    }

    #[test]
    fn wire_event_does_not_overwrite_explicit_nested_ids() {
        let mut message = WireMessage::new("event").put(
            "event",
            serde_json::json!({ "type": "tool.completed", "sessionId": "inner-session" }),
        );
        message.session_id = Some("outer-session".into());
        project_event_envelope(&mut message, "session-default", "topic-1", 1);
        assert_eq!(
            message
                .value("event")
                .and_then(|event| event.get("sessionId"))
                .and_then(serde_json::Value::as_str),
            Some("inner-session")
        );
    }

    #[test]
    fn direct_start_turn_reads_the_declared_turn_id_envelope_field() {
        let mut message = WireMessage::new("start-turn");
        message.turn_id = Some("gui-turn".into());
        assert_eq!(
            message
                .turn_id
                .clone()
                .or_else(|| message.string("turnId").map(ToOwned::to_owned)),
            Some("gui-turn".into())
        );
    }
}
