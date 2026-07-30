//! VCP Agent loop with a single serial actor per session.
//!
//! The core deliberately owns no API keys and performs no ToolBox HTTP calls.
//! It requests models and tools from a host, which keeps VCPChat/Electron
//! credential ownership and the existing ApprovalBroker intact.

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio::sync::mpsc;
use vcp_agent_protocol::WireMessage;
use vcp_agent_vcp::{
    VCP_INVOKE_NAME, external_loop_system_prompt, parse_vcp_invoke, vcp_invoke_schema,
};
use vcp_grok_compaction::{
    CompactionFileRef, CompactionItem, CompactionRole, select_turns_to_compact,
};
use vcp_grok_interjection::{InterjectionBuffer, PendingInterjection, format_interjection};
use vcp_grok_token_estimation::{estimate_tokens, exceeds_threshold_with_headroom};

const SESSION_QUEUE_CAPACITY: usize = 128;
const MAX_TRANSCRIPT_MESSAGES: usize = 160;
const MAX_SNAPSHOT_TEXT_BYTES: usize = 8 * 1024;
const MAX_MARKER_DETAIL_BYTES: usize = 16 * 1024;
const MAX_TOOL_AUDIT_ITEMS: usize = 32;
const MAX_TOOL_AUDIT_VALUE_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy)]
enum AssistantMarkerKind {
    RawToolRequest,
    DynamicFold,
    VcpInfo,
}

impl AssistantMarkerKind {
    const fn start(self) -> &'static str {
        match self {
            Self::RawToolRequest => "<<<[TOOL_REQUEST]>>>",
            Self::DynamicFold => "<<<[VCP_DYNAMIC_FOLD]>>>",
            Self::VcpInfo => "<<<[VCPINFO]>>>",
        }
    }

    const fn end(self) -> &'static str {
        match self {
            Self::RawToolRequest => "<<<[END_TOOL_REQUEST]>>>",
            Self::DynamicFold => "<<<[END_VCP_DYNAMIC_FOLD]>>>",
            Self::VcpInfo => "<<<[END_VCPINFO]>>>",
        }
    }

    const fn event_kind(self) -> &'static str {
        match self {
            Self::RawToolRequest => "raw-tool-request",
            Self::DynamicFold => "dynamic-fold",
            Self::VcpInfo => "vcpinfo",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::RawToolRequest => "raw TOOL_REQUEST",
            Self::DynamicFold => "VCP dynamic context",
            Self::VcpInfo => "VCP notification",
        }
    }
}

#[derive(Debug)]
enum AssistantMarkerOutput {
    Text(String),
    Observation {
        kind: AssistantMarkerKind,
        summary: String,
        detail: String,
    },
    Warning(String),
}

/// A streaming, fail-closed marker filter.  ToolBox marker examples may be
/// present in a provider's expanded prompt, but a model printing one is never
/// an execution request.  The filter works before an assistant delta reaches
/// a UI or the Core transcript, including when a marker boundary is split
/// across SSE chunks.
#[derive(Debug, Default)]
struct AssistantMarkerFilter {
    pending: String,
}

impl AssistantMarkerFilter {
    fn push(&mut self, text: &str) -> Vec<AssistantMarkerOutput> {
        self.pending.push_str(text);
        self.drain(false)
    }

    fn finish(&mut self) -> Vec<AssistantMarkerOutput> {
        self.drain(true)
    }

    fn drain(&mut self, final_chunk: bool) -> Vec<AssistantMarkerOutput> {
        let mut output = Vec::new();
        loop {
            let next = [
                AssistantMarkerKind::RawToolRequest,
                AssistantMarkerKind::DynamicFold,
                AssistantMarkerKind::VcpInfo,
            ]
            .into_iter()
            .filter_map(|kind| {
                self.pending
                    .find(kind.start())
                    .map(|position| (position, kind))
            })
            .min_by_key(|(position, _)| *position);
            let Some((position, kind)) = next else {
                if final_chunk {
                    if !self.pending.is_empty() {
                        output.push(AssistantMarkerOutput::Text(std::mem::take(
                            &mut self.pending,
                        )));
                    }
                } else {
                    let retained = marker_prefix_suffix_len(&self.pending);
                    let safe_len = self.pending.len().saturating_sub(retained);
                    if safe_len > 0 {
                        output.push(AssistantMarkerOutput::Text(
                            self.pending[..safe_len].to_string(),
                        ));
                        self.pending.drain(..safe_len);
                    }
                }
                break;
            };
            if position > 0 {
                output.push(AssistantMarkerOutput::Text(
                    self.pending[..position].to_string(),
                ));
                self.pending.drain(..position);
                continue;
            }
            let content_start = kind.start().len();
            if let Some(relative_end) = self.pending[content_start..].find(kind.end()) {
                let content_end = content_start + relative_end;
                let detail = truncate_marker_text(&self.pending[content_start..content_end]);
                self.pending.drain(..content_end + kind.end().len());
                match kind {
                    AssistantMarkerKind::RawToolRequest => {
                        output.push(AssistantMarkerOutput::Warning(
                            "[VCP protocol warning: raw TOOL_REQUEST removed and not executed]"
                                .to_string(),
                        ))
                    }
                    _ => output.push(AssistantMarkerOutput::Observation {
                        kind,
                        summary: marker_summary(&detail),
                        detail,
                    }),
                }
                continue;
            }
            if final_chunk {
                self.pending.clear();
                output.push(AssistantMarkerOutput::Warning(format!(
                    "[VCP protocol warning: incomplete {} removed and not executed]",
                    kind.label()
                )));
            }
            break;
        }
        output
    }
}

fn marker_prefix_suffix_len(value: &str) -> usize {
    [
        AssistantMarkerKind::RawToolRequest,
        AssistantMarkerKind::DynamicFold,
        AssistantMarkerKind::VcpInfo,
    ]
    .into_iter()
    .map(AssistantMarkerKind::start)
    .filter_map(|marker| {
        (1..marker.len())
            .rev()
            .find(|length| value.ends_with(&marker[..*length]))
    })
    .max()
    .unwrap_or(0)
}

fn truncate_marker_text(value: &str) -> String {
    if value.len() <= MAX_MARKER_DETAIL_BYTES {
        return value.to_string();
    }
    let mut end = MAX_MARKER_DETAIL_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

fn marker_summary(value: &str) -> String {
    let summary = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut end = summary.len().min(240);
    while !summary.is_char_boundary(end) {
        end -= 1;
    }
    if end == summary.len() {
        summary
    } else {
        format!("{}…", &summary[..end])
    }
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("message {0} requires sessionId")]
    MissingSessionId(&'static str),
    #[error("unknown session: {0}")]
    UnknownSession(String),
    #[error("start-turn requires turnId and non-empty prompt")]
    InvalidTurn,
    #[error("invalid interaction queue: {0}")]
    InvalidInteractionQueue(String),
    #[error("unsupported daemon command: {0}")]
    UnsupportedCommand(String),
}

#[derive(Clone)]
struct SessionHandle {
    tx: mpsc::Sender<SessionCommand>,
}

/// Routes daemon wire messages to per-session actors. The caller forwards
/// `outbound` messages to the supervising Host in arrival order.
pub struct CoreRuntime {
    sessions: HashMap<String, SessionHandle>,
    outbound: mpsc::Sender<WireMessage>,
}

impl CoreRuntime {
    pub fn new(outbound: mpsc::Sender<WireMessage>) -> Self {
        Self {
            sessions: HashMap::new(),
            outbound,
        }
    }

    pub async fn handle(&mut self, message: WireMessage) -> Result<(), CoreError> {
        match message.kind.as_str() {
            "create-session" | "start-session" => self.create_session(message).await,
            "close-session" => self.close_session(message).await,
            "start-turn" => {
                self.send_to_session(message, |message| SessionCommand::StartTurn {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    turn_id: message.turn_id.clone().unwrap_or_default(),
                    prompt: message.string("prompt").unwrap_or_default().to_string(),
                    attachments: attachment_descriptors(message.value("attachments")),
                    compaction: CompactionRequest::from_wire(message.value("compaction")),
                })
                .await
            }
            "steer-turn" => {
                self.send_to_session(message, |message| SessionCommand::Interaction {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    kind: InteractionKind::Steer,
                    interaction_id: message
                        .string("interactionId")
                        .unwrap_or_default()
                        .to_string(),
                    prompt: message.string("prompt").unwrap_or_default().to_string(),
                })
                .await
            }
            "follow-up-turn" => {
                self.send_to_session(message, |message| SessionCommand::Interaction {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    kind: InteractionKind::FollowUp,
                    interaction_id: message
                        .string("interactionId")
                        .unwrap_or_default()
                        .to_string(),
                    prompt: message.string("prompt").unwrap_or_default().to_string(),
                })
                .await
            }
            "clear-interaction-queue" => {
                self.send_to_session(message, |message| SessionCommand::ClearInteractions {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    kind: message.string("kind").map(ToOwned::to_owned),
                })
                .await
            }
            "replace-interaction-queue" => self.replace_interactions(message).await,
            "cancel-turn" => {
                self.send_to_session(message, |message| SessionCommand::Cancel {
                    request_id: message.request_id.clone().unwrap_or_default(),
                })
                .await
            }
            "model-delta" => {
                self.send_to_session(message, |message| SessionCommand::ModelDelta {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    delta: message.value("delta").cloned().unwrap_or(Value::Null),
                })
                .await
            }
            "model-done" => {
                self.send_to_session(message, |message| SessionCommand::ModelDone {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    usage: message.value("usage").cloned(),
                    finish_reason: message.string("finishReason").map(ToOwned::to_owned),
                })
                .await
            }
            "model-error" => {
                self.send_to_session(message, |message| SessionCommand::ModelError {
                    request_id: message.request_id.clone().unwrap_or_default(),
                    error: message
                        .string("error")
                        .unwrap_or("model request failed")
                        .to_string(),
                    cancelled: message.bool("cancelled").unwrap_or(false),
                })
                .await
            }
            "tool-result" => {
                self.send_to_session(message, |message| SessionCommand::ToolResult {
                    tool_call_id: message.tool_call_id.clone().unwrap_or_default(),
                    ok: message.bool("ok").unwrap_or(false),
                    output: message.value("output").cloned(),
                    error: message.string("error").map(ToOwned::to_owned),
                    audit: message.value("audit").cloned(),
                })
                .await
            }
            _ => Err(CoreError::UnsupportedCommand(message.kind)),
        }
    }

    async fn create_session(&mut self, message: WireMessage) -> Result<(), CoreError> {
        let session_id = message
            .session_id
            .clone()
            .ok_or(CoreError::MissingSessionId("create-session"))?;
        let options = message
            .value("options")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let (tx, rx) = mpsc::channel(SESSION_QUEUE_CAPACITY);
        let actor = SessionActor::new(session_id.clone(), options, rx, self.outbound.clone());
        tokio::spawn(actor.run());
        self.sessions
            .insert(session_id.clone(), SessionHandle { tx });
        self.ack(message.request_id, true, json!({ "sessionId": session_id }))
            .await;
        Ok(())
    }

    async fn close_session(&mut self, message: WireMessage) -> Result<(), CoreError> {
        let session_id = message
            .session_id
            .clone()
            .ok_or(CoreError::MissingSessionId("close-session"))?;
        if let Some(handle) = self.sessions.remove(&session_id) {
            let _ = handle.tx.send(SessionCommand::Close).await;
        }
        self.ack(message.request_id, true, json!({ "sessionId": session_id }))
            .await;
        Ok(())
    }

    async fn send_to_session<F>(&self, message: WireMessage, map: F) -> Result<(), CoreError>
    where
        F: FnOnce(WireMessage) -> SessionCommand,
    {
        let session_id = message
            .session_id
            .clone()
            .ok_or(CoreError::MissingSessionId("session command"))?;
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(CoreError::UnknownSession(session_id))?;
        let _ = handle.tx.send(map(message)).await;
        Ok(())
    }

    async fn replace_interactions(&self, message: WireMessage) -> Result<(), CoreError> {
        let session_id = message
            .session_id
            .clone()
            .ok_or(CoreError::MissingSessionId("replace-interaction-queue"))?;
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(CoreError::UnknownSession(session_id))?;
        let values = message
            .value("interactions")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CoreError::InvalidInteractionQueue("interactions must be an array".to_string())
            })?;
        let mut interactions = Vec::with_capacity(values.len());
        for value in values {
            let id = value
                .get("interactionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let prompt = value
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let kind = match value.get("kind").and_then(Value::as_str) {
                Some("steer") => InteractionKind::Steer,
                Some("follow-up") => InteractionKind::FollowUp,
                _ => {
                    return Err(CoreError::InvalidInteractionQueue(
                        "kind must be steer or follow-up".to_string(),
                    ));
                }
            };
            if id.is_empty() || prompt.is_empty() {
                return Err(CoreError::InvalidInteractionQueue(
                    "interactionId and prompt are required".to_string(),
                ));
            }
            interactions.push(Interaction {
                id: id.to_string(),
                kind,
                prompt: prompt.to_string(),
            });
        }
        let _ = handle
            .tx
            .send(SessionCommand::ReplaceInteractions {
                request_id: message.request_id.unwrap_or_default(),
                interactions,
            })
            .await;
        Ok(())
    }

    async fn ack(&self, request_id: Option<String>, ok: bool, result: Value) {
        let mut message = WireMessage::new("ack").put("ok", ok).put("result", result);
        message.request_id = request_id;
        let _ = self.outbound.send(message).await;
    }
}

