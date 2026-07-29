//! Direct, in-memory VCPToolBox transport for a future Rust-only host.
//!
//! The running VCPAgent JS host remains the authority for credentials,
//! approval, workspace policy and execution.  This module is intentionally
//! dormant in that path: it gives a future Rust TUI the same public ToolBox
//! contract without inventing an MCP registry, local capability executor, or
//! a second settings store.

use std::collections::BTreeMap;

use futures_util::StreamExt;
use reqwest::{Client, header};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::encode_legacy_tool_request;

const MAX_SSE_EVENT_BYTES: usize = 256 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Error)]
pub enum ToolboxHostError {
    #[error("invalid VCPToolBox server URL")]
    InvalidServerUrl,
    #[error("VCPToolBox server URL must use http or https")]
    InvalidServerScheme,
    #[error("VCPToolBox request failed: {0}")]
    Request(String),
    #[error("VCPToolBox HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("VCPToolBox SSE event exceeds {MAX_SSE_EVENT_BYTES} bytes")]
    SseEventTooLarge,
    #[error("VCPToolBox response exceeds {MAX_HTTP_BODY_BYTES} bytes")]
    ResponseTooLarge,
    #[error("VCPToolBox response is not valid UTF-8")]
    InvalidUtf8,
    #[error("VCPToolBox response is not valid JSON: {0}")]
    InvalidResponse(String),
    #[error("VCPToolBox marker protocol rejected the request: {0}")]
    Protocol(String),
    #[error("VCPToolBox WebSocket failed: {0}")]
    WebSocket(String),
}

/// Ephemeral credentials and endpoints supplied by a caller.  This type is
/// deliberately neither serializable nor `Debug`; constructing it never
/// writes a key to disk or logs one accidentally.
#[derive(Clone)]
pub struct ToolboxConnection {
    base_url: Url,
    api_key: String,
}

impl ToolboxConnection {
    pub fn new(server_url: &str, api_key: impl Into<String>) -> Result<Self, ToolboxHostError> {
        let base_url =
            Url::parse(server_url.trim()).map_err(|_| ToolboxHostError::InvalidServerUrl)?;
        if !matches!(base_url.scheme(), "http" | "https") || base_url.host_str().is_none() {
            return Err(ToolboxHostError::InvalidServerScheme);
        }
        let mut normalized = base_url;
        normalized.set_path("");
        normalized.set_query(None);
        normalized.set_fragment(None);
        Ok(Self {
            base_url: normalized,
            api_key: api_key.into(),
        })
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn has_api_key(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    fn endpoint(&self, path: &str) -> Result<Url, ToolboxHostError> {
        self.base_url
            .join(path.trim_start_matches('/'))
            .map_err(|_| ToolboxHostError::InvalidServerUrl)
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.api_key)
    }
}

pub fn normalize_toolbox_base_url(server_url: &str) -> Result<String, ToolboxHostError> {
    Ok(ToolboxConnection::new(server_url, "")?
        .base_url()
        .to_string()
        .trim_end_matches('/')
        .to_string())
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolboxSseEvent {
    Json(Value),
    Done,
}

/// Incremental SSE parser that accepts arbitrary network byte boundaries and
/// validates size before JSON parsing.  It only exposes `data:` payloads;
/// other SSE fields are irrelevant to the OpenAI-compatible ToolBox stream.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<ToolboxSseEvent>, ToolboxHostError> {
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(end) = find_sse_separator(&self.buffer) {
            if end > MAX_SSE_EVENT_BYTES {
                return Err(ToolboxHostError::SseEventTooLarge);
            }
            let raw = self.buffer.drain(..end).collect::<Vec<_>>();
            let separator_len = if self.buffer.starts_with(b"\r\n\r\n") {
                4
            } else {
                2
            };
            self.buffer.drain(..separator_len);
            if let Some(event) = parse_sse_event(&raw)? {
                events.push(event);
            }
        }
        if self.buffer.len() > MAX_SSE_EVENT_BYTES {
            return Err(ToolboxHostError::SseEventTooLarge);
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<ToolboxSseEvent>, ToolboxHostError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        if self.buffer.len() > MAX_SSE_EVENT_BYTES {
            return Err(ToolboxHostError::SseEventTooLarge);
        }
        let raw = std::mem::take(&mut self.buffer);
        Ok(parse_sse_event(&raw)?.into_iter().collect())
    }
}

fn find_sse_separator(bytes: &[u8]) -> Option<usize> {
    let crlf = bytes.windows(4).position(|part| part == b"\r\n\r\n");
    let lf = bytes.windows(2).position(|part| part == b"\n\n");
    match (crlf, lf) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(index), None) | (None, Some(index)) => Some(index),
        (None, None) => None,
    }
}

