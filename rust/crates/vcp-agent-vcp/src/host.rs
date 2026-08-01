//! Direct, in-memory VCPToolBox transport for a future Rust-only host.
//!
//! The running VCPAgent JS host remains the authority for credentials,
//! approval, workspace policy and execution.  This module is intentionally
//! dormant in that path: it gives a future Rust TUI the same public ToolBox
//! contract without inventing an MCP registry, local capability executor, or
//! a second settings store.

use std::{collections::BTreeMap, time::Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, header};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use url::Url;

use crate::encode_legacy_tool_request;

const MAX_SSE_EVENT_BYTES: usize = 256 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 256 * 1024;

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
    websocket_endpoint_override: Option<Url>,
}

impl ToolboxConnection {
    pub fn new(server_url: &str, api_key: impl Into<String>) -> Result<Self, ToolboxHostError> {
        let base_url =
            Url::parse(server_url.trim()).map_err(|_| ToolboxHostError::InvalidServerUrl)?;
        if !matches!(base_url.scheme(), "http" | "https") || base_url.host_str().is_none() {
            return Err(ToolboxHostError::InvalidServerScheme);
        }
        let websocket_endpoint_override =
            is_complete_websocket_channel(&base_url).then_some(base_url.clone());
        let mut normalized = base_url;
        normalized.set_path("");
        normalized.set_query(None);
        normalized.set_fragment(None);
        Ok(Self {
            base_url: normalized,
            api_key: api_key.into(),
            websocket_endpoint_override,
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

fn is_complete_websocket_channel(url: &Url) -> bool {
    let path = url.path().trim_end_matches('/').to_ascii_lowercase();
    ["/vcplog", "/vcpinfo", "/vcp-distributed-server"]
        .iter()
        .any(|channel| path == *channel || path.starts_with(&format!("{channel}/vcp_key=")))
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<Value>,
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
                resources: Vec::new(),
                warnings: Vec::new(),
                task: None,
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
        on_event: impl FnMut(ToolboxWsEvent),
    ) -> Result<(), ToolboxHostError> {
        self.observe_websocket_with_status(channel, |_| {}, on_event)
            .await
    }

    pub async fn observe_websocket_with_status(
        &self,
        channel: ToolboxWsChannel,
        mut on_connected: impl FnMut(ToolboxWsConnectionStatus),
        mut on_event: impl FnMut(ToolboxWsEvent),
    ) -> Result<(), ToolboxHostError> {
        let (mut socket, status) =
            open_websocket_with_fallback(&self.connection, channel, None).await?;
        on_connected(status);
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

    /// Run the authenticated VCPLog frontend connection. This is the only
    /// ToolBox observer socket allowed to send application messages, and the
    /// caller can only supply the already validated approval response shape.
    pub async fn run_log_websocket(
        &self,
        device_name: &str,
        responses: &mut mpsc::Receiver<ToolboxApprovalResponse>,
        on_event: impl FnMut(ToolboxWsEvent),
    ) -> Result<(), ToolboxHostError> {
        self.run_log_websocket_with_status(device_name, responses, |_| {}, on_event)
            .await
    }

    pub async fn run_log_websocket_with_status(
        &self,
        device_name: &str,
        responses: &mut mpsc::Receiver<ToolboxApprovalResponse>,
        mut on_connected: impl FnMut(ToolboxWsConnectionStatus),
        mut on_event: impl FnMut(ToolboxWsEvent),
    ) -> Result<(), ToolboxHostError> {
        let (mut socket, status) = open_websocket_with_fallback(
            &self.connection,
            ToolboxWsChannel::Log,
            Some(device_name),
        )
        .await?;
        on_connected(status);
        let mut terminal_error = None;
        loop {
            tokio::select! {
                inbound = socket.next() => {
                    let Some(inbound) = inbound else { break; };
                    let inbound = match inbound {
                        Ok(message) => message,
                        Err(error) => {
                            terminal_error = Some(ToolboxHostError::WebSocket(error.to_string()));
                            break;
                        }
                    };
                    match inbound {
                        Message::Text(text) => dispatch_ws_payload(ToolboxWsChannel::Log, &text, &mut on_event),
                        Message::Binary(bytes) => {
                            match std::str::from_utf8(&bytes) {
                                Ok(text) => dispatch_ws_payload(ToolboxWsChannel::Log, text, &mut on_event),
                                Err(_) => {
                                    terminal_error = Some(ToolboxHostError::InvalidUtf8);
                                    break;
                                }
                            }
                        }
                        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                        Message::Close(_) => break,
                    }
                }
                response = responses.recv() => {
                    let Some(response) = response else { break; };
                    let payload = match serde_json::to_string(&json!({
                        "type": "tool_approval_response",
                        "data": {
                            "requestId": response.request_id,
                            "approved": response.approved,
                            "reason": response.reason,
                        }
                    })) {
                        Ok(payload) => payload,
                        Err(error) => {
                            if let Some(completion) = response.completion {
                                let _ = completion.send(Err(error.to_string()));
                            }
                            terminal_error = Some(ToolboxHostError::InvalidResponse(error.to_string()));
                            break;
                        }
                    };
                    if payload.len() > MAX_WS_MESSAGE_BYTES {
                        if let Some(completion) = response.completion {
                            let _ = completion.send(Err("VCPLog approval response exceeds the message limit".into()));
                        }
                        terminal_error = Some(ToolboxHostError::ResponseTooLarge);
                        break;
                    }
                    match socket.send(Message::Text(payload)).await {
                        Ok(()) => {
                            if let Some(completion) = response.completion {
                                let _ = completion.send(Ok(()));
                            }
                        }
                        Err(error) => {
                            let message = error.to_string();
                            if let Some(completion) = response.completion {
                                let _ = completion.send(Err(message.clone()));
                            }
                            terminal_error = Some(ToolboxHostError::WebSocket(message));
                            break;
                        }
                    }
                }
            }
        }
        // A response can be queued while the socket is closing. Resolve all
        // such waiters explicitly; otherwise the Host could leave a GUI
        // approval in an indeterminate state forever.
        while let Ok(response) = responses.try_recv() {
            if let Some(completion) = response.completion {
                let _ = completion.send(Err(
                    "VCPLog WebSocket closed before approval response was written".into(),
                ));
            }
        }
        let _ = socket.close(None).await;
        match terminal_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

async fn connect_toolbox_websocket(
    endpoint: &Url,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    ToolboxHostError,
> {
    let config = WebSocketConfig {
        max_message_size: Some(MAX_WS_MESSAGE_BYTES),
        max_frame_size: Some(MAX_WS_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    };
    connect_async_with_config(endpoint.as_str(), Some(config), false)
        .await
        .map_err(|error| ToolboxHostError::WebSocket(error.to_string()))
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
        let resources = bounded_array(object.get("resources"));
        let warnings = bounded_array(object.get("warnings"));
        let task = object
            .get("task")
            .or_else(|| object.get("accepted"))
            .cloned()
            .map(bounded_value);
        if let Some(error) = object.get("error") {
            return ToolboxToolResult {
                ok: false,
                output: String::new(),
                error: Some(truncate(&display_value(error.clone()), 1_000)),
                status,
                resources,
                warnings,
                task,
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
                resources,
                warnings,
                task,
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
            resources,
            warnings,
            task,
        };
    }
    ToolboxToolResult {
        ok: true,
        output: truncate(&display_value(value), MAX_TOOL_OUTPUT_BYTES),
        error: None,
        status,
        resources: Vec::new(),
        warnings: Vec::new(),
        task: None,
    }
}

fn bounded_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
        .cloned()
        .map(bounded_value)
        .collect()
}

fn bounded_value(value: Value) -> Value {
    let encoded = value.to_string();
    if encoded.len() <= 8 * 1024 {
        value
    } else {
        json!({"truncated": true, "preview": truncate(&encoded, 8 * 1024)})
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolboxWsConnectionStatus {
    pub channel: ToolboxWsChannel,
    /// Credential-free endpoint suitable for structured diagnostics/UI.
    pub endpoint: String,
    pub latency_ms: u64,
}

/// Returns the legacy primary endpoint, the historical alternate endpoint,
/// and the query-channel form used by newer ToolBox deployments.  Only this
/// bounded candidate set is attempted; no endpoint is guessed from logs.
pub fn websocket_endpoint_candidates(
    connection: &ToolboxConnection,
    channel: ToolboxWsChannel,
) -> Result<Vec<Url>, ToolboxHostError> {
    if let Some(override_url) = &connection.websocket_endpoint_override {
        return Ok(vec![to_websocket_url(override_url.clone())?]);
    }
    let base = websocket_base_url(connection)?;
    let suffix = if connection.has_api_key() {
        format!("/VCP_Key={}", encode_uri_component(&connection.api_key))
    } else {
        String::new()
    };
    let (primary, fallback) = match channel {
        ToolboxWsChannel::Log => ("VCPlog", "vcpinfo"),
        ToolboxWsChannel::Info => ("vcpinfo", "VCPlog"),
        ToolboxWsChannel::Distributed => ("vcp-distributed-server", "vcp-distributed-server"),
    };
    let mut candidates = Vec::new();
    for path in [primary, fallback] {
        let mut endpoint = base.clone();
        endpoint.set_path(&format!("/{path}{suffix}"));
        if !candidates
            .iter()
            .any(|existing: &Url| existing == &endpoint)
        {
            candidates.push(endpoint);
        }
    }
    if channel != ToolboxWsChannel::Distributed {
        let mut query_endpoint = base;
        query_endpoint.set_path("/");
        query_endpoint.query_pairs_mut().append_pair(
            "channel",
            match channel {
                ToolboxWsChannel::Log => "log",
                ToolboxWsChannel::Info => "info",
                ToolboxWsChannel::Distributed => unreachable!(),
            },
        );
        if connection.has_api_key() {
            query_endpoint
                .query_pairs_mut()
                .append_pair("key", &connection.api_key);
        }
        if !candidates
            .iter()
            .any(|existing| existing == &query_endpoint)
        {
            candidates.push(query_endpoint);
        }
    }
    Ok(candidates)
}

pub fn websocket_endpoints(
    connection: &ToolboxConnection,
) -> Result<BTreeMap<ToolboxWsChannel, Url>, ToolboxHostError> {
    let mut endpoints = BTreeMap::new();
    for channel in [
        ToolboxWsChannel::Log,
        ToolboxWsChannel::Info,
        ToolboxWsChannel::Distributed,
    ] {
        let endpoint = websocket_endpoint_candidates(connection, channel)?
            .into_iter()
            .next()
            .ok_or(ToolboxHostError::InvalidServerUrl)?;
        endpoints.insert(channel, endpoint);
    }
    Ok(endpoints)
}

fn websocket_base_url(connection: &ToolboxConnection) -> Result<Url, ToolboxHostError> {
    to_websocket_url(connection.base_url.clone())
}

fn to_websocket_url(mut url: Url) -> Result<Url, ToolboxHostError> {
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(ToolboxHostError::InvalidServerScheme),
    };
    url.set_scheme(scheme)
        .map_err(|_| ToolboxHostError::InvalidServerScheme)?;
    Ok(url)
}

async fn open_websocket_with_fallback(
    connection: &ToolboxConnection,
    channel: ToolboxWsChannel,
    device_name: Option<&str>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        ToolboxWsConnectionStatus,
    ),
    ToolboxHostError,
> {
    let candidates = websocket_endpoint_candidates(connection, channel)?;
    let mut last_error = None;
    for mut endpoint in candidates {
        if let Some(device_name) = device_name {
            endpoint
                .query_pairs_mut()
                .append_pair("deviceName", device_name);
        }
        let started = Instant::now();
        match connect_toolbox_websocket(&endpoint).await {
            Ok((socket, _)) => {
                let latency_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                return Ok((
                    socket,
                    ToolboxWsConnectionStatus {
                        channel,
                        endpoint: redact_websocket_endpoint(&endpoint),
                        latency_ms,
                    },
                ));
            }
            Err(error) => {
                last_error = Some(redact_websocket_error(
                    error.to_string(),
                    &connection.api_key,
                ))
            }
        }
    }
    Err(ToolboxHostError::WebSocket(last_error.unwrap_or_else(
        || "no VCPToolBox WebSocket endpoint candidates".to_string(),
    )))
}

fn redact_websocket_endpoint(endpoint: &Url) -> String {
    let mut safe = endpoint.clone();
    let path = safe
        .path()
        .split('/')
        .map(|segment| {
            if segment.starts_with("VCP_Key=") {
                "VCP_Key=[redacted]"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    safe.set_path(&path);
    let query = safe
        .query_pairs()
        .filter(|(key, _)| key != "key" && key != "deviceName")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    safe.set_query(None);
    if !query.is_empty() {
        safe.query_pairs_mut().extend_pairs(
            query
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        );
    }
    safe.to_string()
}

fn redact_websocket_error(message: String, api_key: &str) -> String {
    let mut safe = message.replace(api_key, "[redacted]");
    let encoded = encode_uri_component(api_key);
    if !encoded.is_empty() {
        safe = safe.replace(&encoded, "[redacted]");
    }
    truncate(&safe, 1_000)
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

#[derive(Debug)]
pub struct ToolboxApprovalResponse {
    pub request_id: String,
    pub approved: bool,
    pub reason: Option<String>,
    /// The Host uses this to distinguish “queued locally” from a response
    /// actually written to the VCPLog WebSocket. It is intentionally not
    /// serializable and never crosses the daemon protocol boundary.
    pub completion: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
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
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::mpsc,
        time::{Duration, timeout},
    };
    use tokio_tungstenite::accept_async;

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
        let mut log = endpoints[&ToolboxWsChannel::Log].clone();
        log.query_pairs_mut()
            .append_pair("deviceName", "vcp-agent-rust");
        assert_eq!(
            log.as_str(),
            "ws://localhost:6005/VCPlog/VCP_Key=a%20b?deviceName=vcp-agent-rust"
        );
    }

    #[test]
    fn websocket_candidates_preserve_legacy_fallback_query_and_redaction() {
        let connection =
            ToolboxConnection::new("https://toolbox.example.test/prefix", "a b").unwrap();
        let candidates = websocket_endpoint_candidates(&connection, ToolboxWsChannel::Log).unwrap();
        assert_eq!(candidates.len(), 3);
        assert_eq!(
            candidates[0].as_str(),
            "wss://toolbox.example.test/VCPlog/VCP_Key=a%20b"
        );
        assert_eq!(
            candidates[1].as_str(),
            "wss://toolbox.example.test/vcpinfo/VCP_Key=a%20b"
        );
        assert_eq!(
            candidates[2].as_str(),
            "wss://toolbox.example.test/?channel=log&key=a+b"
        );
        assert!(!redact_websocket_endpoint(&candidates[0]).contains("a%20b"));
        assert!(!redact_websocket_endpoint(&candidates[2]).contains("key="));

        let explicit = ToolboxConnection::new(
            "https://toolbox.example.test/vcpinfo/VCP_Key=already-there",
            "ignored",
        )
        .unwrap();
        let explicit_candidates =
            websocket_endpoint_candidates(&explicit, ToolboxWsChannel::Info).unwrap();
        assert_eq!(explicit_candidates.len(), 1);
        assert_eq!(
            explicit_candidates[0].as_str(),
            "wss://toolbox.example.test/vcpinfo/VCP_Key=already-there"
        );
    }

    #[tokio::test]
    async fn websocket_observer_falls_back_and_reports_redacted_latency_status() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind websocket fallback fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.expect("accept primary candidate");
            let mut request = vec![0_u8; 4096];
            let count = first
                .read(&mut request)
                .await
                .expect("read primary handshake");
            let request = String::from_utf8_lossy(&request[..count]);
            assert!(request.starts_with("GET /VCPlog/VCP_Key=fixture-key HTTP/1.1"));
            first
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("reject primary endpoint");

            let (stream, _) = listener.accept().await.expect("accept fallback candidate");
            let mut socket = accept_async(stream)
                .await
                .expect("upgrade fallback endpoint");
            socket.close(None).await.expect("close fallback websocket");
        });
        let endpoint = format!("http://{address}");
        let host =
            DirectToolboxHost::new(ToolboxConnection::new(&endpoint, "fixture-key").unwrap())
                .unwrap();
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let observed_statuses = Arc::clone(&statuses);
        let result = timeout(
            Duration::from_secs(2),
            host.observe_websocket_with_status(
                ToolboxWsChannel::Log,
                move |status| observed_statuses.lock().unwrap().push(status),
                |_| {},
            ),
        )
        .await
        .expect("fallback observer timed out");
        assert!(
            result.is_ok(),
            "fallback observer must end cleanly: {result:?}"
        );
        server.await.expect("fallback server task");
        let statuses = statuses.lock().unwrap();
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].channel, ToolboxWsChannel::Log);
        assert!(statuses[0].endpoint.contains("/vcpinfo/VCP_Key=[redacted]"));
        assert!(!statuses[0].endpoint.contains("fixture-key"));
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
    fn structured_tool_resources_are_preserved_without_replacing_text_output() {
        let result = normalize_human_tool_result(
            json!({
                "content": "done",
                "resources": [{"type":"image","url":"https://example.invalid/a.png"}],
                "warnings": ["preview only"],
                "task": {"status":"accepted","id":"task-1"}
            }),
            200,
        );
        assert_eq!(result.output, "done");
        assert_eq!(result.resources[0]["type"], "image");
        assert_eq!(result.warnings[0], "preview only");
        assert_eq!(result.task.as_ref().unwrap()["status"], "accepted");
    }

    #[tokio::test]
    async fn interrupt_uses_the_exact_request_id_and_reports_backend_acceptance() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind interrupt fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept interrupt request");
            let mut request = vec![0_u8; 4096];
            let read = socket
                .read(&mut request)
                .await
                .expect("read interrupt request");
            request.truncate(read);
            let request = String::from_utf8(request).expect("HTTP request is UTF-8");
            assert!(request.starts_with("POST /v1/interrupt HTTP/1.1"));
            assert!(
                request.contains(r#"{"requestId":"model-request-exact"}"#),
                "interrupt body must carry the exact model request identity: {request}"
            );
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"status\":\"success\"}",
                )
                .await
                .expect("write interrupt response");
        });
        let endpoint = format!("http://{address}");
        let host = DirectToolboxHost::new(
            ToolboxConnection::new(&endpoint, "fixture-key").expect("fixture connection"),
        )
        .expect("fixture client");

        assert!(host.interrupt("model-request-exact").await.unwrap());
        server.await.expect("fixture server task");
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

    #[tokio::test]
    async fn vcp_log_round_trip_keeps_backend_approval_on_the_narrow_channel() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept websocket");
            let mut socket = accept_async(stream).await.expect("upgrade websocket");
            socket
                .send(Message::Text(
                    json!({
                        "type": "tool_approval_request",
                        "data": {
                            "requestId": "toolbox-approval-1",
                            "toolName": "PowerShellExecutor",
                            "approvalTtlMs": 30_000
                        }
                    })
                    .to_string(),
                ))
                .await
                .expect("send backend approval request");
            let response = timeout(Duration::from_secs(2), socket.next())
                .await
                .expect("backend approval response timeout")
                .expect("socket did not close before response")
                .expect("receive backend approval response");
            let Message::Text(response) = response else {
                panic!("backend approval response must be text");
            };
            let response =
                serde_json::from_str::<Value>(&response).expect("valid backend approval json");
            socket.close(None).await.expect("close websocket fixture");
            response
        });

        let endpoint = format!("http://{address}");
        let host = DirectToolboxHost::new(
            ToolboxConnection::new(&endpoint, "fixture-key").expect("fixture connection"),
        )
        .expect("fixture client");
        let (response_tx, mut response_rx) = mpsc::channel(1);
        let (completion_tx, completion_rx) = tokio::sync::oneshot::channel();
        let mut completion_tx = Some(completion_tx);
        let observed = Arc::new(AtomicBool::new(false));
        let callback_observed = Arc::clone(&observed);
        let client = tokio::spawn(async move {
            host.run_log_websocket("vcp-agent-rust-test", &mut response_rx, move |event| {
                if let ToolboxWsEvent::BackendApprovalRequest(value) = event {
                    callback_observed.store(true, Ordering::SeqCst);
                    let request_id = value
                        .pointer("/data/requestId")
                        .and_then(Value::as_str)
                        .expect("request id in fixture")
                        .to_string();
                    response_tx
                        .try_send(ToolboxApprovalResponse {
                            request_id,
                            approved: false,
                            reason: Some("fixture deny".to_string()),
                            completion: completion_tx.take(),
                        })
                        .expect("queue narrow approval response");
                } else {
                    panic!("backend approval must not be projected as a log event");
                }
            })
            .await
        });

        let response = server.await.expect("fixture server task");
        let result = timeout(Duration::from_secs(2), client)
            .await
            .expect("client close timeout")
            .expect("client task");
        assert!(
            result.is_ok(),
            "log websocket should end cleanly: {result:?}"
        );
        assert!(observed.load(Ordering::SeqCst));
        assert_eq!(
            response.pointer("/type").and_then(Value::as_str),
            Some("tool_approval_response")
        );
        assert_eq!(
            response.pointer("/data/requestId").and_then(Value::as_str),
            Some("toolbox-approval-1")
        );
        assert_eq!(
            response.pointer("/data/approved").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            response.pointer("/data/reason").and_then(Value::as_str),
            Some("fixture deny")
        );
        assert_eq!(completion_rx.await.expect("completion signal"), Ok(()));
    }

    #[tokio::test]
    async fn oversized_websocket_message_fails_closed_before_projection() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local websocket fixture");
        let address = listener.local_addr().expect("fixture address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept websocket");
            let mut socket = accept_async(stream).await.expect("upgrade websocket");
            socket
                .send(Message::Text("x".repeat(MAX_WS_MESSAGE_BYTES + 1)))
                .await
                .expect("send oversized websocket message");
        });
        let endpoint = format!("http://{address}");
        let host = DirectToolboxHost::new(
            ToolboxConnection::new(&endpoint, "fixture-key").expect("fixture connection"),
        )
        .expect("fixture client");
        let projected = Arc::new(AtomicBool::new(false));
        let callback_projected = Arc::clone(&projected);
        let result = timeout(
            Duration::from_secs(2),
            host.observe_websocket(ToolboxWsChannel::Info, move |_| {
                callback_projected.store(true, Ordering::SeqCst);
            }),
        )
        .await
        .expect("client must reject oversized websocket message promptly");
        server.await.expect("fixture server task");
        assert!(matches!(result, Err(ToolboxHostError::WebSocket(_))));
        assert!(
            !projected.load(Ordering::SeqCst),
            "oversized WS payload must never reach a UI projection"
        );
    }
}
