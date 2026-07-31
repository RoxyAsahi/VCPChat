//! Supervised VCP Agent daemon. It has no credentials and no network listener.

use anyhow::Result;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{Stdout, stdin, stdout};
use tokio::sync::mpsc;
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};
use vcp_agent_core::CoreRuntime;
use vcp_agent_host::{
    HostCommand, HostEvent, RunningHost, RuntimeOverrides, TuiSettingsUpdate, load_config, start,
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
    direct_main_v17().await
}

const MAX_RESIDENT_TOPIC_RUNTIMES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TopicRuntimeKey {
    agent_id: String,
    topic_id: String,
}

impl TopicRuntimeKey {
    fn new(agent_id: impl AsRef<str>, topic_id: impl AsRef<str>) -> Self {
        Self {
            agent_id: agent_id.as_ref().trim().to_ascii_lowercase(),
            topic_id: topic_id.as_ref().trim().to_string(),
        }
    }
}

struct ForwardedHostEvent {
    session_id: String,
    topic_id: String,
    event: HostEvent,
}

struct HostSlot {
    agent_id: String,
    session_id: String,
    topic_id: String,
    commands: mpsc::UnboundedSender<HostCommand>,
    task: Option<tokio::task::JoinHandle<()>>,
    forward_task: tokio::task::JoinHandle<()>,
    last_used_ms: u64,
}