#[derive(Debug)]
enum SessionCommand {
    StartTurn {
        request_id: String,
        turn_id: String,
        prompt: String,
        attachments: Vec<Value>,
        compaction: CompactionRequest,
    },
    Interaction {
        request_id: String,
        kind: InteractionKind,
        interaction_id: String,
        prompt: String,
    },
    ClearInteractions {
        request_id: String,
        kind: Option<String>,
    },
    ReplaceInteractions {
        request_id: String,
        interactions: Vec<Interaction>,
    },
    Cancel {
        request_id: String,
    },
    ModelDelta {
        request_id: String,
        delta: Value,
    },
    ModelDone {
        request_id: String,
        usage: Option<Value>,
        finish_reason: Option<String>,
    },
    ModelError {
        request_id: String,
        error: String,
        cancelled: bool,
    },
    ToolResult {
        tool_call_id: String,
        ok: bool,
        output: Option<Value>,
        error: Option<String>,
        audit: Option<Value>,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InteractionKind {
    Steer,
    FollowUp,
}

impl InteractionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow-up",
        }
    }
}

#[derive(Debug, Clone)]
struct Interaction {
    id: String,
    kind: InteractionKind,
    prompt: String,
}

#[derive(Debug, Clone)]
struct NativeToolCall {
    index: u64,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolPhase {
    Preflight,
    Execute,
}

#[derive(Debug, Clone)]
struct PendingTool {
    call: NativeToolCall,
    arguments: Value,
    phase: ToolPhase,
}

#[derive(Debug, Default)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    reasoning: u64,
    total_tokens: u64,
    requests: u64,
    provider_requests: u64,
    estimated_requests: u64,
}

impl UsageTotals {
    fn add(&mut self, usage: Option<&Value>, estimated_input: u64, estimated_output: u64) -> Value {
        self.requests = self.requests.saturating_add(1);
        let usage = usage.filter(|value| !value.is_null());
        let number = |keys: &[&str]| -> u64 {
            keys.iter()
                .find_map(|key| {
                    usage
                        .and_then(|value| value.get(*key))
                        .and_then(Value::as_u64)
                })
                .unwrap_or(0)
        };
        let provider_input = number(&["input", "input_tokens", "prompt_tokens"]);
        let provider_output = number(&["output", "output_tokens", "completion_tokens"]);
        let provider_total = number(&["totalTokens", "total_tokens"]);
        let has_provider_usage = provider_input > 0 || provider_output > 0 || provider_total > 0;
        let (input, output, source) = if has_provider_usage {
            self.provider_requests = self.provider_requests.saturating_add(1);
            (provider_input, provider_output, "provider")
        } else {
            self.estimated_requests = self.estimated_requests.saturating_add(1);
            (estimated_input, estimated_output, "estimated")
        };
        self.input = self.input.saturating_add(input);
        self.output = self.output.saturating_add(output);
        self.cache_read = self
            .cache_read
            .saturating_add(number(&["cacheRead", "cache_read"]));
        self.cache_write = self
            .cache_write
            .saturating_add(number(&["cacheWrite", "cache_write"]));
        self.reasoning = self.reasoning.saturating_add(number(&["reasoning"]));
        let total = provider_total.max(input.saturating_add(output));
        self.total_tokens = self.total_tokens.saturating_add(total);
        json!({
            "input": input,
            "output": output,
            "totalTokens": total,
            "source": source,
            "estimated": source == "estimated"
        })
    }

    fn as_value(&self) -> Value {
        let source = match (self.provider_requests > 0, self.estimated_requests > 0) {
            (true, true) => "mixed",
            (true, false) => "provider",
            _ => "estimated",
        };
        json!({
            "input": self.input, "output": self.output,
            "cacheRead": self.cache_read, "cacheWrite": self.cache_write,
            "reasoning": self.reasoning, "totalTokens": self.total_tokens,
            "requests": self.requests,
            "source": source,
            "estimated": self.estimated_requests > 0,
            "providerRequests": self.provider_requests,
            "estimatedRequests": self.estimated_requests,
        })
    }
}

#[derive(Debug, Clone, Default)]
struct CompactionRequest {
    force: bool,
    only: bool,
    context_window: u32,
    max_output: u32,
}

impl CompactionRequest {
    fn from_wire(value: Option<&Value>) -> Self {
        let value = value.unwrap_or(&Value::Null);
        Self {
            force: value.get("force").and_then(Value::as_bool).unwrap_or(false),
            only: value.get("only").and_then(Value::as_bool).unwrap_or(false),
            context_window: value
                .get("contextWindow")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0),
            max_output: value
                .get("maxOutput")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .unwrap_or(0),
        }
    }
}

#[derive(Debug)]
struct PendingCompaction {
    pending_user_message: Option<Value>,
    tail: Vec<Value>,
    before_tokens: u32,
    hard_limit: u32,
    only: bool,
}

#[derive(Debug)]
enum ModelPurpose {
    Agent,
    Compaction(PendingCompaction),
}

#[derive(Debug)]
struct ActiveTurn {
    request_id: String,
    turn_id: String,
    model_request_id: String,
    model_round: u32,
    assistant_id: String,
    assistant_text: String,
    marker_filter: AssistantMarkerFilter,
    reasoning_started: bool,
    tool_calls: BTreeMap<u64, NativeToolCall>,
    tool_queue: VecDeque<NativeToolCall>,
    pending_tool: Option<PendingTool>,
    purpose: ModelPurpose,
    estimated_input_tokens: u64,
}

struct SessionActor {
    session_id: String,
    model: String,
    max_output: u64,
    // `required` is accepted for controlled integration tests. It applies to
    // the first provider round of a Turn only, so the post-tool synthesis
    // round remains free to answer normally instead of entering a tool loop.
    first_round_tool_choice: String,
    system_prompt: Option<String>,
    transcript: Vec<Value>,
    active: Option<ActiveTurn>,
    // Steering is inserted at the next safe model boundary; follow-ups run
    // only after the Agent would otherwise stop.
    steering: InterjectionBuffer<String>,
    follow_ups: VecDeque<Interaction>,
    usage: UsageTotals,
    rx: mpsc::Receiver<SessionCommand>,
    outbound: mpsc::Sender<WireMessage>,
}

impl SessionActor {
    fn new(
        session_id: String,
        options: Value,
        rx: mpsc::Receiver<SessionCommand>,
        outbound: mpsc::Sender<WireMessage>,
    ) -> Self {
        let model = options
            .pointer("/vcp/model")
            .and_then(Value::as_str)
            .unwrap_or("vcp-default")
            .to_string();
        let max_output = options
            .pointer("/vcp/maxOutput")
            .and_then(Value::as_u64)
            // An unspecified shared Agent limit must preserve ToolBox's
            // default instead of sending an invalid `max_tokens: 0`.
            .filter(|value| *value > 0)
            .unwrap_or(0);
        let first_round_tool_choice =
            match options.pointer("/vcp/toolChoice").and_then(Value::as_str) {
                Some("required") => "required".to_string(),
                _ => "auto".to_string(),
            };
        let system_prompt = options
            .get("systemPrompt")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        // Existing VCPAgent snapshots are Pi-shaped.  Convert them at the
        // daemon boundary so the Rust loop remains OpenAI-shaped internally,
        // and so switching Pi -> Rust never makes an existing checkpoint
        // unusable.  Raw OpenAI messages are accepted as a convenience for
        // host tests and future native Rust callers.
        let transcript = normalize_initial_messages(options.get("initialMessages"));
        Self {
            session_id,
            model,
            max_output,
            first_round_tool_choice,
            system_prompt,
            transcript,
            active: None,
            steering: InterjectionBuffer::new(),
            follow_ups: VecDeque::new(),
            usage: UsageTotals::default(),
            rx,
            outbound,
        }
    }

    async fn run(mut self) {
        while let Some(command) = self.rx.recv().await {
            let close = matches!(command, SessionCommand::Close);
            self.handle(command).await;
            if close {
                break;
            }
        }
    }

    async fn handle(&mut self, command: SessionCommand) {
        match command {
            SessionCommand::StartTurn {
                request_id,
                turn_id,
                prompt,
                attachments,
                compaction,
            } => {
                self.start_turn(request_id, turn_id, prompt, attachments, compaction)
                    .await
            }
            SessionCommand::Interaction {
                request_id,
                kind,
                interaction_id,
                prompt,
            } => {
                self.queue_interaction(request_id, kind, interaction_id, prompt)
                    .await
            }
            SessionCommand::ClearInteractions { request_id, kind } => {
                self.clear_interactions(request_id, kind).await
            }
            SessionCommand::ReplaceInteractions {
                request_id,
                interactions,
            } => self.replace_interactions(request_id, interactions).await,
            SessionCommand::Cancel { request_id } => self.cancel(request_id).await,
            SessionCommand::ModelDelta { request_id, delta } => {
                self.model_delta(&request_id, delta).await
            }
            SessionCommand::ModelDone {
                request_id,
                usage,
                finish_reason,
            } => self.model_done(&request_id, usage, finish_reason).await,
            SessionCommand::ModelError {
                request_id,
                error,
                cancelled,
            } => self.model_error(&request_id, error, cancelled).await,
            SessionCommand::ToolResult {
                tool_call_id,
                ok,
                output,
                error,
                audit,
            } => {
                self.tool_result(&tool_call_id, ok, output, error, audit)
                    .await
            }
            SessionCommand::Close => self.cancel(String::new()).await,
        }
    }

    async fn start_turn(
        &mut self,
        request_id: String,
        turn_id: String,
        prompt: String,
        attachments: Vec<Value>,
        compaction: CompactionRequest,
    ) {
        if (prompt.trim().is_empty() && attachments.is_empty() && !compaction.only)
            || turn_id.is_empty()
            || self.active.is_some()
        {
            self.ack(
                request_id,
                false,
                json!({ "error": "session already has an active turn or prompt is empty" }),
            )
            .await;
            return;
        }
        self.active = Some(ActiveTurn {
            request_id,
            turn_id: turn_id.clone(),
            model_request_id: String::new(),
            model_round: 0,
            assistant_id: format!("msg_{turn_id}_1"),
            assistant_text: String::new(),
            marker_filter: AssistantMarkerFilter::default(),
            reasoning_started: false,
            tool_calls: BTreeMap::new(),
            tool_queue: VecDeque::new(),
            pending_tool: None,
            purpose: ModelPurpose::Agent,
            estimated_input_tokens: 0,
        });
        let pending_user_message = (!compaction.only).then(|| {
            identified_message(
                user_message(&prompt, &attachments),
                format!("msg_{turn_id}_user"),
                &turn_id,
            )
        });
        match self.prepare_compaction(&compaction, pending_user_message.as_ref()) {
            Ok(Some(pending)) => {
                let before_tokens = pending.before_tokens;
                let tail_tokens = estimate_messages_tokens(&pending.tail);
                if let Some(active) = self.active.as_mut() {
                    active.purpose = ModelPurpose::Compaction(pending);
                }
                self.emit_for_turn(
                    Some(&turn_id),
                    "context.compaction.started",
                    json!({ "beforeTokens": before_tokens, "tailTokens": tail_tokens }),
                )
                .await;
                self.request_compaction_model().await;
                return;
            }
            Ok(None) if compaction.only => {
                let active = self.active.take().expect("active compaction turn");
                self.complete_with_snapshot(active).await;
                return;
            }
            Ok(None) => {}
            Err(error) => {
                let active = self.active.take().expect("active compaction turn");
                self.ack(active.request_id, false, json!({ "error": error }))
                    .await;
                return;
            }
        }
        if let Some(message) = pending_user_message {
            self.transcript.push(message);
        }
        self.request_model().await;
    }

    async fn queue_interaction(
        &mut self,
        request_id: String,
        kind: InteractionKind,
        interaction_id: String,
        prompt: String,
    ) {
        if self.active.is_none() || interaction_id.is_empty() || prompt.trim().is_empty() {
            self.ack(
                request_id,
                false,
                json!({ "error": "turn is no longer active" }),
            )
            .await;
            return;
        }
        self.push_interaction(Interaction {
            id: interaction_id,
            kind,
            prompt,
        });
        self.ack(request_id, true, json!({ "ok": true })).await;
    }

    async fn clear_interactions(&mut self, request_id: String, kind: Option<String>) {
        match kind.as_deref() {
            Some("steer") => self.steering.clear(),
            Some("follow-up") => self.follow_ups.clear(),
            Some(_) => {}
            None => self.clear_all_interactions(),
        }
        self.ack(request_id, true, json!({ "ok": true })).await;
    }

    async fn replace_interactions(&mut self, request_id: String, interactions: Vec<Interaction>) {
        if self.active.is_none() {
            self.ack(
                request_id,
                false,
                json!({ "error": "turn is no longer active" }),
            )
            .await;
            return;
        }
        self.clear_all_interactions();
        for interaction in interactions {
            self.push_interaction(interaction);
        }
        self.ack(
            request_id,
            true,
            json!({ "ok": true, "count": self.interaction_count() }),
        )
        .await;
    }

    fn push_interaction(&mut self, interaction: Interaction) {
        if interaction.kind == InteractionKind::Steer {
            self.steering.push(PendingInterjection {
                text: interaction.prompt,
                attachments: vec![interaction.id],
            });
        } else {
            self.follow_ups.push_back(interaction);
        }
    }

