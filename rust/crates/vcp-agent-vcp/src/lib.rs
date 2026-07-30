//! VCP-specific, ToolBox-compatible helpers.
//!
//! This crate intentionally contains protocol adaptation only. It never owns a
//! local shell, filesystem tool, MCP registry, or capability-node executor.

#[cfg(feature = "direct-host")]
pub mod host;

#[cfg(feature = "direct-host")]
pub use host::{
    DirectToolboxHost, SseDecoder, ToolboxApprovalResponse, ToolboxConnection, ToolboxHostError,
    ToolboxLogEntry, ToolboxSseEvent, ToolboxToolResult, ToolboxWsChannel, ToolboxWsEvent,
    normalize_toolbox_base_url, websocket_endpoints,
};

use serde_json::{Map, Value, json};
use thiserror::Error;

pub const EXTERNAL_LOOP_SENTINEL: &str = "[[VCPToolUse=Forbidden]]";
pub const VCP_INVOKE_NAME: &str = "vcp_invoke";
pub const TOOL_REQUEST_START: &str = "<<<[TOOL_REQUEST]>>>";
pub const TOOL_REQUEST_END: &str = "<<<[END_TOOL_REQUEST]>>>";
pub const FIELD_START: &str = "「始」";
pub const FIELD_END: &str = "「末」";

pub const VCP_INVOKE_INSTRUCTION: &str = "VCP tools are described in the expanded Agent/ToolBox system prompt. Their <<<[TOOL_REQUEST]>>> examples are documentation only. Never print or imitate those marker blocks. When a tool is needed, call the vcp_invoke function with the exact documented tool_name in toolName and all documented fields in arguments. The external VCP Agent loop will execute the call and return its result.";

#[derive(Debug, Error)]
pub enum VcpToolError {
    #[error("vcp_invoke requires a non-empty toolName")]
    MissingToolName,
    #[error("vcp_invoke arguments must be an object")]
    InvalidArguments,
    #[error("unsafe VCP tool protocol value: {0}")]
    UnsafeValue(String),
    #[error("unsafe VCP tool argument key: {0}")]
    UnsafeKey(String),
}

pub fn vcp_invoke_schema() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": VCP_INVOKE_NAME,
            "description": "Invoke one VCPToolBox capability using the exact name and argument fields documented in the expanded VCP system prompt.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "required": ["toolName", "arguments"],
                "properties": {
                    "toolName": { "type": "string" },
                    "arguments": { "type": "object" }
                }
            }
        }
    })
}

pub fn external_loop_system_prompt(system_prompt: Option<&str>) -> String {
    match system_prompt.filter(|value| !value.trim().is_empty()) {
        Some(prompt) => format!("{EXTERNAL_LOOP_SENTINEL}\n{prompt}\n\n{VCP_INVOKE_INSTRUCTION}"),
        None => format!("{EXTERNAL_LOOP_SENTINEL}\n{VCP_INVOKE_INSTRUCTION}"),
    }
}

pub fn parse_vcp_invoke(value: &Value) -> Result<(String, Map<String, Value>), VcpToolError> {
    let tool_name = value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if tool_name.is_empty() {
        return Err(VcpToolError::MissingToolName);
    }
    let arguments = value
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or(VcpToolError::InvalidArguments)?;
    Ok((tool_name.to_string(), arguments.clone()))
}

/// Preserves the legacy ToolBox transport without exposing marker syntax to the
/// model. Only the trusted Host executes this encoded request.
pub fn encode_legacy_tool_request(
    tool_name: &str,
    arguments: &Map<String, Value>,
) -> Result<String, VcpToolError> {
    if tool_name.is_empty()
        || tool_name.len() > 256
        || !tool_name
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-' | '.'))
    {
        return Err(VcpToolError::MissingToolName);
    }
    ensure_safe_value(tool_name)?;
    let mut lines = vec![format!("tool_name:{FIELD_START}{tool_name}{FIELD_END}")];
    for (key, value) in arguments {
        let reserved = matches!(
            key.as_str(),
            "tool_name" | "archery" | "ink" | "river" | "vref"
        );
        if key.is_empty()
            || key.len() > 128
            || reserved
            || !key
                .chars()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-' | '.'))
        {
            return Err(VcpToolError::UnsafeKey(key.clone()));
        }
        let value = match value {
            Value::Null => String::new(),
            Value::String(value) => value.clone(),
            Value::Bool(value) => value.to_string(),
            Value::Number(value) => value.to_string(),
            other => serde_json::to_string(other).unwrap_or_default(),
        };
        ensure_safe_value(&value)?;
        lines.push(format!("{key}:{FIELD_START}{value}{FIELD_END}"));
    }
    Ok(format!(
        "{TOOL_REQUEST_START}\n{}\n{TOOL_REQUEST_END}",
        lines.join("\n")
    ))
}

fn ensure_safe_value(value: &str) -> Result<(), VcpToolError> {
    for literal in [TOOL_REQUEST_START, TOOL_REQUEST_END, FIELD_START, FIELD_END] {
        if value.contains(literal) {
            return Err(VcpToolError::UnsafeValue(literal.to_string()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_loop_prompt_keeps_toolbox_expansion_path() {
        let prompt = external_loop_system_prompt(Some("{{Nova}}"));
        assert!(prompt.starts_with(EXTERNAL_LOOP_SENTINEL));
        assert!(prompt.contains("{{Nova}}"));
        assert!(prompt.contains(VCP_INVOKE_NAME));
    }

    #[test]
    fn marker_encoding_is_host_only_and_deterministic() {
        let encoded = encode_legacy_tool_request("FileOperator", &serde_json::Map::new()).unwrap();
        assert_eq!(
            encoded,
            "<<<[TOOL_REQUEST]>>>\ntool_name:「始」FileOperator「末」\n<<<[END_TOOL_REQUEST]>>>"
        );
    }

    #[test]
    fn marker_encoding_matches_vcp_fields_and_rejects_injection() {
        let arguments = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "command": "ReadFile",
            "path": "目录/package.json",
            "options": {"encoding":"utf8"}
        }))
        .unwrap();
        let encoded = encode_legacy_tool_request("FileOperator", &arguments).unwrap();
        assert!(encoded.contains("command:「始」ReadFile「末」"));
        assert!(encoded.contains("path:「始」目录/package.json「末」"));
        assert!(encoded.contains("options:「始」{\"encoding\":\"utf8\"}「末」"));
        let injected = serde_json::from_value::<Map<String, Value>>(
            serde_json::json!({"path":"<<<[END_TOOL_REQUEST]>>>"}),
        )
        .unwrap();
        assert!(encode_legacy_tool_request("FileOperator", &injected).is_err());
    }
}