impl HostSlot {
    fn from_host(
        host: RunningHost,
        agent_id: String,
        events: mpsc::Sender<ForwardedHostEvent>,
    ) -> Self {
        let RunningHost {
            commands,
            events: mut host_events,
            session_id,
            topic_id,
            task,
        } = host;
        let event_session_id = session_id.clone();
        let event_topic_id = topic_id.clone();
        let forward_task = tokio::spawn(async move {
            while let Some(event) = host_events.recv().await {
                if events
                    .send(ForwardedHostEvent {
                        session_id: event_session_id.clone(),
                        topic_id: event_topic_id.clone(),
                        event,
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            agent_id,
            session_id,
            topic_id,
            commands,
            task,
            forward_task,
            last_used_ms: now_millis(),
        }
    }

    fn matches(&self, message: &WireMessage) -> bool {
        message.session_id.as_deref() == Some(self.session_id.as_str())
            && message.string("topicId") == Some(self.topic_id.as_str())
    }

    async fn prepare_detach(&self) -> std::result::Result<(), String> {
        let (reply, response) = tokio::sync::oneshot::channel();
        self.commands
            .send(HostCommand::PrepareSwitch { reply })
            .map_err(|_| "runtime-unavailable".to_string())?;
        response
            .await
            .map_err(|_| "runtime-unavailable".to_string())?
    }

    async fn shutdown(mut self) {
        let _ = self.commands.send(HostCommand::Shutdown);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        self.forward_task.abort();
    }
}

async fn direct_main_v17() -> Result<()> {
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

    // The control Host is the daemon-level control plane and the sole owner
    // of VCPLog/VCPInfo. Every writable Topic Host is created independently
    // and deliberately disables its observer sockets.
    let base = overrides.clone();
    let control_config = load_config(control_overrides(&base))?;
    let (event_tx, mut event_rx) = mpsc::channel::<ForwardedHostEvent>(1024);
    let control_host = start(control_config)?;
    let control = HostSlot::from_host(control_host, "__control__".into(), event_tx.clone());
    let mut slots: HashMap<TopicRuntimeKey, HostSlot> = HashMap::new();
    let mut reader = FramedRead::new(stdin(), codec());
    let mut writer = FramedWrite::new(stdout(), codec());
    let mut ready = WireMessage::new("ready").put(
        "probe",
        serde_json::json!({
            "available": true, "runtime": "rust", "hosted": true,
            "details": "VCP Rust daemon multi-Topic supervisor"
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
            Some(forwarded) = event_rx.recv() => {
                if let Some(mut message) = host_event_message(forwarded.event) {
                    if message.kind == "event" {
                        event_sequence = event_sequence.saturating_add(1);
                        project_event_envelope(&mut message, &forwarded.session_id, &forwarded.topic_id, event_sequence);
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
                        for (_, slot) in slots.drain() { slot.shutdown().await; }
                        control.shutdown().await;
                        let ack = WireMessage::new("ack").with_request_id(message.request_id.expect("validated requestId")).put("ok", true);
                        write_direct_message(&mut writer, &ack).await?;
                        break;
                    }
                    let response = match message.kind.as_str() {
                        "ensure-topic-runtime" => ensure_topic_runtime(&base, &mut slots, &event_tx, message).await,
                        "detach-topic" => detach_topic_runtime(&mut slots, message).await,
                        "list-active-runtimes" => list_active_runtimes(&slots, message),
                        _ => dispatch_direct_v17(&control, &mut slots, message),
                    };
                    write_direct_message(&mut writer, &response).await?;
                }
                None => {
                    for (_, slot) in slots.drain() { slot.shutdown().await; }
                    control.shutdown().await;
                    break;
                }
            }
        }
    }
    Ok(())
}

fn runtime_overrides(base: &RuntimeOverrides, message: &WireMessage) -> RuntimeOverrides {
    let mut target = base.clone();
    target.control_only = false;
    target.resume = message.string("topicId").map(ToOwned::to_owned);
    target.agent = message.string("agentId").map(ToOwned::to_owned);
    if let Some(value) = message.string("model") {
        target.model = Some(value.to_string());
    }
    if let Some(value) = message.string("workspaceRoot") {
        target.workspace = Some(PathBuf::from(value));
    }
    target.always_approve = message.string("permissionMode") == Some("always-approve");
    target
}

async fn ensure_topic_runtime(
    base: &RuntimeOverrides,
    slots: &mut HashMap<TopicRuntimeKey, HostSlot>,
    events: &mpsc::Sender<ForwardedHostEvent>,
    message: WireMessage,
) -> WireMessage {
    let request_id = message.request_id.clone().unwrap_or_default();
    let target = runtime_overrides(base, &message);
    let mut config = match load_config(target) {
        Ok(config) => config,
        Err(error) => {
            return direct_error(
                request_id,
                if error.to_string().contains("workspace") {
                    "invalid-workspace"
                } else {
                    "invalid-topic"
                },
                error.to_string(),
            );
        }
    };
    let key = TopicRuntimeKey::new(&config.agent.id, &config.topic_id);
    if let Some(slot) = slots.get_mut(&key) {
        slot.last_used_ms = now_millis();
        return direct_ack(
            request_id,
            serde_json::json!({
                "sessionId": slot.session_id, "topicId": slot.topic_id, "agentId": slot.agent_id,
                "model": config.model, "workspaceRoot": config.workspace.display().to_string(), "resident": true,
            }),
        );
    }
    if slots.len() >= MAX_RESIDENT_TOPIC_RUNTIMES && !evict_idle_runtime(slots).await {
        return direct_error(
            request_id,
            "runtime-capacity",
            format!("all {MAX_RESIDENT_TOPIC_RUNTIMES} Topic runtimes are active"),
        );
    }
    let agent_id = config.agent.id.clone();
    let model = config.model.clone();
    let workspace = config.workspace.display().to_string();
    config.observe_toolbox = false;
    match start_without_index_rebuild(config) {
        Ok(host) => {
            let session_id = host.session_id.clone();
            let topic_id = host.topic_id.clone();
            slots.insert(
                key,
                HostSlot::from_host(host, agent_id.clone(), events.clone()),
            );
            direct_ack(
                request_id,
                serde_json::json!({
                    "sessionId": session_id, "topicId": topic_id, "agentId": agent_id,
                    "model": model, "workspaceRoot": workspace, "resident": true,
                }),
            )
        }
        Err(error) => direct_error(
            request_id,
            if error.to_string().contains("lease") {
                "topic-in-use"
            } else {
                "invalid-topic"
            },
            error.to_string(),
        ),
    }
}

async fn evict_idle_runtime(slots: &mut HashMap<TopicRuntimeKey, HostSlot>) -> bool {
    let mut keys: Vec<_> = slots.keys().cloned().collect();
    keys.sort_by_key(|key| {
        slots
            .get(key)
            .map(|slot| slot.last_used_ms)
            .unwrap_or(u64::MAX)
    });
    for key in keys {
        let idle = match slots.get(&key) {
            Some(slot) => slot.prepare_detach().await.is_ok(),
            None => false,
        };
        if idle && let Some(slot) = slots.remove(&key) {
            slot.shutdown().await;
            return true;
        }
    }
    false
}

async fn detach_topic_runtime(
    slots: &mut HashMap<TopicRuntimeKey, HostSlot>,
    message: WireMessage,
) -> WireMessage {
    let request_id = message.request_id.clone().unwrap_or_default();
    let Some(key) = find_runtime_key(slots, &message) else {
        return direct_error(
            request_id,
            "attachment-mismatch",
            "sessionId and topicId do not identify a live Topic runtime",
        );
    };
    if let Some(slot) = slots.get(&key)
        && let Err(reason) = slot.prepare_detach().await
    {
        return direct_error(
            request_id,
            &reason,
            "Topic has a running turn, approval, or queued interaction",
        );
    }
    if let Some(slot) = slots.remove(&key) {
        slot.shutdown().await;
    }
    direct_ack(request_id, serde_json::json!({"detached":true}))
}

fn list_active_runtimes(
    slots: &HashMap<TopicRuntimeKey, HostSlot>,
    message: WireMessage,
) -> WireMessage {
    let request_id = message.request_id.unwrap_or_default();
    let runtimes: Vec<_> = slots
        .values()
        .map(|slot| {
            serde_json::json!({
                "sessionId": slot.session_id, "topicId": slot.topic_id, "agentId": slot.agent_id,
                "lastUsedAtMs": slot.last_used_ms,
            })
        })
        .collect();
    direct_ack(
        request_id,
        serde_json::json!({"runtimes":runtimes, "capacity":MAX_RESIDENT_TOPIC_RUNTIMES}),
    )
}

fn find_runtime_key(
    slots: &HashMap<TopicRuntimeKey, HostSlot>,
    message: &WireMessage,
) -> Option<TopicRuntimeKey> {
    slots
        .iter()
        .find_map(|(key, slot)| slot.matches(message).then(|| key.clone()))
}

fn dispatch_direct_v17(
    control: &HostSlot,
    slots: &mut HashMap<TopicRuntimeKey, HostSlot>,
    message: WireMessage,
) -> WireMessage {
    let request_id = message.request_id.clone().unwrap_or_default();
    let ack = || {
        WireMessage::new("ack")
            .with_request_id(request_id.clone())
            .put("ok", true)
    };
    let control_command = |command| control.commands.send(command).is_ok();
    match message.kind.as_str() {
        "hello" => ack().put("result", serde_json::json!({"protocolVersion":PROTOCOL_VERSION, "protocolRevision":PROTOCOL_REVISION, "hosted":true})),
        "create-topic" => {
            let sent = control_command(HostCommand::CreateTopic { request_id: request_id.clone(), agent_id: message.string("agentId").unwrap_or_default().into(), title: message.string("title").map(ToOwned::to_owned), model: message.string("model").map(ToOwned::to_owned), workspace: message.string("workspaceRoot").map(PathBuf::from) });
            if sent { ack() } else { direct_error(request_id.clone(), "control-unavailable", "daemon control host stopped") }
        }
        "list-topics" => { control_command(HostCommand::ListTopics { request_id: request_id.clone(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); ack() }
        "read-topic" => { control_command(HostCommand::ReadTopic { request_id: request_id.clone(), topic_id: message.string("topicId").unwrap_or_default().into(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); ack() }
        "search-topics" => { control_command(HostCommand::SearchTopics { request_id: request_id.clone(), query: message.string("query").unwrap_or_default().into(), agent_id: message.string("agentId").map(ToOwned::to_owned), limit: message.value("limit").and_then(serde_json::Value::as_u64).unwrap_or(20) as usize }); ack() }
        "search-topic-messages" => { control_command(HostCommand::SearchTopicMessages { request_id: request_id.clone(), query: message.string("query").unwrap_or_default().into(), topic_id: message.string("topicId").unwrap_or_default().into(), agent_id: message.string("agentId").map(ToOwned::to_owned), limit: message.value("limit").and_then(serde_json::Value::as_u64).unwrap_or(50) as usize }); ack() }
        "get-index-status" => { control_command(HostCommand::GetIndexStatus { request_id: request_id.clone() }); ack() }
        "rebuild-topic-index" => { control_command(HostCommand::RebuildTopicIndex { request_id: request_id.clone() }); ack() }
        "takeover-topic" => { control_command(HostCommand::RequestTopicTakeover { request_id: request_id.clone(), topic_id: message.string("topicId").unwrap_or_default().into(), requester_id: request_id.clone(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); ack() }
        "rename-topic" => { control_command(HostCommand::RenameTopic { request_id: request_id.clone(), topic_id: message.string("topicId").unwrap_or_default().into(), title: message.string("title").unwrap_or_default().into(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); ack() }
        "delete-topic" => {
            if slots.values().any(|slot| slot.topic_id == message.string("topicId").unwrap_or_default()) { return direct_error(request_id, "topic-active", "detach the Topic runtime before deleting it"); }
            control_command(HostCommand::DeleteTopic { request_id: request_id.clone(), topic_id: message.string("topicId").unwrap_or_default().into(), agent_id: message.string("agentId").map(ToOwned::to_owned) }); ack()
        }
        "get-settings" => { control_command(HostCommand::GetSettings { request_id: request_id.clone() }); ack() }
        "update-settings" => match message.value("settings").cloned().and_then(|value| serde_json::from_value::<TuiSettingsUpdate>(value).ok()) { Some(update) => { control_command(HostCommand::UpdateSettings { request_id: request_id.clone(), update }); ack() }, None => direct_error(request_id.clone(), "invalid-settings", "invalid settings payload") },
        "toolbox-approval" => { control_command(HostCommand::ToolboxApproval { request_id: request_id.clone(), approval_request_id: message.string("approvalRequestId").unwrap_or_default().into(), approved: message.bool("approved").unwrap_or(false), reason: message.string("reason").map(ToOwned::to_owned) }); ack() }
        "set-workbench-presence" => {
            let mounted = message.bool("mounted").unwrap_or(false);
            control_command(HostCommand::WorkbenchPresence { request_id: request_id.clone(), mounted });
            if !mounted { for slot in slots.values() { let _ = slot.commands.send(HostCommand::WorkbenchPresence { request_id: format!("{request_id}:{}", slot.topic_id), mounted }); } }
            ack()
        }
        "import-attachment" | "start-turn" | "cancel-turn" | "steer-turn" | "follow-up-turn" | "compact" | "approval" | "list-interaction-queue" | "replace-interaction-queue" | "clear-interaction-queue" => {
            let Some(key) = find_runtime_key(slots, &message) else { return direct_error(request_id, "attachment-mismatch", "sessionId and topicId do not identify a live Topic runtime"); };
            let slot = slots.get_mut(&key).expect("key from slots");
            slot.last_used_ms = now_millis();
            let sent = match message.kind.as_str() {
                "import-attachment" => slot.commands.send(HostCommand::ImportAttachment { request_id: request_id.clone(), path: PathBuf::from(message.string("path").unwrap_or_default()) }),
                "start-turn" => slot.commands.send(HostCommand::StartTurn { prompt: message.string("prompt").unwrap_or_default().trim().into(), attachments: message.value("attachments").and_then(serde_json::Value::as_array).cloned().unwrap_or_default(), turn_id: message.turn_id.clone() }),
                "cancel-turn" => slot.commands.send(HostCommand::Cancel),
                "steer-turn" => slot.commands.send(HostCommand::Steer { prompt: message.string("prompt").unwrap_or_default().into() }),
                "follow-up-turn" => slot.commands.send(HostCommand::FollowUp { prompt: message.string("prompt").unwrap_or_default().into() }),
                "compact" => slot.commands.send(HostCommand::Compact),
                "approval" => slot.commands.send(HostCommand::Approval { approval_id: message.string("approvalId").unwrap_or_default().into(), allowed: message.bool("allowed").unwrap_or(false), binding: Some((message.session_id.clone().unwrap_or_default(), message.turn_id.clone().unwrap_or_default(), message.tool_call_id.clone().unwrap_or_default(), message.string("argumentsHash").unwrap_or_default().into())) }),
                "list-interaction-queue" => slot.commands.send(HostCommand::ListInteractionQueue { request_id: request_id.clone() }),
                "replace-interaction-queue" => slot.commands.send(HostCommand::ReplaceInteractionQueue { request_id: request_id.clone(), interactions: message.value("interactions").and_then(serde_json::Value::as_array).cloned().unwrap_or_default() }),
                "clear-interaction-queue" => slot.commands.send(HostCommand::ClearInteractionQueue { request_id: request_id.clone() }),
                _ => unreachable!(),
            };
            if sent.is_ok() { ack() } else { direct_error(request_id.clone(), "runtime-unavailable", "Topic runtime stopped") }
        }
        _ => direct_error(request_id, "unsupported-command", format!("unsupported direct daemon command: {}", message.kind)),
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
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

async fn write_direct_message(
    writer: &mut FramedWrite<Stdout, LengthDelimitedCodec>,
    message: &WireMessage,
) -> Result<()> {
    validate_direct_daemon_message(message)?;
    write_message(writer, message).await?;
    Ok(())
}

// The v1.6 dispatcher is deliberately compiled out while its source remains
// available for one release-cycle forensic comparison. It cannot be reached
// by v1.7 builds or clients; `validate_direct_command` rejects its commands.
#[cfg(any())]
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
        "create-topic" => {
            let agent_id = message.string("agentId").unwrap_or("").to_string();
            let title = message.string("title").map(ToOwned::to_owned);
            let model = message.string("model").map(ToOwned::to_owned);
            let workspace = message.string("workspaceRoot").map(PathBuf::from);
            let _ = host.commands.send(HostCommand::CreateTopic {
                request_id,
                agent_id,
                title,
                model,
                workspace,
            });
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