    fn interaction_count(&self) -> usize {
        self.steering.len() + self.follow_ups.len()
    }

    fn clear_all_interactions(&mut self) {
        self.steering.clear();
        self.follow_ups.clear();
    }

    /// A steering item is deliberately formatted as an interjection before it
    /// reaches the model. It cannot be confused with a completed user turn,
    /// and large CJK prompts inherit the controlled Grok truncation boundary.
    fn take_steering(&self) -> Option<Interaction> {
        let pending = self.steering.pop_front()?;
        let id = pending.attachments.into_iter().next()?;
        Some(Interaction {
            id,
            kind: InteractionKind::Steer,
            prompt: format_interjection(pending.text),
        })
    }

    async fn cancel(&mut self, request_id: String) {
        if let Some(mut active) = self.active.take() {
            if !active.model_request_id.is_empty() {
                self.outbound(
                    WireMessage::new("model-abort")
                        .with_request_id(active.model_request_id.clone()),
                )
                .await;
            }
            self.clear_all_interactions();
            for output in active.marker_filter.finish() {
                match output {
                    AssistantMarkerOutput::Text(text) | AssistantMarkerOutput::Warning(text) => {
                        active.assistant_text.push_str(&text);
                    }
                    AssistantMarkerOutput::Observation { kind, summary, .. } => {
                        active
                            .assistant_text
                            .push_str(&format!("[{}: {summary}]", kind.label()));
                    }
                }
            }
            let interrupted_text = if active.assistant_text.trim().is_empty() {
                "[任务已中断，恢复后不会自动重放。]".to_string()
            } else {
                format!(
                    "{}\n\n[任务已中断，恢复后不会自动重放。]",
                    active.assistant_text.trim_end()
                )
            };
            self.transcript.push(identified_message(
                json!({ "role": "assistant", "content": interrupted_text }),
                active.assistant_id.clone(),
                &active.turn_id,
            ));
            self.emit_for_turn(
                Some(&active.turn_id),
                "turn.cancelled",
                json!({ "interrupted": true, "replay": false }),
            )
            .await;
            if !active.request_id.is_empty() {
                let snapshot = to_pi_snapshot(&safe_snapshot_tail(&self.transcript));
                self.ack(
                    active.request_id,
                    false,
                    json!({
                        "cancelled": true,
                        "interrupted": true,
                        "snapshot": { "version": 1, "messages": snapshot },
                        "usage": self.usage.as_value()
                    }),
                )
                .await;
            }
        }
        if !request_id.is_empty() {
            self.ack(request_id, true, json!({ "cancelled": true }))
                .await;
        }
    }

