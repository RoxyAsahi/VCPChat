//! Language-neutral wire contract for the VCP Agent daemon.
//!
//! The contract mirrors the existing Node sidecar semantics but uses framed
//! JSON over stdin/stdout so an Electron or CLI host can supervise a Rust
//! daemon without exposing a local network port.

use std::io;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::codec::{FramedRead, FramedWrite, LengthDelimitedCodec};

pub const PROTOCOL_VERSION: u32 = 1;
/// Additive revision of the stable v1 frame contract. Keep this explicit so
/// the daemon and Electron transport cannot silently drift while retaining
/// the same major framing version.
pub const PROTOCOL_REVISION: &str = "1.7";
pub const MAX_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_MODEL_DELTA_BYTES: usize = 8 * 1024;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("frame exceeds {MAX_FRAME_BYTES} byte protocol limit")]
    FrameTooLarge,
    #[error("invalid protocol JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid daemon message: {0}")]
    InvalidMessage(String),
}

/// A versioned message whose known envelope fields remain stable while payload
/// fields evolve additively. Field spelling intentionally matches the existing
/// JavaScript sidecar (`requestId`, `sessionId`, `toolCallId`, …).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireMessage {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "protocolVersion", skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(flatten)]
    pub payload: Map<String, Value>,
}

impl WireMessage {
    pub fn new(kind: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            protocol_version: None,
            request_id: None,
            session_id: None,
            turn_id: None,
            tool_call_id: None,
            payload: Map::new(),
        }
    }

    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }

    pub fn put(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.payload.insert(key.into(), value.into());
        self
    }

    pub fn string(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.payload.get(key).and_then(Value::as_bool)
    }

    pub fn value(&self, key: &str) -> Option<&Value> {
        self.payload.get(key)
    }
}

pub fn codec() -> LengthDelimitedCodec {
    LengthDelimitedCodec::builder()
        .max_frame_length(MAX_FRAME_BYTES)
        .new_codec()
}

/// Validate limits that apply after a frame has been decoded.  In particular,
/// a valid 256 KiB frame must not let a hostile Host bypass the tighter 8 KiB
/// model-delta bound that keeps actor memory and event fan-out predictable.
pub fn validate_message(message: &WireMessage) -> Result<(), ProtocolError> {
    if message.kind.trim().is_empty() {
        return Err(ProtocolError::InvalidMessage(
            "message type is empty".to_string(),
        ));
    }
    if message.kind == "model-delta" {
        let delta = message.value("delta").ok_or_else(|| {
            ProtocolError::InvalidMessage("model-delta requires delta".to_string())
        })?;
        let encoded = serde_json::to_vec(delta)?;
        if encoded.len() > MAX_MODEL_DELTA_BYTES {
            return Err(ProtocolError::InvalidMessage(format!(
                "model-delta exceeds {MAX_MODEL_DELTA_BYTES} byte limit"
            )));
        }
    }
    Ok(())
}

