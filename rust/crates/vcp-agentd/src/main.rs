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
            _ => {}
        }
    }
    let config = load_config(overrides)?;
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
                        let _ = host.commands.send(HostCommand::Shutdown);
                        let ack = WireMessage::new("ack")
                            .with_request_id(message.request_id.expect("validated requestId"))
                            .put("ok", true);
                        write_direct_message(&mut writer, &ack).await?;
                        break;
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
                None => { let _ = host.commands.send(HostCommand::Shutdown); break; }
            }
        }
    }
    Ok(())
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
        "start-turn" => {
            let prompt = message.string("prompt").unwrap_or("").trim().to_string();
            if prompt.is_empty() {
                Some(ack.put("ok", false).put("result", serde_json::json!({"error":"prompt is required"})))
            } else {
                // v1.2 requires turnId in the declared envelope. An incomplete
                // frame is rejected before dispatch; never revive a legacy
                // payload identity here.
                let turn_id = message.turn_id.clone();
                let _ = host.commands.send(HostCommand::StartTurn { prompt, turn_id });
                Some(ack)
            }
        }
        "cancel-turn" => { let _ = host.commands.send(HostCommand::Cancel); Some(ack) }
        "steer-turn" => { let _ = host.commands.send(HostCommand::Steer { prompt: message.string("prompt").unwrap_or("").to_string() }); Some(ack) }
        "follow-up-turn" => { let _ = host.commands.send(HostCommand::FollowUp { prompt: message.string("prompt").unwrap_or("").to_string() }); Some(ack) }
        "list-topics" => { let _ = host.commands.send(HostCommand::ListTopics { request_id, agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
        "read-topic" => { let _ = host.commands.send(HostCommand::ReadTopic { request_id, topic_id: message.string("topicId").unwrap_or("").to_string(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); Some(ack) }
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