fn parse_sse_event(raw: &[u8]) -> Result<Option<ToolboxSseEvent>, ToolboxHostError> {
    let text = std::str::from_utf8(raw).map_err(|_| ToolboxHostError::InvalidUtf8)?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>();
    if data.is_empty() {
        return Ok(None);
    }
    let data = data.join("\n");
    if data.trim() == "[DONE]" {
        return Ok(Some(ToolboxSseEvent::Done));
    }
    // A malformed server event must not crash a standalone client. It is
    // represented verbatim and lets the caller classify the model error.
    Ok(Some(ToolboxSseEvent::Json(
        serde_json::from_str(&data).unwrap_or_else(|_| json!({ "raw": data })),
    )))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxToolResult {
    pub ok: bool,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub status: u16,
}

/// Future Rust-only ToolBox client. It accepts an already-loaded connection;
/// callers keep settings and key storage outside this crate.
#[derive(Clone)]
pub struct DirectToolboxHost {
    connection: ToolboxConnection,
    client: Client,
}

impl DirectToolboxHost {
    pub fn new(connection: ToolboxConnection) -> Result<Self, ToolboxHostError> {
        let client = Client::builder()
            .build()
            .map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        Ok(Self { connection, client })
    }

    pub fn connection(&self) -> &ToolboxConnection {
        &self.connection
    }

    /// Fetch an existing ToolBox JSON endpoint with the same authorization
    /// rules as chat/tool requests. This is intentionally narrow: callers
    /// choose the endpoint and remain responsible for interpreting the
    /// response, while this client enforces the shared response-size limit.
    pub async fn get_json(&self, path: &str) -> Result<Value, ToolboxHostError> {
        let response = self
            .client
            .get(self.connection.endpoint(path)?)
            .header(header::AUTHORIZATION, self.connection.authorization())
            .send()
            .await
            .map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        if !response.status().is_success() {
            return Err(http_error(response).await);
        }
        let text = read_response_text(response).await?;
        serde_json::from_str(&text)
            .map_err(|error| ToolboxHostError::InvalidResponse(error.to_string()))
    }

    /// Send one OpenAI-compatible ToolBox chat request and invoke `on_event`
    /// incrementally for every SSE `data:` event.  No model/provider endpoint
    /// is assumed beyond the existing `/v1/chat/completions` public surface.
    pub async fn stream_chat(
        &self,
        body: &Value,
        mut on_event: impl FnMut(ToolboxSseEvent),
    ) -> Result<(), ToolboxHostError> {
        let response = self
            .client
            .post(self.connection.endpoint("/v1/chat/completions")?)
            .header(header::AUTHORIZATION, self.connection.authorization())
            .json(body)
            .send()
            .await
            .map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        if !response.status().is_success() {
            return Err(http_error(response).await);
        }
        let mut decoder = SseDecoder::default();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| ToolboxHostError::Request(error.to_string()))?;
            for event in decoder.push(&chunk)? {
                let done = matches!(event, ToolboxSseEvent::Done);
                on_event(event);
                if done {
                    return Ok(());
                }
            }
        }
        for event in decoder.finish()? {
            on_event(event);
        }
        Ok(())
    }

    /// Use the original ToolBox marker endpoint. The marker is constructed in
    /// trusted Rust host code and is never a native model tool schema.
    pub async fn invoke_legacy_tool(
        &self,
        tool_name: &str,
        arguments: &Map<String, Value>,
    ) -> Result<ToolboxToolResult, ToolboxHostError> {
        let response = self
            .client
            .post(self.connection.endpoint("/v1/human/tool")?)
            .header(header::AUTHORIZATION, self.connection.authorization())
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(
                encode_legacy_tool_request(tool_name, arguments)
                    .map_err(|error| ToolboxHostError::Protocol(error.to_string()))?,
            )
            .send()
            .await
            .map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        let status = response.status();
        let text = read_response_text(response).await?;
        let parsed = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
        if !status.is_success() {
            return Ok(ToolboxToolResult {
                ok: false,
                output: String::new(),
                error: Some(truncate(&display_value(parsed), 1_000)),
                status: status.as_u16(),
            });
        }
        Ok(normalize_human_tool_result(parsed, status.as_u16()))
    }

    /// Best-effort cancellation of a model request. ToolBox is authoritative:
    /// a caller must still treat local cancellation and backend approval as
    /// independent state transitions.
    pub async fn interrupt(&self, request_id: &str) -> Result<bool, ToolboxHostError> {
        let response = self
            .client
            .post(self.connection.endpoint("/v1/interrupt")?)
            .header(header::AUTHORIZATION, self.connection.authorization())
            .json(&json!({ "requestId": request_id }))
            .send()
            .await
            .map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        Ok(response.status().is_success())
    }

    /// Connect one existing ToolBox WebSocket channel in read-only mode. This
    /// function never writes to the socket, registers a tool, or answers an
    /// `execute_tool` request. Reconnection policy belongs to the future UI
    /// host, keeping this reusable observer stateless.
    pub async fn observe_websocket(
        &self,
        channel: ToolboxWsChannel,
        mut on_event: impl FnMut(ToolboxWsEvent),
    ) -> Result<(), ToolboxHostError> {
        let endpoints = websocket_endpoints(&self.connection)?;
        let endpoint = endpoints
            .get(&channel)
            .ok_or(ToolboxHostError::InvalidServerUrl)?;
        let (mut socket, _) = connect_async(endpoint.as_str())
            .await
            .map_err(|error| ToolboxHostError::WebSocket(error.to_string()))?;
        while let Some(message) = socket.next().await {
            match message.map_err(|error| ToolboxHostError::WebSocket(error.to_string()))? {
                Message::Text(text) => dispatch_ws_payload(channel, &text, &mut on_event),
                Message::Binary(bytes) => {
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        dispatch_ws_payload(channel, text, &mut on_event);
                    }
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                Message::Close(_) => break,
            }
        }
        // Explicitly close without sending an application-level message.
        let _ = socket.close(None).await;
        Ok(())
    }
}