/// Validate a GUI/host command before it is dispatched to the direct daemon.
/// `WireMessage` remains the framed transport shape, but the direct protocol
/// is deliberately not an open-ended bag of JSON: every accepted command has
/// a request id, the v1 version marker and its documented identity/payload.
pub fn validate_direct_command(message: &WireMessage) -> Result<(), ProtocolError> {
    if message.protocol_version != Some(PROTOCOL_VERSION) {
        return Err(ProtocolError::InvalidMessage(format!(
            "direct command requires protocolVersion {PROTOCOL_VERSION}"
        )));
    }
    required_non_empty(message.request_id.as_deref(), "requestId")?;

    match message.kind.as_str() {
        "hello"
        | "shutdown"
        | "list-topics"
        | "get-settings"
        | "get-index-status"
        | "rebuild-topic-index" => {
            if message.kind == "list-topics" {
                optional_payload_string(message, "agentId")?;
            }
        }
        "create-topic" => {
            required_payload_string(message, "agentId")?;
            optional_payload_string(message, "title")?;
            optional_payload_string(message, "model")?;
            optional_payload_string(message, "workspaceRoot")?;
        }
        "ensure-topic-runtime" => {
            required_payload_string(message, "topicId")?;
            required_payload_string(message, "agentId")?;
            optional_payload_string(message, "model")?;
            optional_payload_string(message, "workspaceRoot")?;
            if let Some(mode) = message.string("permissionMode")
                && !matches!(mode, "ask" | "always-approve")
            {
                return Err(ProtocolError::InvalidMessage(
                    "ensure-topic-runtime permissionMode must be ask or always-approve".to_string(),
                ));
            }
        }
        "detach-topic"
        | "cancel-turn"
        | "compact"
        | "list-interaction-queue"
        | "clear-interaction-queue" => {
            required_identity(message, "sessionId")?;
            required_payload_string(message, "topicId")?;
        }
        "import-attachment" => {
            required_identity(message, "sessionId")?;
            required_payload_string(message, "topicId")?;
            required_payload_string(message, "path")?;
        }
        "start-turn" => {
            required_identity(message, "sessionId")?;
            required_identity(message, "turnId")?;
            required_payload_string(message, "topicId")?;
            let prompt = message
                .value("prompt")
                .and_then(Value::as_str)
                .unwrap_or("");
            let attachments = validate_attachment_array(message.value("attachments"))?;
            if prompt.trim().is_empty() && attachments == 0 {
                return Err(ProtocolError::InvalidMessage(
                    "start-turn requires prompt or attachments".to_string(),
                ));
            }
        }
        "steer-turn" | "follow-up-turn" => {
            required_identity(message, "sessionId")?;
            required_identity(message, "turnId")?;
            required_payload_string(message, "topicId")?;
            required_payload_string(message, "prompt")?;
        }
        "approval" => {
            required_identity(message, "sessionId")?;
            required_identity(message, "turnId")?;
            required_identity(message, "toolCallId")?;
            required_payload_string(message, "topicId")?;
            required_payload_string(message, "approvalId")?;
            required_payload_string(message, "argumentsHash")?;
            if message.bool("allowed").is_none() && message.string("decision").is_none() {
                return Err(ProtocolError::InvalidMessage(
                    "approval requires boolean allowed or string decision".to_string(),
                ));
            }
        }
        "toolbox-approval" => {
            required_payload_string(message, "approvalRequestId")?;
            if message.bool("approved").is_none() {
                return Err(ProtocolError::InvalidMessage(
                    "toolbox-approval requires boolean approved".to_string(),
                ));
            }
            optional_payload_string(message, "reason")?;
        }
        "read-topic" | "takeover-topic" | "delete-topic" => {
            required_payload_string(message, "topicId")?;
            optional_payload_string(message, "agentId")?;
        }
        "search-topics" => {
            required_payload_string(message, "query")?;
            optional_payload_string(message, "agentId")?;
            optional_search_limit(message)?;
        }
        "search-topic-messages" => {
            required_payload_string(message, "query")?;
            required_payload_string(message, "topicId")?;
            optional_payload_string(message, "agentId")?;
            optional_search_limit(message)?;
        }
        "rename-topic" => {
            required_payload_string(message, "topicId")?;
            required_payload_string(message, "title")?;
            optional_payload_string(message, "agentId")?;
        }
        "replace-interaction-queue" => {
            required_identity(message, "sessionId")?;
            required_payload_string(message, "topicId")?;
            if !matches!(message.value("interactions"), Some(Value::Array(_))) {
                return Err(ProtocolError::InvalidMessage(
                    "replace-interaction-queue requires interactions array".to_string(),
                ));
            }
        }
        "list-active-runtimes" => {}
        "update-settings" => {
            if !matches!(message.value("settings"), Some(Value::Object(_))) {
                return Err(ProtocolError::InvalidMessage(
                    "update-settings requires settings object".to_string(),
                ));
            }
        }
        "set-workbench-presence" => {
            if message.bool("mounted").is_none() {
                return Err(ProtocolError::InvalidMessage(
                    "set-workbench-presence requires boolean mounted".to_string(),
                ));
            }
        }
        other => {
            return Err(ProtocolError::InvalidMessage(format!(
                "unsupported direct daemon command: {other}"
            )));
        }
    }
    Ok(())
}