    async fn model_delta(&mut self, request_id: &str, delta: Value) {
        let mut emissions = Vec::new();
        {
            let Some(active) = self.active.as_mut() else {
                return;
            };
            if active.model_request_id != request_id {
                return;
            }
            if matches!(active.purpose, ModelPurpose::Compaction(_)) {
                if let Some(text) = delta.get("content").and_then(Value::as_str) {
                    active.assistant_text.push_str(text);
                }
                return;
            }
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                for output in active.marker_filter.push(text) {
                    match output {
                        AssistantMarkerOutput::Text(text)
                        | AssistantMarkerOutput::Warning(text)
                            if !text.is_empty() =>
                        {
                            if active.assistant_text.is_empty() {
                                emissions.push((
                                    "assistant.started",
                                    json!({ "messageId": active.assistant_id }),
                                ));
                            }
                            active.assistant_text.push_str(&text);
                            emissions.push((
                                "assistant.delta",
                                json!({ "messageId": active.assistant_id, "text": text }),
                            ));
                        }
                        AssistantMarkerOutput::Observation {
                            kind,
                            summary,
                            detail,
                        } => emissions.push((
                            "marker.observed",
                            json!({
                                "messageId": active.assistant_id,
                                "kind": kind.event_kind(),
                                "summary": summary,
                                "detail": detail,
                            }),
                        )),
                        AssistantMarkerOutput::Text(_) | AssistantMarkerOutput::Warning(_) => {}
                    }
                }
            }
            let reasoning = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str);
            if let Some(text) = reasoning {
                if !active.reasoning_started {
                    active.reasoning_started = true;
                    emissions.push((
                        "reasoning.started",
                        json!({ "messageId": active.assistant_id }),
                    ));
                }
                emissions.push((
                    "reasoning.delta",
                    json!({ "messageId": active.assistant_id, "text": text }),
                ));
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let entry = active
                        .tool_calls
                        .entry(index)
                        .or_insert_with(|| NativeToolCall {
                            index,
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry.id = id.to_string();
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        entry.name.push_str(name);
                    }
                    if let Some(arguments) =
                        call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        entry.arguments.push_str(arguments);
                    }
                }
            }
        }
        for (event, payload) in emissions {
            self.emit(event, payload).await;
        }
    }

    async fn model_done(
        &mut self,
        request_id: &str,
        usage: Option<Value>,
        _finish_reason: Option<String>,
    ) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        if active.model_request_id != request_id {
            return;
        }
        let estimated_input = active.estimated_input_tokens;
        let estimated_output = estimate_vcp_text_tokens(&active.assistant_text).max(1);
        let round_usage = self
            .usage
            .add(usage.as_ref(), estimated_input, estimated_output);
        if matches!(active.purpose, ModelPurpose::Compaction(_)) {
            self.finish_compaction_round(Some(round_usage)).await;
            return;
        }
        self.finish_model_round(Some(round_usage)).await;
    }

    async fn model_error(&mut self, request_id: &str, error: String, cancelled: bool) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        if active.model_request_id != request_id {
            return;
        }
        let mut active = self.active.take().expect("active checked");
        if let ModelPurpose::Compaction(pending) =
            std::mem::replace(&mut active.purpose, ModelPurpose::Agent)
        {
            // A summary is an optimisation until the pending turn would exceed
            // the provider-safe hard limit. Preserve the original transcript
            // on a transient summary failure; never commit a partial summary.
            if !pending.only
                && (pending.hard_limit == 0 || pending.before_tokens < pending.hard_limit)
            {
                self.emit_for_turn(
                    Some(&active.turn_id),
                    "context.compaction.failed",
                    json!({ "error": error }),
                )
                .await;
                if let Some(message) = pending.pending_user_message {
                    self.transcript.push(message);
                }
                self.active = Some(active);
                self.request_model().await;
                return;
            }
        }
        self.clear_all_interactions();
        self.ack(
            active.request_id,
            false,
            json!({ "error": error, "cancelled": cancelled }),
        )
        .await;
    }

    async fn finish_model_round(&mut self, usage: Option<Value>) {
        let mut active = self.active.take().expect("active model round");
        if active.reasoning_started {
            // `active` has been removed from the actor while this terminal
            // round is assembled. Do not use `emit()` here: it derives the
            // Turn from `self.active` and would produce a reasoning.completed
            // event without turnId, which the direct daemon correctly rejects.
            self.emit_for_turn(
                Some(&active.turn_id),
                "reasoning.completed",
                json!({ "messageId": active.assistant_id }),
            )
            .await;
        }
        // A marker opener can end exactly on the provider's final chunk.  Do
        // not leave that text in a renderer or transcript merely because no
        // later SSE delta arrived to complete the streaming filter.
        for output in active.marker_filter.finish() {
            match output {
                AssistantMarkerOutput::Text(text) | AssistantMarkerOutput::Warning(text)
                    if !text.is_empty() =>
                {
                    if active.assistant_text.is_empty() {
                        self.emit_for_turn(
                            Some(&active.turn_id),
                            "assistant.started",
                            json!({ "messageId": active.assistant_id }),
                        )
                        .await;
                    }
                    active.assistant_text.push_str(&text);
                    self.emit_for_turn(
                        Some(&active.turn_id),
                        "assistant.delta",
                        json!({ "messageId": active.assistant_id, "text": text }),
                    )
                    .await;
                }
                AssistantMarkerOutput::Observation {
                    kind,
                    summary,
                    detail,
                } => {
                    self.emit_for_turn(
                        Some(&active.turn_id),
                        "marker.observed",
                        json!({
                            "messageId": active.assistant_id,
                            "kind": kind.event_kind(),
                            "summary": summary,
                            "detail": detail,
                        }),
                    )
                    .await;
                }
                AssistantMarkerOutput::Text(_) | AssistantMarkerOutput::Warning(_) => {}
            }
        }
        let calls: Vec<NativeToolCall> = active.tool_calls.values().cloned().collect();
        let mut assistant = identified_message(
            json!({ "role": "assistant", "content": active.assistant_text }),
            active.assistant_id.clone(),
            &active.turn_id,
        );
        if !calls.is_empty() {
            let tool_calls: Vec<Value> = calls.iter().map(|call| json!({
                "id": if call.id.is_empty() { format!("tool_{}_{}", active.turn_id, call.index) } else { call.id.clone() },
                "type": "function",
                "function": { "name": call.name, "arguments": call.arguments }
            })).collect();
            assistant["tool_calls"] = Value::Array(tool_calls);
        }
        self.transcript.push(assistant);
        // Every provider round consumes context, including a round that ends
        // in native tool calls rather than visible text.  Pi emits a message
        // completion for that round and the shared TUI aggregates its usage;
        // omitting it here made Rust sessions under-report token counts after
        // any `vcp_invoke` call.
        self.emit_for_turn(
            Some(&active.turn_id),
            "assistant.completed",
            json!({ "messageId": active.assistant_id, "usage": usage }),
        )
        .await;
        if calls.is_empty() {
            self.continue_or_complete(active).await;
            return;
        }
        active.tool_queue = calls.into();
        active.assistant_text.clear();
        active.reasoning_started = false;
        active.tool_calls.clear();
        active.purpose = ModelPurpose::Agent;
        self.active = Some(active);
        self.request_next_tool().await;
    }

    async fn request_next_tool(&mut self) {
        loop {
            let next_call = self
                .active
                .as_mut()
                .and_then(|active| active.tool_queue.pop_front());
            let Some(mut call) = next_call else {
                self.consume_steering_or_request_model().await;
                return;
            };
            let turn_id = self
                .active
                .as_ref()
                .map(|active| active.turn_id.clone())
                .unwrap_or_default();
            if call.id.is_empty() {
                call.id = format!("tool_{turn_id}_{}", call.index);
            }
            if call.name != VCP_INVOKE_NAME {
                self.transcript.push(json!({ "role": "tool", "tool_call_id": call.id, "content": "Only vcp_invoke is available." }));
                continue;
            }
            let arguments = serde_json::from_str::<Value>(&call.arguments).unwrap_or(Value::Null);
            if let Err(error) = parse_vcp_invoke(&arguments) {
                self.transcript.push(json!({ "role": "tool", "tool_call_id": call.id, "content": format!("vcp_invoke rejected: {error}") }));
                continue;
            }
            if let Some(active) = self.active.as_mut() {
                active.pending_tool = Some(PendingTool {
                    call: call.clone(),
                    arguments: arguments.clone(),
                    phase: ToolPhase::Preflight,
                });
            }
            let request = self.tool_request(
                &turn_id,
                &call.id,
                ToolPhase::Preflight,
                &call.name,
                arguments,
            );
            self.outbound(request).await;
            return;
        }
    }

    async fn tool_result(
        &mut self,
        tool_call_id: &str,
        ok: bool,
        output: Option<Value>,
        error: Option<String>,
        audit: Option<Value>,
    ) {
        let execute = {
            let Some(active) = self.active.as_mut() else {
                return;
            };
            let Some(pending) = active.pending_tool.clone() else {
                return;
            };
            if pending.call.id != tool_call_id {
                return;
            }
            if pending.phase == ToolPhase::Preflight && ok {
                active.pending_tool = Some(PendingTool {
                    phase: ToolPhase::Execute,
                    ..pending.clone()
                });
                Some((
                    active.turn_id.clone(),
                    pending.call.name.clone(),
                    pending.arguments,
                ))
            } else {
                active.pending_tool = None;
                None
            }
        };
        if let Some((turn_id, tool_name, arguments)) = execute {
            let request = self.tool_request(
                &turn_id,
                tool_call_id,
                ToolPhase::Execute,
                &tool_name,
                arguments,
            );
            self.outbound(request).await;
            return;
        }
        let content = if ok {
            let raw = match output.unwrap_or(Value::Null) {
                Value::String(text) => text,
                other => other.to_string(),
            };
            truncate_to_bytes(&raw, 64 * 1024)
        } else {
            error.unwrap_or_else(|| "VCPToolBox tool call failed".to_string())
        };
        self.transcript.push(json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "content": content,
            "vcp_audit": audit,
        }));
        self.request_next_tool().await;
    }

    /// Pi treats steering as an inner-loop queue: after a tool batch is
    /// complete, it gets the next safe model boundary before another model
    /// round begins. Follow-ups intentionally do not use this path; they are
    /// consumed only when the Agent would otherwise finish.
    async fn consume_steering_or_request_model(&mut self) {
        let Some(next) = self.take_steering() else {
            self.request_model().await;
            return;
        };
        let turn_id = self
            .active
            .as_ref()
            .map(|active| active.turn_id.clone())
            .unwrap_or_default();
        self.transcript.push(identified_message(
            json!({ "role": "user", "content": next.prompt }),
            format!("msg_{}_interaction_{}", turn_id, next.id),
            &turn_id,
        ));
        self.emit(
            "interaction.consumed",
            json!({ "interactionId": next.id, "kind": next.kind.as_str() }),
        )
        .await;
        self.request_model().await;
    }

    async fn request_model(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        active.model_round += 1;
        active.model_request_id = format!(
            "model_{}_{}_{}",
            self.session_id, active.turn_id, active.model_round
        );
        active.assistant_id = format!("msg_{}_{}", active.turn_id, active.model_round);
        active.assistant_text.clear();
        active.reasoning_started = false;
        active.tool_calls.clear();
        active.purpose = ModelPurpose::Agent;
        let mut messages = Vec::with_capacity(self.transcript.len() + 1);
        messages.push(json!({ "role": "system", "content": external_loop_system_prompt(self.system_prompt.as_deref()) }));
        messages.extend(self.transcript.iter().map(provider_message));
        // Production sessions use `auto`. An explicitly supplied `required`
        // value is intentionally limited to the first model round, allowing
        // deterministic live integration fixtures while preserving the
        // normal tool-result → final-answer loop.
        let tool_choice = if active.model_round == 1 {
            self.first_round_tool_choice.as_str()
        } else {
            "auto"
        };
        let mut body = json!({
            "requestId": active.model_request_id,
            "model": self.model,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": messages,
            "tools": [vcp_invoke_schema()],
            "tool_choice": tool_choice,
        });
        // Match VCPChat normal chat: ToolBox exposes an OpenAI-compatible
        // gateway and uses this completion ceiling for streamed output.
        if self.max_output > 0 {
            body["max_tokens"] = json!(self.max_output);
        }
        active.estimated_input_tokens = estimate_messages_tokens(&messages) as u64;
        let mut message = WireMessage::new("model-request")
            .with_request_id(active.model_request_id.clone())
            .put("body", body);
        message.session_id = Some(self.session_id.clone());
        message.turn_id = Some(active.turn_id.clone());
        self.outbound(message).await;
    }

    fn prepare_compaction(
        &self,
        request: &CompactionRequest,
        pending_user_message: Option<&Value>,
    ) -> Result<Option<PendingCompaction>, String> {
        if !request.force && (request.context_window == 0 || request.max_output == 0) {
            return Ok(None);
        }
        let mut candidate = self.transcript.clone();
        if let Some(message) = pending_user_message {
            candidate.push(message.clone());
        }
        let before_tokens = estimate_messages_tokens(&candidate);
        let hard_limit = if request.context_window > 0 {
            request.context_window.saturating_sub(
                request
                    .max_output
                    .saturating_add(1024_u32.max(request.context_window.div_ceil(10))),
            )
        } else {
            0
        };
        let exceeded = hard_limit > 0 && before_tokens >= hard_limit;
        if !request.force
            && !exceeds_threshold_with_headroom(
                before_tokens as u64,
                request.context_window as u64,
                80,
                0,
            )
            && !exceeded
        {
            return Ok(None);
        }
        let items: Vec<TranscriptItem> = self
            .transcript
            .iter()
            .cloned()
            .map(TranscriptItem)
            .collect();
        let counts: Vec<u32> = self
            .transcript
            .iter()
            .map(estimate_message_tokens)
            .collect();
        let tail_budget = 256_u32.max(
            (if hard_limit > 0 {
                hard_limit
            } else {
                before_tokens.max(2048)
            }) * 3
                / 10,
        );
        let Some(plan) = select_turns_to_compact(&counts, &items, tail_budget, 1) else {
            return if request.only || exceeded || request.force {
                Err("insufficient history to compact safely".to_string())
            } else {
                Ok(None)
            };
        };
        if plan.split_idx == 0 || plan.split_idx >= self.transcript.len() {
            return Err("no compactable transcript".to_string());
        }
        if format_compaction_source(&self.transcript[..plan.split_idx])
            .trim()
            .is_empty()
        {
            return Err("no compactable transcript".to_string());
        }
        Ok(Some(PendingCompaction {
            pending_user_message: pending_user_message.cloned(),
            tail: self.transcript[plan.split_idx..].to_vec(),
            before_tokens,
            hard_limit,
            only: request.only,
        }))
    }

    async fn request_compaction_model(&mut self) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        let ModelPurpose::Compaction(pending) = &active.purpose else {
            return;
        };
        let prefix_len = self.transcript.len().saturating_sub(pending.tail.len());
        let source = format_compaction_source(&self.transcript[..prefix_len]);
        active.model_round += 1;
        active.model_request_id = format!(
            "model_{}_{}_{}_compact",
            self.session_id, active.turn_id, active.model_round
        );
        active.assistant_text.clear();
        let body = json!({
            "requestId": active.model_request_id,
            "model": self.model,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": "Summarize completed VCP Agent history for future continuation. Preserve Goal, Constraints, Verified progress, VCP decisions, ToolBox artifacts, Risks, and Next safe action. Never invent results. Never include reasoning traces, credentials, attachments, or raw large tool output. Use concise Markdown sections." },
                { "role": "user", "content": source }
            ]
        });
        active.estimated_input_tokens = body["messages"]
            .as_array()
            .map(|messages| estimate_messages_tokens(messages) as u64)
            .unwrap_or_default();
        let mut message = WireMessage::new("model-request")
            .with_request_id(active.model_request_id.clone())
            .put("body", body);
        message.session_id = Some(self.session_id.clone());
        message.turn_id = Some(active.turn_id.clone());
        self.outbound(message).await;
    }

    async fn finish_compaction_round(&mut self, usage: Option<Value>) {
        let mut active = self.active.take().expect("active compaction round");
        let ModelPurpose::Compaction(pending) =
            std::mem::replace(&mut active.purpose, ModelPurpose::Agent)
        else {
            self.active = Some(active);
            return;
        };
        let summary = truncate_text(&active.assistant_text).trim().to_string();
        if summary.len() < 24 {
            self.fail_compaction_or_resume(
                active,
                pending,
                "summary was empty or degenerate".to_string(),
            )
            .await;
            return;
        }
        let checkpoint = identified_message(
            json!({ "role": "user", "content": format!("[VCP CHECKPOINT — completed history]\n{summary}") }),
            format!("msg_{}_compaction", active.turn_id),
            &active.turn_id,
        );
        let mut next = vec![checkpoint];
        // Keep `pending` intact until the candidate has passed its reduction
        // checks: on failure the ordinary-turn fallback must resume with the
        // original transcript, not a partially moved tail.
        next.extend(pending.tail.iter().cloned());
        let mut candidate = next.clone();
        if let Some(message) = pending.pending_user_message.as_ref() {
            candidate.push(message.clone());
        }
        let after_tokens = estimate_messages_tokens(&candidate);
        if after_tokens >= pending.before_tokens
            || (pending.hard_limit > 0 && after_tokens > pending.hard_limit)
        {
            self.fail_compaction_or_resume(
                active,
                pending,
                "summary did not reduce context safely".to_string(),
            )
            .await;
            return;
        }
        self.transcript = next;
        self.emit_for_turn(Some(&active.turn_id), "context.compaction.completed", json!({
            "beforeTokens": pending.before_tokens, "afterTokens": after_tokens,
            "summaryTokens": estimate_messages_tokens(&[json!({ "role": "user", "content": summary })]), "usage": usage
        })).await;
        if pending.only {
            self.complete_with_snapshot(active).await;
            return;
        }
        if let Some(message) = pending.pending_user_message {
            self.transcript.push(message);
        }
        self.active = Some(active);
        self.request_model().await;
    }

    /// A compaction summary is an optimisation for an ordinary turn.  Until
    /// the transcript has crossed the provider-safe hard limit, failure to
    /// obtain a useful summary must not throw away the user's pending prompt
    /// or commit a partial checkpoint.  A manual compact-only request and a
    /// hard-limit turn fail closed instead: proceeding would either lie about
    /// compaction success or risk another context-overflow request.
    async fn fail_compaction_or_resume(
        &mut self,
        active: ActiveTurn,
        pending: PendingCompaction,
        error: String,
    ) {
        if !pending.only && (pending.hard_limit == 0 || pending.before_tokens < pending.hard_limit)
        {
            self.emit_for_turn(
                Some(&active.turn_id),
                "context.compaction.failed",
                json!({ "error": error }),
            )
            .await;
            if let Some(message) = pending.pending_user_message {
                self.transcript.push(message);
            }
            self.active = Some(active);
            self.request_model().await;
            return;
        }
        self.ack(active.request_id, false, json!({ "error": error }))
            .await;
    }

    async fn continue_or_complete(&mut self, active: ActiveTurn) {
        // Steering has the same priority as Pi's inner-loop queue. A
        // follow-up is only eligible after the agent has no more work.
        if let Some(next) = self.take_steering().or_else(|| self.follow_ups.pop_front()) {
            self.transcript.push(identified_message(
                json!({ "role": "user", "content": next.prompt }),
                format!("msg_{}_interaction_{}", active.turn_id, next.id),
                &active.turn_id,
            ));
            self.emit_for_turn(
                Some(&active.turn_id),
                "interaction.consumed",
                json!({ "interactionId": next.id, "kind": next.kind.as_str() }),
            )
            .await;
            self.active = Some(active);
            self.request_model().await;
            return;
        }
        // AgentRuntimeManager and TopicStore deliberately keep the existing
        // Pi-shaped checkpoint contract.  The Rust actor uses OpenAI-shaped
        // messages internally, but must never publish that private shape to
        // the persistent host boundary or a later Pi/Rust resume would lose
        // every message during TopicStore sanitisation.
        self.complete_with_snapshot(active).await;
    }

    async fn complete_with_snapshot(&mut self, active: ActiveTurn) {
        let snapshot = to_pi_snapshot(&safe_snapshot_tail(&self.transcript));
        let usage = self.usage.as_value();
        // `assistant.completed` closes one provider round; it does not mean
        // the Agent turn is idle when another native tool round may follow.
        // Once continuation is exhausted, publish the distinct turn terminal
        // event before ACKing the durable snapshot. Hosts use this event to
        // unlock a fresh composer submission instead of treating it as a
        // follow-up to a completed task.
        self.emit_for_turn(
            Some(&active.turn_id),
            "turn.completed",
            json!({ "usage": usage.clone() }),
        )
        .await;
        self.ack(
            active.request_id,
            true,
            json!({
                "ok": true,
                "snapshot": { "version": 1, "messages": snapshot },
                "usage": usage
            }),
        )
        .await;
    }

    fn tool_request(
        &self,
        turn_id: &str,
        tool_call_id: &str,
        phase: ToolPhase,
        tool_name: &str,
        arguments: Value,
    ) -> WireMessage {
        let mut message = WireMessage::new("tool-request")
            .put(
                "phase",
                match phase {
                    ToolPhase::Preflight => "preflight",
                    ToolPhase::Execute => "execute",
                },
            )
            .put("toolName", tool_name)
            .put("arguments", arguments);
        message.session_id = Some(self.session_id.clone());
        message.turn_id = Some(turn_id.to_string());
        message.tool_call_id = Some(tool_call_id.to_string());
        message
    }

    async fn emit(&self, event_type: &str, payload: Value) {
        let turn_id = self.active.as_ref().map(|active| active.turn_id.as_str());
        self.emit_for_turn(turn_id, event_type, payload).await;
    }

    async fn emit_for_turn(&self, turn_id: Option<&str>, event_type: &str, payload: Value) {
        let mut event = Map::new();
        event.insert("type".to_string(), Value::String(event_type.to_string()));
        if let Some(turn_id) = turn_id {
            event.insert("turnId".to_string(), Value::String(turn_id.to_string()));
        }
        let mut body = payload;
        if let Value::Object(ref mut map) = body {
            if let Some(message_id) = map.remove("messageId") {
                event.insert("messageId".to_string(), message_id);
            }
            event.insert("payload".to_string(), Value::Object(map.clone()));
        } else {
            event.insert("payload".to_string(), body);
        }
        let mut message = WireMessage::new("event").put("event", Value::Object(event));
        message.session_id = Some(self.session_id.clone());
        message.turn_id = turn_id.map(ToOwned::to_owned);
        self.outbound(message).await;
    }

    async fn ack(&self, request_id: String, ok: bool, result: Value) {
        let message = WireMessage::new("ack")
            .with_request_id(request_id)
            .put("ok", ok)
            .put("result", result);
        self.outbound(message).await;
    }

    async fn outbound(&self, message: WireMessage) {
        let _ = self.outbound.send(message).await;
    }
}

/// Normalise snapshot data produced by the existing Pi runtime into the
/// OpenAI-compatible transcript held by this actor.  The conversion is
/// deliberately lossy for thinking and raw media bytes. Durable attachment
/// descriptors survive, while Base64 and hidden reasoning never enter the
/// checkpoint.
fn normalize_initial_messages(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(normalize_initial_message)
        .collect()
}