async fn http_error(response: reqwest::Response) -> ToolboxHostError {
    let status = response.status().as_u16();
    let body = read_response_text(response)
        .await
        .unwrap_or_else(|_| "response body unavailable".to_string());
    ToolboxHostError::Http {
        status,
        body: truncate(&body, 1_000),
    }
}

async fn read_response_text(response: reqwest::Response) -> Result<String, ToolboxHostError> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ToolboxHostError::Request(error.to_string()))?;
        if body.len().saturating_add(chunk.len()) > MAX_HTTP_BODY_BYTES {
            return Err(ToolboxHostError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| ToolboxHostError::InvalidUtf8)
}

fn normalize_human_tool_result(value: Value, status: u16) -> ToolboxToolResult {
    if let Value::Object(object) = &value {
        if let Some(error) = object.get("error") {
            return ToolboxToolResult {
                ok: false,
                output: String::new(),
                error: Some(truncate(&display_value(error.clone()), 1_000)),
                status,
            };
        }
        if object.get("status").and_then(Value::as_str) == Some("error") {
            let error = object
                .get("message")
                .or_else(|| object.get("content"))
                .cloned()
                .unwrap_or(value);
            return ToolboxToolResult {
                ok: false,
                output: String::new(),
                error: Some(truncate(&display_value(error), 1_000)),
                status,
            };
        }
        let content = object
            .get("content")
            .or_else(|| object.get("result"))
            .cloned()
            .unwrap_or(value);
        return ToolboxToolResult {
            ok: true,
            output: truncate(&display_value(content), MAX_TOOL_OUTPUT_BYTES),
            error: None,
            status,
        };
    }
    ToolboxToolResult {
        ok: true,
        output: truncate(&display_value(value), MAX_TOOL_OUTPUT_BYTES),
        error: None,
        status,
    }
}