/// Validate final daemon frames that cross the Rust ↔ GUI boundary. Internal
/// Host/Core messages are allowed to be richer; this function establishes the
/// stable v1.7 public projection consumed by Electron and the standalone TUI.
pub fn validate_direct_daemon_message(message: &WireMessage) -> Result<(), ProtocolError> {
    match message.kind.as_str() {
        "ready" => {
            if message.protocol_version != Some(PROTOCOL_VERSION) {
                return Err(ProtocolError::InvalidMessage(
                    "ready has incompatible protocolVersion".into(),
                ));
            }
            if message.string("protocolRevision") != Some(PROTOCOL_REVISION) {
                return Err(ProtocolError::InvalidMessage(
                    "ready has incompatible protocolRevision".into(),
                ));
            }
            let revision = message.string("buildRevision").unwrap_or_default();
            if !(7..=64).contains(&revision.len())
                || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(ProtocolError::InvalidMessage(
                    "ready requires hexadecimal buildRevision".into(),
                ));
            }
        }
        "ack" => {
            required_non_empty(message.request_id.as_deref(), "requestId")?;
            if message.bool("ok").is_none() {
                return Err(ProtocolError::InvalidMessage(
                    "ack requires boolean ok".into(),
                ));
            }
        }
        "fatal" => {
            required_payload_string(message, "error")?;
        }
        "control-event" => {
            required_non_empty(message.request_id.as_deref(), "requestId")?;
            required_payload_string(message, "kind")?;
            if message.value("payload").is_none() {
                return Err(ProtocolError::InvalidMessage(
                    "control-event requires payload".into(),
                ));
            }
        }
        "event" => validate_direct_event(message.value("event"))?,
        other => {
            return Err(ProtocolError::InvalidMessage(format!(
                "unsupported direct daemon frame: {other}"
            )));
        }
    }
    Ok(())
}

fn required_non_empty(value: Option<&str>, field: &str) -> Result<(), ProtocolError> {
    if value.is_some_and(|value| !value.trim().is_empty()) {
        Ok(())
    } else {
        Err(ProtocolError::InvalidMessage(format!(
            "{field} is required"
        )))
    }
}

fn required_identity(message: &WireMessage, field: &str) -> Result<(), ProtocolError> {
    let value = match field {
        "sessionId" => message.session_id.as_deref(),
        "turnId" => message.turn_id.as_deref(),
        "toolCallId" => message.tool_call_id.as_deref(),
        _ => None,
    };
    required_non_empty(value, field)
}

fn required_payload_string(message: &WireMessage, field: &str) -> Result<(), ProtocolError> {
    required_non_empty(message.string(field), field)
}

fn optional_payload_string(message: &WireMessage, field: &str) -> Result<(), ProtocolError> {
    match message.value(field) {
        None => Ok(()),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(()),
        Some(_) => Err(ProtocolError::InvalidMessage(format!(
            "{field} must be a non-empty string when supplied"
        ))),
    }
}

fn optional_search_limit(message: &WireMessage) -> Result<(), ProtocolError> {
    match message.value("limit") {
        None => Ok(()),
        Some(Value::Number(value))
            if value
                .as_u64()
                .is_some_and(|limit| (1..=500).contains(&limit)) =>
        {
            Ok(())
        }
        Some(_) => Err(ProtocolError::InvalidMessage(
            "limit must be an integer between 1 and 500".to_string(),
        )),
    }
}

fn validate_attachment_array(value: Option<&Value>) -> Result<usize, ProtocolError> {
    let Some(value) = value else {
        return Ok(0);
    };
    let Some(attachments) = value.as_array() else {
        return Err(ProtocolError::InvalidMessage(
            "attachments must be an array".to_string(),
        ));
    };
    if attachments.len() > 8 {
        return Err(ProtocolError::InvalidMessage(
            "attachments exceeds the per-turn limit".to_string(),
        ));
    }
    if attachments.iter().any(|attachment| !attachment.is_object()) {
        return Err(ProtocolError::InvalidMessage(
            "each attachment must be a descriptor object".to_string(),
        ));
    }
    Ok(attachments.len())
}