fn normalize_initial_message(message: &Value) -> Option<Value> {
    let role = message.get("role")?.as_str()?;
    match role {
        "user" => {
            let content = snapshot_text(message.get("content"));
            let attachments = snapshot_attachments(message.get("content"));
            (!content.is_empty() || !attachments.is_empty())
                .then(|| copy_message_identity(message, user_message(&content, &attachments)))
        }
        "assistant" => {
            let content = snapshot_text(message.get("content"));
            let pi_tool_calls: Vec<Value> = message.get("content").and_then(Value::as_array).into_iter().flatten()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
                .filter_map(|part| {
                    let id = part.get("id").and_then(Value::as_str)?.trim();
                    let name = part.get("name").and_then(Value::as_str)?.trim();
                    if id.is_empty() || name.is_empty() { return None; }
                    let arguments = part.get("arguments").filter(|value| value.is_object()).cloned().unwrap_or_else(|| json!({}));
                    Some(json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments.to_string() } }))
                }).collect();
            let tool_calls = if pi_tool_calls.is_empty() {
                message.get("tool_calls").and_then(Value::as_array).into_iter().flatten().filter_map(|call| {
                    let id = call.get("id").and_then(Value::as_str)?.trim();
                    let name = call.pointer("/function/name").and_then(Value::as_str)?.trim();
                    let arguments = call.pointer("/function/arguments").and_then(Value::as_str)?;
                    if id.is_empty() || name.is_empty() || serde_json::from_str::<Value>(arguments).ok().filter(Value::is_object).is_none() { return None; }
                    Some(json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } }))
                }).collect()
            } else {
                pi_tool_calls
            };
            if content.is_empty() && tool_calls.is_empty() {
                return None;
            }
            let mut output = json!({ "role": "assistant", "content": if content.is_empty() { Value::Null } else { Value::String(content) } });
            if !tool_calls.is_empty() {
                output["tool_calls"] = Value::Array(tool_calls);
            }
            Some(copy_message_identity(message, output))
        }
        "toolResult" => {
            let tool_call_id = message.get("toolCallId").and_then(Value::as_str)?.trim();
            if tool_call_id.is_empty() {
                return None;
            }
            let text = snapshot_text(message.get("content"));
            let content = if message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                format!("[error] {text}")
            } else {
                text
            };
            let mut output =
                json!({ "role": "tool", "tool_call_id": tool_call_id, "content": content });
            if let Some(audit) = snapshot_tool_audit(message.get("vcpAudit")) {
                output["vcp_audit"] = audit;
            }
            Some(output)
        }
        // A snapshot written by an early Rust build or a future native host.
        "tool" => {
            let tool_call_id = message
                .get("tool_call_id")
                .or_else(|| message.get("toolCallId"))
                .and_then(Value::as_str)?
                .trim();
            if tool_call_id.is_empty() {
                return None;
            }
            let mut output = json!({ "role": "tool", "tool_call_id": tool_call_id, "content": truncate_text(&snapshot_text(message.get("content"))) });
            if let Some(audit) =
                snapshot_tool_audit(message.get("vcp_audit").or_else(|| message.get("vcpAudit")))
            {
                output["vcp_audit"] = audit;
            }
            Some(output)
        }
        _ => None,
    }
}

fn snapshot_text(content: Option<&Value>) -> String {
    truncate_text(&content_text(content))
}

/// ToolBox artifacts are useful to a restored UI, but they are never model
/// context. Keep only a small, structural audit projection in a checkpoint:
/// no paths, data URIs or arbitrarily deep/large values may survive.
fn snapshot_tool_audit(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let mut output = Map::new();
    if let Some(name) = object.get("toolName").and_then(Value::as_str) {
        let name = name.trim();
        if !name.is_empty() && name.len() <= 256 {
            output.insert("toolName".into(), Value::String(name.to_string()));
        }
    }
    for key in ["resources", "warnings"] {
        let values = object
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_TOOL_AUDIT_ITEMS)
            .map(|item| snapshot_audit_value(item, 0))
            .collect::<Vec<_>>();
        if !values.is_empty() {
            output.insert(key.into(), Value::Array(values));
        }
    }
    if let Some(task) = object.get("task").filter(|task| !task.is_null()) {
        output.insert("task".into(), snapshot_audit_value(task, 0));
    }
    (!output.is_empty()).then_some(Value::Object(output))
}