fn display_value(value: Value) -> String {
    match value {
        Value::String(text) => text,
        other => other.to_string(),
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &text[..end])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolboxWsChannel {
    Log,
    Info,
    Distributed,
}

pub fn websocket_endpoints(
    connection: &ToolboxConnection,
) -> Result<BTreeMap<ToolboxWsChannel, Url>, ToolboxHostError> {
    let mut base = connection.base_url.clone();
    let scheme = match base.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err(ToolboxHostError::InvalidServerScheme),
    };
    base.set_scheme(scheme)
        .map_err(|_| ToolboxHostError::InvalidServerScheme)?;
    let suffix = if connection.has_api_key() {
        format!("/VCP_Key={}", encode_uri_component(&connection.api_key))
    } else {
        String::new()
    };
    let mut endpoints = BTreeMap::new();
    for (channel, path) in [
        (ToolboxWsChannel::Log, "VCPlog"),
        (ToolboxWsChannel::Info, "vcpinfo"),
        (ToolboxWsChannel::Distributed, "vcp-distributed-server"),
    ] {
        let mut endpoint = base.clone();
        endpoint.set_path(&format!("/{path}{suffix}"));
        endpoints.insert(channel, endpoint);
    }
    Ok(endpoints)
}

// `url::form_urlencoded` follows HTML form semantics and turns spaces into
// `+`; ToolBox's established WebSocket contract uses JavaScript
// `encodeURIComponent`, which keeps the unambiguous `%20` spelling instead.
fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolboxLogEntry {
    pub level: String,
    pub source: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolboxWsEvent {
    Log(ToolboxLogEntry),
    Info(Value),
    /// A ToolBox-owned manual approval request broadcast on VCPlog. Its
    /// requestId belongs to ToolBox and is intentionally not treated as a
    /// VCPAgent toolCallId: the legacy marker endpoint exposes no reliable
    /// cross-system correlation key.
    BackendApprovalRequest(Value),
    /// A visible diagnostic only. The read-only observer never acknowledges
    /// or executes this distributed-server request.
    DistributedExecutionIgnored(Value),
}

fn dispatch_ws_payload(
    channel: ToolboxWsChannel,
    text: &str,
    on_event: &mut impl FnMut(ToolboxWsEvent),
) {
    let value =
        serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.to_string()));
    match channel {
        ToolboxWsChannel::Log => {
            if value.get("type").and_then(Value::as_str) == Some("tool_approval_request") {
                on_event(ToolboxWsEvent::BackendApprovalRequest(value));
            } else {
                for entry in normalize_log_entries(value) {
                    on_event(ToolboxWsEvent::Log(entry));
                }
            }
        }
        ToolboxWsChannel::Info => on_event(ToolboxWsEvent::Info(value)),
        ToolboxWsChannel::Distributed => {
            if value.get("type").and_then(Value::as_str) == Some("execute_tool") {
                on_event(ToolboxWsEvent::DistributedExecutionIgnored(value));
            }
        }
    }
}

