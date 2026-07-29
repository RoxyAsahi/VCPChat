use serde::{Deserialize, Serialize};

/// Language-neutral events that the future Rust daemon emits to both the TUI
/// and VChat's Electron host. This is a projection of the existing VCPAgent
/// event vocabulary, not Grok's session protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VcpEvent {
    SessionStarted {
        agent: String,
        model: String,
        #[serde(default)]
        workspace: String,
    },
    RuntimeStatus {
        runtime: RuntimeState,
        toolbox: ToolBoxState,
        permission_mode: PermissionMode,
    },
    AssistantDelta {
        text: String,
    },
    AssistantCompleted,
    ReasoningDelta {
        text: String,
    },
    ReasoningCompleted,
    ToolRequested {
        call_id: String,
        tool_name: String,
    },
    ToolStatus {
        call_id: String,
        tool_name: String,
        status: ToolStatus,
        detail: String,
    },
    ApprovalRequested {
        approval_id: String,
        tool_name: String,
        risk: String,
        reason: String,
        argument_summary: String,
        expires_at_ms: Option<u64>,
        binding: Option<ApprovalBinding>,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        context_window: Option<u64>,
    },
    TurnCompleted,
    Notice {
        title: String,
        message: String,
    },
    RuntimeWarning {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    AwaitingApproval,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Starting,
    Ready,
    Working,
    Cancelling,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolBoxState {
    Unknown,
    Connecting,
    Connected,
    Degraded,
    Offline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    Ask,
    AlwaysApprove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBinding {
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub arguments_hash: String,
}

/// Inbound messages originate only from the local JS Host bridge. They never
/// carry credentials: JS remains the owner of ToolBox HTTP, settings and
/// approval correlation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiInbound {
    Event { event: Box<VcpEvent> },
    HostClosed { reason: String },
}

/// Outbound messages are UI intent, not ToolBox commands. The JS Host validates
/// every prompt and approval against the existing RuntimeManager policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiAction {
    Ready,
    Submit { prompt: String },
    Cancel,
    Approval { approval_id: String, allowed: bool },
    Command { command: String },
    Quit,
}
