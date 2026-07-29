//! VCP-specific event projection above a deliberately narrow Grok Build UI base.
//!
//! This crate does not import Grok's agent, shell, tool, MCP, session, or
//! authentication crates. It consumes VCP's language-neutral event model and
//! renders it using the vendored textarea primitive.

pub mod app;
pub mod bridge;
mod clipboard;
mod markdown;
pub mod protocol;
pub mod theme;

pub use app::{App, ChoiceItem, InputAction, MessageBlock, MessageKind};
pub use bridge::HostBridge;
pub use protocol::{
    ApprovalBinding, InteractionItem, PermissionMode, RuntimeState, ToolBoxState, ToolStatus,
    UiAction, UiInbound, VcpEvent,
};
pub use theme::ThemeId;