fn normalize_log_entries(value: Value) -> Vec<ToolboxLogEntry> {
    let items = value.as_array().cloned().unwrap_or_else(|| vec![value]);
    items
        .into_iter()
        .filter_map(|item| match item {
            Value::String(message) if !message.is_empty() => Some(ToolboxLogEntry {
                level: "info".to_string(),
                source: "toolbox".to_string(),
                message,
                timestamp: 0,
            }),
            Value::Object(object) => {
                let properties = object.get("properties").and_then(Value::as_object);
                let message = object
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| object.get("text").and_then(Value::as_str))
                    .or_else(|| {
                        properties
                            .and_then(|props| props.get("content"))
                            .and_then(Value::as_str)
                    })?;
                if message.is_empty() {
                    return None;
                }
                let raw_level = object
                    .get("level")
                    .and_then(Value::as_str)
                    .unwrap_or("info")
                    .to_lowercase();
                let level = match raw_level.as_str() {
                    "debug" | "info" | "warn" | "error" => raw_level,
                    "warning" => "warn".to_string(),
                    _ => "info".to_string(),
                };
                Some(ToolboxLogEntry {
                    level,
                    source: object
                        .get("source")
                        .or_else(|| object.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("toolbox")
                        .to_string(),
                    message: message.to_string(),
                    timestamp: object.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
                })
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_decoder_handles_cjk_split_and_done() {
        let mut decoder = SseDecoder::default();
        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"你".as_bytes();
        assert!(decoder.push(first).unwrap().is_empty());
        let second = "好\"}}]}\n\ndata: [DONE]\n\n".as_bytes();
        let events = decoder.push(second).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            ToolboxSseEvent::Json(json!({ "choices": [{ "delta": { "content": "你好" } }] }))
        );
        assert_eq!(events[1], ToolboxSseEvent::Done);
    }

    #[test]
    fn endpoint_and_websocket_paths_match_existing_toolbox_contract() {
        let connection =
            ToolboxConnection::new("http://localhost:6005/path?ignored=yes", "a b").unwrap();
        assert_eq!(
            normalize_toolbox_base_url("http://localhost:6005/path").unwrap(),
            "http://localhost:6005"
        );
        let endpoints = websocket_endpoints(&connection).unwrap();
        assert_eq!(
            endpoints[&ToolboxWsChannel::Log].as_str(),
            "ws://localhost:6005/VCPlog/VCP_Key=a%20b"
        );
        assert_eq!(
            endpoints[&ToolboxWsChannel::Info].as_str(),
            "ws://localhost:6005/vcpinfo/VCP_Key=a%20b"
        );
    }

    #[test]
    fn normalizer_and_log_observer_keep_existing_vcp_shapes() {
        let result = normalize_human_tool_result(json!({ "content": { "answer": 42 } }), 200);
        assert_eq!(result.output, "{\"answer\":42}");
        let logs = normalize_log_entries(
            json!({ "level": "warning", "properties": { "content": "插件已连接" } }),
        );
        assert_eq!(logs[0].level, "warn");
        assert_eq!(logs[0].message, "插件已连接");
    }

    #[test]
    fn backend_approval_request_stays_structured_and_is_not_a_log_line() {
        let mut events = Vec::new();
        dispatch_ws_payload(
            ToolboxWsChannel::Log,
            r#"{"type":"tool_approval_request","data":{"requestId":"approve-1","toolName":"PowerShellExecutor","approvalTtlMs":300000}}"#,
            &mut |event| events.push(event),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            ToolboxWsEvent::BackendApprovalRequest(value) => {
                assert_eq!(
                    value.pointer("/data/requestId").and_then(Value::as_str),
                    Some("approve-1")
                );
            }
            other => panic!("unexpected VCPlog event: {other:?}"),
        }
    }
}