fn snapshot_audit_value(value: &Value, depth: usize) -> Value {
    if depth >= 4 {
        return Value::String("[nested ToolBox metadata omitted]".to_string());
    }
    match value {
        Value::String(text) if text.trim_start().starts_with("data:") => {
            Value::String("[data URI omitted]".to_string())
        }
        Value::String(text) => Value::String(truncate_to_bytes(text, MAX_TOOL_AUDIT_VALUE_BYTES)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(MAX_TOOL_AUDIT_ITEMS)
                .map(|item| snapshot_audit_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut output = Map::new();
            for (key, item) in values.iter().take(MAX_TOOL_AUDIT_ITEMS) {
                let normalized = key.to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "path" | "localpath" | "internalpath" | "base64" | "bytes" | "buffer"
                ) || (normalized == "url"
                    && item
                        .as_str()
                        .is_some_and(|url| url.trim_start().starts_with("file:")))
                {
                    continue;
                }
                output.insert(key.clone(), snapshot_audit_value(item, depth + 1));
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

const MAX_ATTACHMENTS_PER_TURN: usize = 8;

fn attachment_descriptors(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(sanitize_attachment_descriptor)
        .take(MAX_ATTACHMENTS_PER_TURN)
        .collect()
}

fn snapshot_attachments(content: Option<&Value>) -> Vec<Value> {
    content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| {
            matches!(
                part.get("type").and_then(Value::as_str),
                Some("attachment" | "attachment_ref")
            )
        })
        .filter_map(|part| part.get("attachment"))
        .filter_map(sanitize_attachment_descriptor)
        .take(MAX_ATTACHMENTS_PER_TURN)
        .collect()
}

fn sanitize_attachment_descriptor(value: &Value) -> Option<Value> {
    let id = value.get("id")?.as_str()?.trim();
    let display_name = value.get("displayName")?.as_str()?.trim();
    let mime_type = value.get("mimeType")?.as_str()?.trim();
    let byte_len = value.get("byteLen")?.as_u64()?;
    let sha256 = value.get("sha256")?.as_str()?.trim();
    let asset_file = value.get("assetFile")?.as_str()?.trim();
    // v1.4 image descriptors predate `kind`; retain them as images. Audio and
    // video are descriptor-only VCPToolBox media assets, never provider-
    // specific content parts and never raw data URLs in a Topic snapshot.
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("image");
    if id.is_empty()
        || id.len() > 96
        || display_name.is_empty()
        || display_name.len() > 512
        || byte_len == 0
        || sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || asset_file.contains(['/', '\\'])
    {
        return None;
    }
    let mut descriptor = serde_json::Map::new();
    descriptor.insert("id".into(), Value::String(id.to_string()));
    descriptor.insert(
        "displayName".into(),
        Value::String(display_name.to_string()),
    );
    descriptor.insert("kind".into(), Value::String(kind.to_string()));
    descriptor.insert("mimeType".into(), Value::String(mime_type.to_string()));
    descriptor.insert("byteLen".into(), Value::from(byte_len));
    descriptor.insert("sha256".into(), Value::String(sha256.to_string()));
    descriptor.insert("assetFile".into(), Value::String(asset_file.to_string()));
    match kind {
        "image"
            if matches!(
                mime_type,
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            ) && byte_len <= 1_500_000 =>
        {
            let width = value.get("width")?.as_u64()?;
            let height = value.get("height")?.as_u64()?;
            if width == 0 || height == 0 {
                return None;
            }
            descriptor.insert("width".into(), Value::from(width));
            descriptor.insert("height".into(), Value::from(height));
        }
        "audio"
            if matches!(
                mime_type,
                "audio/wav"
                    | "audio/mpeg"
                    | "audio/mp3"
                    | "audio/aiff"
                    | "audio/aac"
                    | "audio/ogg"
                    | "audio/flac"
            ) && byte_len <= 25_000_000
                && value.get("width").is_none()
                && value.get("height").is_none() => {}
        "video"
            if matches!(
                mime_type,
                "video/mp4" | "video/webm" | "video/quicktime" | "video/x-msvideo"
            ) && byte_len <= 50_000_000
                && value.get("width").is_none()
                && value.get("height").is_none() => {}
        _ => return None,
    }
    Some(Value::Object(descriptor))
}

fn user_message(prompt: &str, attachments: &[Value]) -> Value {
    if attachments.is_empty() {
        return json!({ "role": "user", "content": prompt });
    }
    let mut content = Vec::with_capacity(attachments.len() + 1);
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": prompt }));
    }
    content.extend(
        attachments
            .iter()
            .map(|attachment| json!({ "type": "attachment_ref", "attachment": attachment })),
    );
    json!({ "role": "user", "content": content })
}

fn identified_message(mut message: Value, message_id: String, turn_id: &str) -> Value {
    if let Value::Object(map) = &mut message {
        map.insert("messageId".into(), Value::String(message_id));
        map.insert("turnId".into(), Value::String(turn_id.to_string()));
        map.insert("timestamp".into(), Value::from(now_millis()));
    }
    message
}

fn copy_message_identity(source: &Value, mut target: Value) -> Value {
    let Value::Object(target_map) = &mut target else {
        return target;
    };
    for key in ["messageId", "id", "turnId", "timestamp", "createdAt"] {
        if let Some(value) = source.get(key) {
            target_map.insert(key.to_string(), value.clone());
        }
    }
    target
}

fn provider_message(message: &Value) -> Value {
    let mut output = message.clone();
    if let Value::Object(map) = &mut output {
        for key in ["messageId", "id", "turnId", "timestamp", "createdAt"] {
            map.remove(key);
        }
    }
    output
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn message_text(message: &Value) -> String {
    content_text(message.get("content"))
}

fn truncate_text(text: &str) -> String {
    if text.len() <= MAX_SNAPSHOT_TEXT_BYTES {
        return text.to_string();
    }
    let mut cut = MAX_SNAPSHOT_TEXT_BYTES;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…[truncated]", &text[..cut])
}

/// Local estimate used for context thresholds and as an explicitly-labelled
/// fallback because VCPToolBox currently does not return reliable usage.
fn estimate_message_tokens(message: &Value) -> u32 {
    let mut text = String::new();
    text.push_str(message.get("role").and_then(Value::as_str).unwrap_or(""));
    text.push('\n');
    text.push_str(&message_text(message));
    if let Some(calls) = message.get("tool_calls") {
        text.push_str(&calls.to_string());
    }
    if let Some(call_id) = message.get("tool_call_id").and_then(Value::as_str) {
        text.push_str(call_id);
    }
    let attachment_tokens = u32::try_from(snapshot_attachments(message.get("content")).len())
        .unwrap_or(u32::MAX)
        .saturating_mul(1_024);
    u32::try_from(estimate_vcp_text_tokens(&text).max(1))
        .unwrap_or(u32::MAX)
        .saturating_add(4)
        .saturating_add(attachment_tokens)
}

/// VCP prompts are frequently Chinese-heavy. Grok's bytes/4 primitive remains
/// the single base estimate; this adapter adds conservative multilingual
/// headroom so compaction never fires later than the previous VCP policy.
fn estimate_vcp_text_tokens(text: &str) -> u64 {
    let multilingual_headroom = text
        .chars()
        .filter(|character| !character.is_ascii())
        .count() as u64
        / 2;
    estimate_tokens(text).saturating_add(multilingual_headroom)
}

fn estimate_messages_tokens(messages: &[Value]) -> u32 {
    messages
        .iter()
        .map(estimate_message_tokens)
        .fold(0_u32, u32::saturating_add)
}

/// Summaries see completed, bounded evidence rather than a raw replay of
/// massive tool payloads. This keeps the VCP checkpoint useful while obeying
/// the no-reasoning/no-large-tool-result persistence rule.
fn format_compaction_source(messages: &[Value]) -> String {
    const MAX_SOURCE_BYTES: usize = 120 * 1024;
    const MAX_TOOL_BYTES: usize = 1024;
    let mut output = String::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let raw = message_text(message);
        let content = if role == "tool" {
            truncate_to_bytes(&raw, MAX_TOOL_BYTES)
        } else {
            truncate_to_bytes(&raw, 6 * 1024)
        };
        if content.is_empty() && message.get("tool_calls").is_none() {
            continue;
        }
        let line = if let Some(calls) = message.get("tool_calls") {
            format!(
                "[{role}]\n{content}\n[tool calls] {}",
                truncate_to_bytes(&calls.to_string(), 4 * 1024)
            )
        } else {
            format!("[{role}]\n{content}")
        };
        if output.len().saturating_add(line.len()).saturating_add(2) > MAX_SOURCE_BYTES {
            break;
        }
        if !output.is_empty() {
            output.push_str("\n\n");
        }
        output.push_str(&line);
    }
    output
}

fn truncate_to_bytes(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…[truncated]", &text[..cut])
}

#[derive(Clone)]
struct TranscriptItem(Value);

impl CompactionItem for TranscriptItem {
    fn role(&self) -> CompactionRole {
        match self.0.get("role").and_then(Value::as_str) {
            Some("assistant") => CompactionRole::Assistant,
            Some("tool") => CompactionRole::Tool,
            Some("system") => CompactionRole::System,
            _ => CompactionRole::User,
        }
    }

    fn text(&self) -> Option<String> {
        self.0
            .get("content")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    }
    fn has_tool_requests(&self) -> bool {
        self.0
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty())
    }
    fn is_compaction_summary(&self) -> bool {
        false
    }
    fn attachment_refs(&self) -> Vec<CompactionFileRef> {
        Vec::new()
    }
}

/// Keep at most the snapshot message budget, snapping a split forward when it
/// would leave a ToolBox result without its `vcp_invoke` call.  The imported
/// Grok selector is intentionally used here rather than a local, subtly
/// different pairing implementation.
fn safe_snapshot_tail(messages: &[Value]) -> Vec<Value> {
    if messages.len() <= MAX_TRANSCRIPT_MESSAGES {
        return messages.to_vec();
    }
    let items: Vec<TranscriptItem> = messages.iter().cloned().map(TranscriptItem).collect();
    let counts = vec![1_u32; items.len()];
    let target = u32::try_from(MAX_TRANSCRIPT_MESSAGES).unwrap_or(u32::MAX);
    let start = select_turns_to_compact(&counts, &items, target, 1)
        .map(|plan| plan.split_idx)
        // A pathological all-tool tail has no safe suffix.  Returning an
        // empty tail is safer than an API-invalid orphan result.
        .unwrap_or(messages.len());
    messages[start..].to_vec()
}

/// Convert the internal OpenAI-compatible transcript into the bounded,
/// model-usable bounded snapshot shape shared by TopicStore and VCPChat.
/// Thinking, audit metadata and raw attachment bytes are omitted; only durable
/// attachment descriptors survive. These checkpoints are continuation state,
/// not a JSONL event log.
fn to_pi_snapshot(messages: &[Value]) -> Vec<Value> {
    messages.iter().filter_map(|message| {
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                let text = message_text(message);
                let attachments = snapshot_attachments(message.get("content"));
                if text.is_empty() && attachments.is_empty() {
                    return None;
                }
                let mut content = Vec::with_capacity(attachments.len() + 1);
                if !text.is_empty() {
                    content.push(json!({ "type": "text", "text": truncate_text(&text) }));
                }
                content.extend(attachments.into_iter().map(|attachment| {
                    json!({ "type": "attachment", "attachment": attachment })
                }));
                Some(copy_message_identity(
                    message,
                    json!({ "role": "user", "content": content }),
                ))
            }
            Some("assistant") => {
                let mut content = Vec::new();
                let text = truncate_text(message.get("content").and_then(Value::as_str).unwrap_or(""));
                if !text.is_empty() { content.push(json!({ "type": "text", "text": text })); }
                for call in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                    let id = call.get("id").and_then(Value::as_str).unwrap_or("").trim();
                    let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or("").trim();
                    if id.is_empty() || name.is_empty() { continue; }
                    let arguments = call.pointer("/function/arguments").and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({}));
                    content.push(json!({ "type": "toolCall", "id": id, "name": name, "arguments": arguments }));
                }
                (!content.is_empty()).then(|| {
                    copy_message_identity(
                        message,
                        json!({ "role": "assistant", "content": content }),
                    )
                })
            }
            Some("tool") => {
                let tool_call_id = message.get("tool_call_id").and_then(Value::as_str).unwrap_or("").trim();
                if tool_call_id.is_empty() { return None; }
                let raw = message.get("content").and_then(Value::as_str).unwrap_or("");
                let is_error = raw.starts_with("[error]");
                let text = truncate_text(raw.strip_prefix("[error] ").unwrap_or(raw));
                let mut output = json!({
                    "role": "toolResult", "toolCallId": tool_call_id,
                    "isError": is_error, "content": [{ "type": "text", "text": text }]
                });
                if let Some(audit) = snapshot_tool_audit(message.get("vcp_audit")) {
                    output["vcpAudit"] = audit;
                }
                Some(output)
            }
            _ => None,
        }
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment_fixture() -> Value {
        json!({
            "id": format!("attachment_{}", "a".repeat(64)),
            "displayName": "截图.png",
            "mimeType": "image/png",
            "byteLen": 1024,
            "width": 32,
            "height": 32,
            "sha256": "a".repeat(64),
            "assetFile": format!("{}.png", "a".repeat(64)),
        })
    }

    #[test]
    fn attachment_descriptor_round_trips_without_base64() {
        let message = identified_message(
            user_message("看图", &[attachment_fixture()]),
            "msg-turn-user".into(),
            "turn-1",
        );
        let snapshot = to_pi_snapshot(std::slice::from_ref(&message));
        let serialized = serde_json::to_string(&snapshot).expect("snapshot json");
        assert!(!serialized.contains("base64"));
        assert!(serialized.contains("attachment_"));
        let restored = normalize_initial_messages(Some(&Value::Array(snapshot)));
        assert_eq!(
            restored[0]
                .pointer("/content/1/type")
                .and_then(Value::as_str),
            Some("attachment_ref")
        );
        assert_eq!(
            restored[0]
                .pointer("/content/1/attachment/displayName")
                .and_then(Value::as_str),
            Some("截图.png")
        );
    }

    #[test]
    fn media_attachment_descriptor_round_trips_without_dimensions_or_data_url() {
        let attachment = json!({
            "id": format!("attachment_{}", "b".repeat(64)),
            "displayName": "录音.mp3",
            "kind": "audio",
            "mimeType": "audio/mpeg",
            "byteLen": 128,
            "sha256": "b".repeat(64),
            "assetFile": format!("{}.mp3", "b".repeat(64)),
        });
        let snapshot = to_pi_snapshot(&[identified_message(
            user_message("请转写", &[attachment]),
            "msg-turn-user".into(),
            "turn-1",
        )]);
        let serialized = serde_json::to_string(&snapshot).expect("snapshot json");
        assert!(!serialized.contains("base64"));
        assert!(!serialized.contains("data:audio"));
        let restored = normalize_initial_messages(Some(&Value::Array(snapshot)));
        let descriptor = restored[0]
            .pointer("/content/1/attachment")
            .expect("attachment descriptor");
        assert_eq!(descriptor["kind"], "audio");
        assert!(descriptor.get("width").is_none());
        assert!(descriptor.get("height").is_none());
    }

    #[test]
    fn rejects_media_descriptors_with_image_dimensions_or_unknown_mime() {
        let mut audio = json!({
            "id": format!("attachment_{}", "c".repeat(64)),
            "displayName": "录音.mp3",
            "kind": "audio",
            "mimeType": "audio/mpeg",
            "byteLen": 128,
            "sha256": "c".repeat(64),
            "assetFile": format!("{}.mp3", "c".repeat(64)),
        });
        audio["width"] = json!(32);
        assert!(sanitize_attachment_descriptor(&audio).is_none());
        audio.as_object_mut().expect("object").remove("width");
        audio["mimeType"] = json!("audio/not-real");
        assert!(sanitize_attachment_descriptor(&audio).is_none());
    }

    #[test]
    fn missing_provider_usage_falls_back_to_labelled_estimates() {
        let mut totals = UsageTotals::default();
        let round = totals.add(None, 120, 30);
        assert_eq!(round["source"], "estimated");
        assert_eq!(round["totalTokens"], 150);
        assert_eq!(totals.as_value()["estimated"], true);
        assert_eq!(totals.as_value()["requests"], 1);
    }

    #[test]
    fn provider_usage_wins_when_available() {
        let mut totals = UsageTotals::default();
        let round = totals.add(
            Some(&json!({"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12})),
            120,
            30,
        );
        assert_eq!(round["source"], "provider");
        assert_eq!(round["totalTokens"], 12);
        assert_eq!(totals.as_value()["source"], "provider");
    }

    #[test]
    fn streaming_marker_filter_never_releases_raw_tool_markers_and_projects_display_markers() {
        let mut filter = AssistantMarkerFilter::default();
        let first = filter.push("回答前<<<[VCP_DY");
        assert!(matches!(
            first.as_slice(),
            [AssistantMarkerOutput::Text(text)] if text == "回答前"
        ));
        let second = filter.push("NAMIC_FOLD]>>> 私有   上下文 <<<[END_VCP_DYNAMIC_FOLD]>>>后");
        assert!(matches!(
            second.as_slice(),
            [
                AssistantMarkerOutput::Observation { kind: AssistantMarkerKind::DynamicFold, summary, detail },
                AssistantMarkerOutput::Text(text)
            ] if summary == "私有 上下文" && detail == " 私有   上下文 " && text == "后"
        ));
        let third = filter.push("<<<[TOOL_REQUEST]>>>{\"danger\":true}<<<[END_TOOL_REQUEST]>>>");
        assert!(matches!(
            third.as_slice(),
            [AssistantMarkerOutput::Warning(text)] if text.contains("removed and not executed")
        ));
        assert!(filter.finish().is_empty());
    }

    #[test]
    fn incomplete_marker_is_removed_fail_closed_at_model_end() {
        let mut filter = AssistantMarkerFilter::default();
        assert!(filter.push("<<<[VCPINFO]>>>不完整").is_empty());
        let finished = filter.finish();
        assert!(matches!(
            finished.as_slice(),
            [AssistantMarkerOutput::Warning(text)] if text.contains("incomplete VCP notification")
        ));
    }
    use tokio::time::{Duration, timeout};

    async fn next(outbound: &mut mpsc::Receiver<WireMessage>) -> WireMessage {
        timeout(Duration::from_secs(1), outbound.recv())
            .await
            .expect("actor timed out")
            .expect("actor closed")
    }

    async fn next_type(outbound: &mut mpsc::Receiver<WireMessage>, kind: &str) -> WireMessage {
        for _ in 0..16 {
            let message = next(outbound).await;
            if message.kind == kind {
                return message;
            }
        }
        panic!("did not receive {kind}");
    }

    fn session_message(kind: &str, request_id: &str, session_id: &str) -> WireMessage {
        let mut message = WireMessage::new(kind).with_request_id(request_id);
        message.session_id = Some(session_id.to_string());
        message
    }

    #[tokio::test]
    async fn actor_assembles_fragmented_vcp_invoke_and_completes_tool_loop() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = WireMessage::new("create-session")
            .with_request_id("create")
            .put(
                "options",
                json!({ "vcp": { "model": "gpt-5.6-terra" }, "systemPrompt": "{{Nova}}" }),
            );
        create.session_id = Some("session-1".to_string());
        runtime.handle(create).await.expect("create");
        assert_eq!(next(&mut outbound_rx).await.kind, "ack");
        let mut start = WireMessage::new("start-turn")
            .with_request_id("start")
            .put("prompt", "use a tool");
        start.session_id = Some("session-1".to_string());
        start.turn_id = Some("turn-1".to_string());
        runtime.handle(start).await.expect("start");
        let model_request = next_type(&mut outbound_rx, "model-request").await;
        assert_eq!(
            model_request.value("body").unwrap()["tools"][0]["function"]["name"],
            "vcp_invoke"
        );
        let request_id = model_request.request_id.clone().unwrap();

        let mut fragment_one = session_message("model-delta", &request_id, "session-1");
        fragment_one.payload.insert("delta".to_string(), json!({
            "reasoning_content": "先算一下",
            "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "vcp_", "arguments": "{\"toolName\":\"SciCalculator\",\"arguments\":{" } }]
        }));
        runtime.handle(fragment_one).await.unwrap();
        let mut fragment_two = session_message("model-delta", &request_id, "session-1");
        fragment_two.payload.insert("delta".to_string(), json!({
            "tool_calls": [{ "index": 0, "function": { "name": "invoke", "arguments": "\"expression\":\"6*7\"}}" } }]
        }));
        runtime.handle(fragment_two).await.unwrap();
        let mut done = session_message("model-done", &request_id, "session-1");
        done.payload
            .insert("usage".to_string(), json!({ "total_tokens": 12 }));
        runtime.handle(done).await.unwrap();

        let preflight = next_type(&mut outbound_rx, "tool-request").await;
        assert_eq!(preflight.string("phase"), Some("preflight"));
        assert_eq!(
            preflight.value("arguments").unwrap()["toolName"],
            "SciCalculator"
        );
        let mut approved = session_message("tool-result", "", "session-1");
        approved.tool_call_id = preflight.tool_call_id.clone();
        approved.payload.insert("ok".to_string(), json!(true));
        runtime.handle(approved).await.unwrap();
        let execute = next_type(&mut outbound_rx, "tool-request").await;
        assert_eq!(execute.string("phase"), Some("execute"));
        let mut result = session_message("tool-result", "", "session-1");
        result.tool_call_id = execute.tool_call_id.clone();
        result.payload.insert("ok".to_string(), json!(true));
        result.payload.insert("output".to_string(), json!("42"));
        runtime.handle(result).await.unwrap();

        let second_model_request = next_type(&mut outbound_rx, "model-request").await;
        let second_request_id = second_model_request.request_id.clone().unwrap();
        let mut reply = session_message("model-delta", &second_request_id, "session-1");
        reply
            .payload
            .insert("delta".to_string(), json!({ "content": "答案是 42。" }));
        runtime.handle(reply).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &second_request_id,
                "session-1",
            ))
            .await
            .unwrap();
        let completed = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(completed.request_id.as_deref(), Some("start"));
        assert_eq!(completed.value("result").unwrap()["snapshot"]["version"], 1);
        let usage = &completed.value("result").unwrap()["usage"];
        assert!(usage["totalTokens"].as_u64().unwrap() > 12);
        assert_eq!(usage["requests"], 2);
        assert_eq!(usage["source"], "mixed");
    }

    #[tokio::test]
    async fn reasoning_events_keep_turn_and_message_identity_before_a_tool_round() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-reasoning-tool");
        create
            .payload
            .insert("options".to_string(), json!({ "vcp": { "model": "test" } }));
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;

        let mut start = session_message("start-turn", "start", "session-reasoning-tool");
        start.turn_id = Some("turn-reasoning-tool".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("use a tool"));
        runtime.handle(start).await.unwrap();
        let request = next_type(&mut outbound_rx, "model-request").await;
        let request_id = request.request_id.expect("model request id");
        let mut delta = session_message("model-delta", &request_id, "session-reasoning-tool");
        delta.payload.insert("delta".to_string(), json!({
            "reasoning_content": "I should use the tool.",
            "tool_calls": [{
                "index": 0,
                "id": "call_reasoning_tool",
                "function": { "name": "vcp_invoke", "arguments": r#"{"toolName":"SciCalculator","arguments":{"expression":"6*7"}}"# }
            }]
        }));
        runtime.handle(delta).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &request_id,
                "session-reasoning-tool",
            ))
            .await
            .unwrap();

        let mut saw_reasoning_completed = false;
        for _ in 0..8 {
            let message = next(&mut outbound_rx).await;
            if message.kind == "tool-request" {
                break;
            }
            if message.kind != "event" {
                continue;
            }
            let event = message.value("event").expect("event payload");
            let event_type = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if event_type.starts_with("reasoning.") || event_type.starts_with("assistant.") {
                assert_eq!(
                    event.get("turnId").and_then(Value::as_str),
                    Some("turn-reasoning-tool")
                );
                assert!(event.get("messageId").and_then(Value::as_str).is_some());
            }
            if event_type == "reasoning.completed" {
                saw_reasoning_completed = true;
            }
        }
        assert!(
            saw_reasoning_completed,
            "the tool round must finish the visible reasoning event"
        );
    }

    #[tokio::test]
    async fn completed_model_turn_emits_terminal_event_before_snapshot_ack() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-terminal");
        create
            .payload
            .insert("options".to_string(), json!({ "vcp": { "model": "test" } }));
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-terminal");
        start.turn_id = Some("turn-terminal".to_string());
        start.payload.insert("prompt".to_string(), json!("hello"));
        runtime.handle(start).await.unwrap();
        let request = next_type(&mut outbound_rx, "model-request").await;
        let request_id = request.request_id.expect("model request id");
        let mut delta = session_message("model-delta", &request_id, "session-terminal");
        delta
            .payload
            .insert("delta".to_string(), json!({ "content": "done" }));
        runtime.handle(delta).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &request_id,
                "session-terminal",
            ))
            .await
            .unwrap();

        let mut events = Vec::new();
        let mut saw_ack = false;
        for _ in 0..8 {
            let message = next(&mut outbound_rx).await;
            if message.kind == "event" {
                assert_eq!(message.turn_id.as_deref(), Some("turn-terminal"));
                events.push(
                    message
                        .value("event")
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
            }
            if message.kind == "ack" && message.request_id.as_deref() == Some("start") {
                saw_ack = true;
                break;
            }
        }
        assert!(events.iter().any(|event| event == "assistant.completed"));
        assert!(events.iter().any(|event| event == "turn.completed"));
        assert!(saw_ack, "terminal snapshot ACK must still be delivered");
    }

    #[tokio::test]
    async fn required_tool_choice_is_limited_to_the_first_model_round() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-choice");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test", "toolChoice": "required" } }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-choice");
        start.turn_id = Some("turn-choice".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("use a tool"));
        runtime.handle(start).await.unwrap();
        let first = next_type(&mut outbound_rx, "model-request").await;
        assert_eq!(first.value("body").unwrap()["tool_choice"], "required");

        let first_id = first.request_id.expect("first request id");
        let mut tool = session_message("model-delta", &first_id, "session-choice");
        tool.payload.insert("delta".to_string(), json!({ "tool_calls": [{
            "index": 0, "id": "call-choice",
            "function": { "name": "vcp_invoke", "arguments": "{\"toolName\":\"SciCalculator\",\"arguments\":{\"expression\":\"1+1\"}}" }
        }] }));
        runtime.handle(tool).await.unwrap();
        runtime
            .handle(session_message("model-done", &first_id, "session-choice"))
            .await
            .unwrap();
        let preflight = next_type(&mut outbound_rx, "tool-request").await;
        let mut approved = session_message("tool-result", "", "session-choice");
        approved.tool_call_id = preflight.tool_call_id.clone();
        approved.payload.insert("ok".to_string(), json!(true));
        runtime.handle(approved).await.unwrap();
        let execute = next_type(&mut outbound_rx, "tool-request").await;
        let mut result = session_message("tool-result", "", "session-choice");
        result.tool_call_id = execute.tool_call_id.clone();
        result.payload.insert("ok".to_string(), json!(true));
        result.payload.insert("output".to_string(), json!("2"));
        runtime.handle(result).await.unwrap();
        let second = next_type(&mut outbound_rx, "model-request").await;
        assert_eq!(second.value("body").unwrap()["tool_choice"], "auto");
    }

    #[tokio::test]
    async fn model_request_uses_shared_agent_max_output_when_configured() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-output-limit");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test", "maxOutput": 4096 } }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-output-limit");
        start.turn_id = Some("turn-output-limit".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("long answer"));
        runtime.handle(start).await.unwrap();
        let request = next_type(&mut outbound_rx, "model-request").await;
        assert_eq!(
            request.value("body").unwrap()["requestId"],
            request.request_id.as_deref().unwrap()
        );
        assert_eq!(request.value("body").unwrap()["max_tokens"], 4096);
    }

    #[tokio::test]
    async fn cancellation_aborts_current_model_and_late_events_are_ignored() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-2");
        create
            .payload
            .insert("options".to_string(), json!({ "vcp": { "model": "test" } }));
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-2");
        start.turn_id = Some("turn-2".to_string());
        start.payload.insert("prompt".to_string(), json!("hello"));
        runtime.handle(start).await.unwrap();
        let request = next_type(&mut outbound_rx, "model-request").await;
        let request_id = request.request_id.unwrap();
        runtime
            .handle(session_message("cancel-turn", "cancel", "session-2"))
            .await
            .unwrap();
        let abort = next_type(&mut outbound_rx, "model-abort").await;
        assert_eq!(abort.request_id.as_deref(), Some(request_id.as_str()));
        let cancelled = next_type(&mut outbound_rx, "event").await;
        assert_eq!(cancelled.value("event").unwrap()["type"], "turn.cancelled");
        let turn_ack = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(turn_ack.request_id.as_deref(), Some("start"));
        assert_eq!(
            turn_ack.value("result").unwrap()["interrupted"],
            json!(true)
        );
        assert!(
            turn_ack.value("result").unwrap()["snapshot"]["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("不会自动重放")
        );
        let cancel_ack = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(cancel_ack.request_id.as_deref(), Some("cancel"));

        let mut late = session_message("model-delta", &request_id, "session-2");
        late.payload
            .insert("delta".to_string(), json!({ "content": "must be ignored" }));
        runtime.handle(late).await.unwrap();
        assert!(
            timeout(Duration::from_millis(30), outbound_rx.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn forced_compaction_summarizes_then_publishes_pi_checkpoint() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let initial_messages: Vec<Value> = (0..10)
            .map(|index| {
                json!({
                    "role": if index % 2 == 0 { "user" } else { "assistant" },
                    "content": [{ "type": "text", "text": format!("历史 {index}: {}", "中".repeat(600)) }]
                })
            })
            .collect();
        let mut create = session_message("create-session", "create", "session-compact");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "gpt-5.6-terra" }, "initialMessages": initial_messages }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "compact", "session-compact");
        start.turn_id = Some("turn-compact".to_string());
        start.payload.insert("prompt".to_string(), json!(""));
        start.payload.insert(
            "compaction".to_string(),
            json!({ "force": true, "only": true }),
        );
        runtime.handle(start).await.unwrap();
        let summary_request = next_type(&mut outbound_rx, "model-request").await;
        assert_eq!(
            summary_request.value("body").unwrap()["requestId"],
            summary_request.request_id.as_deref().unwrap()
        );
        assert!(
            summary_request
                .value("body")
                .unwrap()
                .get("tools")
                .is_none()
        );
        assert!(
            summary_request.value("body").unwrap()["messages"][0]["content"]
                .as_str()
                .unwrap()
                .contains("Summarize completed")
        );
        let request_id = summary_request.request_id.clone().unwrap();
        let mut delta = session_message("model-delta", &request_id, "session-compact");
        delta.payload.insert(
            "delta".to_string(),
            json!({ "content": "## Goal\n完成上下文压缩。\n\n## Verified progress\n历史已验证。\n\n## Next safe action\n继续。" }),
        );
        runtime.handle(delta).await.unwrap();
        let mut done = session_message("model-done", &request_id, "session-compact");
        done.payload.insert(
            "usage".to_string(),
            json!({ "prompt_tokens": 30, "completion_tokens": 10, "total_tokens": 40 }),
        );
        runtime.handle(done).await.unwrap();
        let completed = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(completed.request_id.as_deref(), Some("compact"));
        let messages = completed.value("result").unwrap()["snapshot"]["messages"]
            .as_array()
            .unwrap();
        assert!(
            messages[0]["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("[VCP CHECKPOINT")
        );
        assert!(
            messages
                .iter()
                .all(|message| message.get("role").and_then(Value::as_str) != Some("tool"))
        );
        assert_eq!(
            completed.value("result").unwrap()["usage"]["totalTokens"],
            40
        );
    }

    #[tokio::test]
    async fn automatic_compaction_runs_below_hard_limit_then_continues_turn() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        // 13 CJK-heavy entries exceed the normal 80% trigger but remain below
        // the provider-safe hard limit for this 12k context configuration.
        let initial_messages: Vec<Value> = (0..13)
            .map(|index| {
                json!({
                    "role": if index % 2 == 0 { "user" } else { "assistant" },
                    "content": [{ "type": "text", "text": format!("历史 {index}: {}", "中".repeat(600)) }]
                })
            })
            .collect();
        let mut create = session_message("create-session", "create", "session-auto-compact");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test" }, "initialMessages": initial_messages }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-auto-compact");
        start.turn_id = Some("turn-auto-compact".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("继续完成任务"));
        start.payload.insert(
            "compaction".to_string(),
            json!({ "contextWindow": 12000, "maxOutput": 200 }),
        );
        runtime.handle(start).await.unwrap();
        let summary = next_type(&mut outbound_rx, "model-request").await;
        assert!(summary.value("body").unwrap().get("tools").is_none());
        let summary_id = summary.request_id.clone().unwrap();
        let mut summary_delta = session_message("model-delta", &summary_id, "session-auto-compact");
        summary_delta.payload.insert(
            "delta".to_string(),
            json!({ "content": "## Goal\n继续完成任务。\n\n## Verified progress\n已完成历史检查。\n\n## Next safe action\n继续执行。" }),
        );
        runtime.handle(summary_delta).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &summary_id,
                "session-auto-compact",
            ))
            .await
            .unwrap();
        let normal = next_type(&mut outbound_rx, "model-request").await;
        assert!(normal.value("body").unwrap().get("tools").is_some());
        assert!(
            normal.value("body").unwrap()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("[VCP CHECKPOINT"))
        );
        let normal_id = normal.request_id.clone().unwrap();
        let mut answer = session_message("model-delta", &normal_id, "session-auto-compact");
        answer
            .payload
            .insert("delta".to_string(), json!({ "content": "已继续完成。" }));
        runtime.handle(answer).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &normal_id,
                "session-auto-compact",
            ))
            .await
            .unwrap();
        let completed = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(completed.request_id.as_deref(), Some("start"));
    }

    #[tokio::test]
    async fn degenerate_summary_on_normal_turn_keeps_history_and_continues() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let initial_messages: Vec<Value> = (0..13)
            .map(|index| json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": format!("历史 {index}: {}", "中".repeat(600)) }]
            }))
            .collect();
        let mut create = session_message("create-session", "create", "session-degenerate");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test" }, "initialMessages": initial_messages }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-degenerate");
        start.turn_id = Some("turn-degenerate".to_string());
        start.payload.insert("prompt".to_string(), json!("继续"));
        start.payload.insert(
            "compaction".to_string(),
            json!({ "contextWindow": 12000, "maxOutput": 200 }),
        );
        runtime.handle(start).await.unwrap();
        let summary = next_type(&mut outbound_rx, "model-request").await;
        let summary_id = summary.request_id.clone().unwrap();
        let mut tiny = session_message("model-delta", &summary_id, "session-degenerate");
        tiny.payload
            .insert("delta".to_string(), json!({ "content": "太短" }));
        runtime.handle(tiny).await.unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &summary_id,
                "session-degenerate",
            ))
            .await
            .unwrap();
        let failed = next_type(&mut outbound_rx, "event").await;
        assert_eq!(
            failed.value("event").unwrap()["type"],
            "context.compaction.failed"
        );
        let normal = next_type(&mut outbound_rx, "model-request").await;
        assert!(normal.value("body").unwrap().get("tools").is_some());
        assert!(
            !normal.value("body").unwrap()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("[VCP CHECKPOINT"))
        );
    }

    #[tokio::test]
    async fn hard_limit_summary_error_fails_closed_without_second_model_request() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let initial_messages: Vec<Value> = (0..10)
            .map(|index| json!({
                "role": if index % 2 == 0 { "user" } else { "assistant" },
                "content": [{ "type": "text", "text": format!("历史 {index}: {}", "中".repeat(600)) }]
            }))
            .collect();
        let mut create = session_message("create-session", "create", "session-hard-limit");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test" }, "initialMessages": initial_messages }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-hard-limit");
        start.turn_id = Some("turn-hard-limit".to_string());
        start.payload.insert("prompt".to_string(), json!("继续"));
        start.payload.insert(
            "compaction".to_string(),
            json!({ "contextWindow": 6000, "maxOutput": 1000 }),
        );
        runtime.handle(start).await.unwrap();
        let summary = next_type(&mut outbound_rx, "model-request").await;
        let summary_id = summary.request_id.clone().unwrap();
        let mut error = session_message("model-error", &summary_id, "session-hard-limit");
        error
            .payload
            .insert("error".to_string(), json!("context summary unavailable"));
        runtime.handle(error).await.unwrap();
        let failed = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(failed.request_id.as_deref(), Some("start"));
        assert_eq!(failed.value("ok"), Some(&json!(false)));
        assert!(
            timeout(Duration::from_millis(30), outbound_rx.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancelling_during_compaction_aborts_summary_and_ignores_late_result() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let initial_messages: Vec<Value> = (0..10)
            .map(|index| {
                json!({
                    "role": if index % 2 == 0 { "user" } else { "assistant" },
                    "content": [{ "type": "text", "text": format!("检查记录 {index}: {}", "中".repeat(200)) }]
                })
            })
            .collect();
        let mut create = session_message("create-session", "create", "session-cancel-compact");
        create.payload.insert(
            "options".to_string(),
            json!({ "vcp": { "model": "test" }, "initialMessages": initial_messages }),
        );
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-cancel-compact");
        start.turn_id = Some("turn-cancel-compact".to_string());
        start.payload.insert("prompt".to_string(), json!(""));
        start.payload.insert(
            "compaction".to_string(),
            json!({ "force": true, "only": true }),
        );
        runtime.handle(start).await.unwrap();
        let summary = next_type(&mut outbound_rx, "model-request").await;
        let summary_id = summary.request_id.clone().unwrap();
        runtime
            .handle(session_message(
                "cancel-turn",
                "cancel",
                "session-cancel-compact",
            ))
            .await
            .unwrap();
        let abort = next_type(&mut outbound_rx, "model-abort").await;
        assert_eq!(abort.request_id.as_deref(), Some(summary_id.as_str()));
        let cancelled = next_type(&mut outbound_rx, "event").await;
        assert_eq!(cancelled.value("event").unwrap()["type"], "turn.cancelled");
        let start_ack = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(start_ack.request_id.as_deref(), Some("start"));
        assert_eq!(
            start_ack.value("result").unwrap()["interrupted"],
            json!(true)
        );
        let cancel_ack = next_type(&mut outbound_rx, "ack").await;
        assert_eq!(cancel_ack.request_id.as_deref(), Some("cancel"));
        let mut late = session_message("model-delta", &summary_id, "session-cancel-compact");
        late.payload
            .insert("delta".to_string(), json!({ "content": "must be ignored" }));
        runtime.handle(late).await.unwrap();
        assert!(
            timeout(Duration::from_millis(30), outbound_rx.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn denied_preflight_never_emits_execute_and_returns_to_model() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-deny");
        create
            .payload
            .insert("options".to_string(), json!({ "vcp": { "model": "test" } }));
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-deny");
        start.turn_id = Some("turn-deny".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("try tool"));
        runtime.handle(start).await.unwrap();
        let model = next_type(&mut outbound_rx, "model-request").await;
        let model_id = model.request_id.clone().unwrap();
        let mut delta = session_message("model-delta", &model_id, "session-deny");
        delta.payload.insert("delta".to_string(), json!({ "tool_calls": [{
            "index": 0, "id": "call_deny",
            "function": { "name": "vcp_invoke", "arguments": "{\"toolName\":\"FileOperator\",\"arguments\":{\"action\":\"write\"}}" }
        }] }));
        runtime.handle(delta).await.unwrap();
        runtime
            .handle(session_message("model-done", &model_id, "session-deny"))
            .await
            .unwrap();
        let preflight = next_type(&mut outbound_rx, "tool-request").await;
        assert_eq!(preflight.string("phase"), Some("preflight"));
        let mut denied = session_message("tool-result", "", "session-deny");
        denied.tool_call_id = preflight.tool_call_id.clone();
        denied.payload.insert("ok".to_string(), json!(false));
        denied
            .payload
            .insert("error".to_string(), json!("denied by policy"));
        runtime.handle(denied).await.unwrap();
        let retry = next_type(&mut outbound_rx, "model-request").await;
        assert_ne!(retry.request_id, preflight.request_id);
        assert!(
            retry.value("body").unwrap()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "tool"
                    && message["content"]
                        .as_str()
                        .unwrap_or("")
                        .contains("denied by policy"))
        );
    }

    #[tokio::test]
    async fn steering_is_prioritized_at_tool_safe_boundary_before_follow_up() {
        let (outbound_tx, mut outbound_rx) = mpsc::channel(32);
        let mut runtime = CoreRuntime::new(outbound_tx);
        let mut create = session_message("create-session", "create", "session-steering");
        create
            .payload
            .insert("options".to_string(), json!({ "vcp": { "model": "test" } }));
        runtime.handle(create).await.unwrap();
        let _ = next(&mut outbound_rx).await;
        let mut start = session_message("start-turn", "start", "session-steering");
        start.turn_id = Some("turn-steering".to_string());
        start
            .payload
            .insert("prompt".to_string(), json!("先完成任务"));
        runtime.handle(start).await.unwrap();
        let first_model = next_type(&mut outbound_rx, "model-request").await;
        let first_id = first_model.request_id.clone().unwrap();

        // Enqueue follow-up first to prove that the distinct steering queue,
        // rather than request arrival order, defines the next safe action.
        let mut follow = session_message("follow-up-turn", "follow", "session-steering");
        follow
            .payload
            .insert("interactionId".to_string(), json!("follow_1"));
        follow
            .payload
            .insert("prompt".to_string(), json!("最后再总结"));
        runtime.handle(follow).await.unwrap();
        let _ = next_type(&mut outbound_rx, "ack").await;
        let mut steer = session_message("steer-turn", "steer", "session-steering");
        steer
            .payload
            .insert("interactionId".to_string(), json!("steer_1"));
        steer
            .payload
            .insert("prompt".to_string(), json!("先检查风险"));
        runtime.handle(steer).await.unwrap();
        let _ = next_type(&mut outbound_rx, "ack").await;

        let mut tool_delta = session_message("model-delta", &first_id, "session-steering");
        tool_delta.payload.insert("delta".to_string(), json!({ "tool_calls": [{
            "index": 0, "id": "call_steering",
            "function": { "name": "vcp_invoke", "arguments": "{\"toolName\":\"SciCalculator\",\"arguments\":{\"expression\":\"1+1\"}}" }
        }] }));
        runtime.handle(tool_delta).await.unwrap();
        runtime
            .handle(session_message("model-done", &first_id, "session-steering"))
            .await
            .unwrap();
        let preflight = next_type(&mut outbound_rx, "tool-request").await;
        let mut approved = session_message("tool-result", "", "session-steering");
        approved.tool_call_id = preflight.tool_call_id.clone();
        approved.payload.insert("ok".to_string(), json!(true));
        runtime.handle(approved).await.unwrap();
        let execute = next_type(&mut outbound_rx, "tool-request").await;
        let mut result = session_message("tool-result", "", "session-steering");
        result.tool_call_id = execute.tool_call_id.clone();
        result.payload.insert("ok".to_string(), json!(true));
        result.payload.insert("output".to_string(), json!("2"));
        runtime.handle(result).await.unwrap();

        let steering_model = next_type(&mut outbound_rx, "model-request").await;
        let steering_messages = steering_model.value("body").unwrap()["messages"]
            .as_array()
            .unwrap();
        assert!(steering_messages.iter().any(|message| {
            message["content"].as_str().unwrap_or("").contains(
                "The user sent a message while you were working:\n<user_query>\n先检查风险",
            )
        }));
        let steering_id = steering_model.request_id.clone().unwrap();
        runtime
            .handle(session_message(
                "model-done",
                &steering_id,
                "session-steering",
            ))
            .await
            .unwrap();
        let follow_model = next_type(&mut outbound_rx, "model-request").await;
        assert!(
            follow_model.value("body").unwrap()["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"] == "最后再总结")
        );
    }

    #[test]
    fn normalizes_pi_snapshot_and_never_splits_tool_result_from_call() {
        let normalized = normalize_initial_messages(Some(&json!([
            { "role": "user", "content": [{ "type": "text", "text": "你好" }] },
            { "role": "assistant", "content": [
                { "type": "thinking", "text": "hidden" },
                { "type": "text", "text": "我来计算" },
                { "type": "toolCall", "id": "call_1", "name": "vcp_invoke", "arguments": { "toolName": "SciCalculator", "arguments": { "expression": "6*7" } } }
            ] },
            { "role": "toolResult", "toolCallId": "call_1", "content": [{ "type": "text", "text": "42" }] }
        ])));
        assert_eq!(normalized[0]["content"], "你好");
        assert_eq!(
            normalized[1]["tool_calls"][0]["function"]["name"],
            "vcp_invoke"
        );
        assert_eq!(normalized[2]["tool_call_id"], "call_1");

        let mut messages = vec![json!({ "role": "user", "content": "old" })];
        messages.push(
            json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "call_2" }] }),
        );
        messages.push(json!({ "role": "tool", "tool_call_id": "call_2", "content": "result" }));
        messages.extend(
            (0..159).map(|index| json!({ "role": "user", "content": format!("new {index}") })),
        );
        let tail = safe_snapshot_tail(&messages);
        assert!(tail.len() <= MAX_TRANSCRIPT_MESSAGES);
        assert!(
            !tail
                .iter()
                .any(|message| message.get("role").and_then(Value::as_str) == Some("tool")),
            "the tool result must be dropped with its preceding call"
        );
    }

    #[test]
    fn normalizes_legacy_openai_snapshot_without_losing_tool_pair() {
        let normalized = normalize_initial_messages(Some(&json!([
            { "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_legacy", "type": "function",
                "function": { "name": "vcp_invoke", "arguments": "{\"toolName\":\"SciCalculator\",\"arguments\":{}}" }
            }] },
            { "role": "tool", "tool_call_id": "call_legacy", "content": "42" }
        ])));
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0]["tool_calls"][0]["id"], "call_legacy");
        assert_eq!(normalized[1]["tool_call_id"], "call_legacy");
    }

    #[test]
    fn publishes_a_topic_store_compatible_pi_snapshot() {
        let snapshot = to_pi_snapshot(&[
            json!({ "messageId":"msg-1", "turnId":"turn-1", "timestamp":7, "role": "user", "content": "请计算" }),
            json!({ "role": "assistant", "content": null, "tool_calls": [{
                "id": "call_1", "function": { "name": "vcp_invoke", "arguments": "{\"toolName\":\"SciCalculator\",\"arguments\":{}}" }
            }] }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "42", "vcp_audit": {
                "toolName": "SciCalculator", "resources": [{"url":"https://example.invalid/result"}],
                "warnings": ["rounded"], "task": {"id":"task-1", "status":"completed"}
            } }),
        ]);
        assert_eq!(snapshot[0]["role"], "user");
        assert_eq!(snapshot[0]["messageId"], "msg-1");
        assert_eq!(snapshot[0]["turnId"], "turn-1");
        assert_eq!(snapshot[0]["timestamp"], 7);
        assert!(provider_message(&snapshot[0]).get("messageId").is_none());
        assert_eq!(snapshot[1]["content"][0]["type"], "toolCall");
        assert_eq!(snapshot[2]["role"], "toolResult");
        assert_eq!(snapshot[2]["vcpAudit"]["toolName"], "SciCalculator");
        assert_eq!(snapshot[2]["vcpAudit"]["task"]["id"], "task-1");
        let restored = normalize_initial_messages(Some(&Value::Array(snapshot)));
        assert_eq!(restored[2]["vcp_audit"]["warnings"][0], "rounded");
    }

    #[test]
    fn tool_audit_checkpoint_is_bounded_and_omits_paths_and_data_uris() {
        let audit = snapshot_tool_audit(Some(&json!({
            "toolName": "FileOperator",
            "resources": [{
                "path": "C:\\Users\\person\\secret.txt",
                "url": "file:///C:/Users/person/secret.txt",
                "preview": "data:image/png;base64,AAAA",
                "name": "safe.txt"
            }],
            "warnings": ["x".repeat(16 * 1024)]
        })))
        .expect("audit projection");
        let serialized = audit.to_string();
        assert!(!serialized.contains("C:\\Users"));
        assert!(!serialized.contains("file:///"));
        assert!(!serialized.contains("data:image"));
        assert!(serialized.contains("safe.txt"));
        assert!(
            audit["warnings"][0]
                .as_str()
                .is_some_and(|warning| warning.len() < 9 * 1024)
        );
    }

    #[test]
    fn compaction_source_bounds_large_tool_output_without_breaking_cjk_or_code_evidence() {
        let source = format_compaction_source(&[
            json!({ "role": "user", "content": "请修复下面的代码：\n```rust\nfn main() { println!(\"你好\"); }\n```" }),
            json!({ "role": "assistant", "content": "我会先读取工具结果。", "tool_calls": [{ "id": "call_1", "function": { "name": "vcp_invoke", "arguments": "{}" } }] }),
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "中".repeat(70 * 1024) }),
        ]);
        assert!(source.contains("fn main()"));
        assert!(source.contains("你好"));
        assert!(source.contains("[tool calls]"));
        assert!(source.contains("…[truncated]"));
        // Tool evidence is limited to 1 KiB (+ the UTF-8-safe suffix), rather
        // than feeding its original 200+ KiB byte representation to summary.
        assert!(
            source.len() < 10 * 1024,
            "source unexpectedly retained raw tool output"
        );
        assert!(std::str::from_utf8(source.as_bytes()).is_ok());
    }
}