fn validate_direct_event(value: Option<&Value>) -> Result<(), ProtocolError> {
    let Some(Value::Object(event)) = value else {
        return Err(ProtocolError::InvalidMessage(
            "event requires an object payload".into(),
        ));
    };
    for field in ["eventId", "sessionId", "topicId", "type"] {
        required_non_empty(event.get(field).and_then(Value::as_str), field)?;
    }
    if event.get("runtime").and_then(Value::as_str) != Some("rust") {
        return Err(ProtocolError::InvalidMessage(
            "event requires runtime=rust".into(),
        ));
    }
    if event.get("sequence").and_then(Value::as_u64).is_none()
        || event.get("timestamp").and_then(Value::as_u64).is_none()
    {
        return Err(ProtocolError::InvalidMessage(
            "event requires unsigned sequence and timestamp".into(),
        ));
    }
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if (event_type.starts_with("assistant.")
        || event_type.starts_with("reasoning.")
        || event_type == "turn.started")
        && (event.get("turnId").and_then(Value::as_str).is_none()
            || event.get("messageId").and_then(Value::as_str).is_none())
    {
        return Err(ProtocolError::InvalidMessage(
            "message event requires turnId and messageId".into(),
        ));
    }
    if event_type.starts_with("tool.") && event.get("toolCallId").and_then(Value::as_str).is_none()
    {
        return Err(ProtocolError::InvalidMessage(
            "tool event requires toolCallId".into(),
        ));
    }
    Ok(())
}

pub async fn read_message<R>(
    reader: &mut FramedRead<R, LengthDelimitedCodec>,
) -> Result<Option<WireMessage>, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    match reader.next().await {
        Some(Ok(frame)) => {
            let message: WireMessage = serde_json::from_slice(&frame)?;
            validate_message(&message)?;
            Ok(Some(message))
        }
        Some(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
            Err(ProtocolError::FrameTooLarge)
        }
        Some(Err(error)) => Err(ProtocolError::Io(error)),
        None => Ok(None),
    }
}

pub async fn write_message<W>(
    writer: &mut FramedWrite<W, LengthDelimitedCodec>,
    message: &WireMessage,
) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    validate_message(message)?;
    let encoded = serde_json::to_vec(message)?;
    if encoded.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge);
    }
    writer.send(Bytes::from(encoded)).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct ProtocolFixture {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "protocolRevision")]
        protocol_revision: String,
        #[serde(rename = "hostToDaemon")]
        host_to_daemon: Vec<WireMessage>,
        #[serde(rename = "daemonToHost")]
        daemon_to_host: Vec<WireMessage>,
        #[serde(rename = "invalidHostToDaemon")]
        invalid_host_to_daemon: Vec<WireMessage>,
        #[serde(rename = "invalidDaemonToHost")]
        invalid_daemon_to_host: Vec<WireMessage>,
    }

    #[test]
    fn preserves_node_style_envelope_fields() {
        let message = WireMessage::new("tool-request")
            .with_request_id("req_1")
            .put("phase", "preflight")
            .put("ok", true);
        let value = serde_json::to_value(&message).expect("serialize");
        assert_eq!(value["type"], "tool-request");
        assert_eq!(value["requestId"], "req_1");
        assert_eq!(value["phase"], "preflight");
        assert_eq!(value["ok"], true);
        assert!(value.get("session_id").is_none());
    }

    #[test]
    fn rejects_delta_over_the_protocol_specific_limit() {
        let message = WireMessage::new("model-delta")
            .put("delta", Value::String("x".repeat(MAX_MODEL_DELTA_BYTES)));
        assert!(matches!(
            validate_message(&message),
            Err(ProtocolError::InvalidMessage(_))
        ));
    }

    #[test]
    fn shared_v1_fixture_deserializes_in_rust() {
        let fixture: ProtocolFixture =
            serde_json::from_str(include_str!("../../../fixtures/daemon-v1.json"))
                .expect("shared fixture must remain valid JSON");
        assert_eq!(fixture.protocol_version, PROTOCOL_VERSION);
        assert_eq!(fixture.protocol_revision, PROTOCOL_REVISION);
        assert!(fixture.host_to_daemon.len() >= 20);
        assert!(fixture.daemon_to_host.len() >= 8);
        for message in fixture.host_to_daemon.iter() {
            validate_message(message).expect("fixture message must satisfy v1 bounds");
            validate_direct_command(message).expect("fixture command must satisfy v1.7 schema");
        }
        for message in fixture.daemon_to_host.iter() {
            validate_message(message).expect("fixture message must satisfy v1 bounds");
            validate_direct_daemon_message(message)
                .expect("fixture response must satisfy v1.7 schema");
        }
        for message in fixture.invalid_host_to_daemon.iter() {
            assert!(validate_direct_command(message).is_err());
        }
        for message in fixture.invalid_daemon_to_host.iter() {
            assert!(validate_direct_daemon_message(message).is_err());
        }
    }
}
