use std::io::{self, Write, stdout};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crossterm::{
    ExecutableCommand,
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event,
    },
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use serde_json::Value;
use vcp_agent_host::{
    BudgetLimits, HostCommand, HostEvent, RunningHost, RuntimeOverrides, TuiSettingsUpdate,
    default_settings_path, load_config, start, update_shared_settings,
};
use vcp_agent_tui::{
    App, ApprovalBinding, ChoiceItem, HostBridge, InputAction, InteractionItem, ToolStatus,
    UiAction, UiInbound, VcpEvent,
};

static TUI_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn tui_request_id() -> String {
    format!(
        "tui_{}_{}",
        std::process::id(),
        TUI_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[tokio::main]
async fn main() -> io::Result<()> {
    vcp_grok_crash_handler::install_terminal_restore_only();
    let mut options = parse_options();
    if options.help {
        print_help();
        return Ok(());
    }
    if options.version {
        println!("vcp-agent 0.1.0");
        return Ok(());
    }
    if options.open_settings {
        run_settings_wizard(&options.overrides)?;
        options.open_settings = false;
    }
    loop {
        let use_alternate_screen = options.use_alternate_screen;
        let mut terminal = TerminalSession::enter(use_alternate_screen)?;
        #[cfg(debug_assertions)]
        if std::env::var_os("VCP_AGENT_TUI_TEST_PANIC_AFTER_INIT").is_some() {
            panic!("VCPAgent PTY crash-cleanup fixture");
        }
        let outcome = run(terminal.terminal_mut(), options.clone()).await;
        terminal.restore()?;
        let outcome = outcome?;
        if outcome == RunOutcome::OpenSettings {
            run_settings_wizard(&options.overrides)?;
            continue;
        }
        return Ok(());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunOutcome {
    Quit,
    OpenSettings,
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
    use_alternate_screen: bool,
    restored: bool,
}

impl TerminalSession {
    fn enter(use_alternate_screen: bool) -> io::Result<Self> {
        enable_raw_mode()?;
        let mut output = stdout();
        if use_alternate_screen {
            output.execute(EnterAlternateScreen)?;
        }
        output.execute(EnableMouseCapture)?;
        output.execute(EnableBracketedPaste)?;
        vcp_grok_crash_handler::enable_terminal_escape_restore();
        let terminal = Terminal::new(CrosstermBackend::new(output))?;
        Ok(Self {
            terminal,
            use_alternate_screen,
            restored: false,
        })
    }

    fn terminal_mut(&mut self) -> &mut Terminal<CrosstermBackend<std::io::Stdout>> {
        &mut self.terminal
    }

    fn restore(&mut self) -> io::Result<()> {
        if self.restored {
            return Ok(());
        }
        vcp_grok_crash_handler::disable_terminal_escape_restore();
        disable_raw_mode()?;
        self.terminal.backend_mut().execute(DisableBracketedPaste)?;
        self.terminal.backend_mut().execute(DisableMouseCapture)?;
        if self.use_alternate_screen {
            self.terminal.backend_mut().execute(LeaveAlternateScreen)?;
        }
        self.terminal.show_cursor()?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if self.restore().is_err() {
            let _ = std::io::stderr().write_all(vcp_grok_crash_handler::RESTORE_SEQ);
        }
    }
}

enum Runtime {
    Native {
        host: RunningHost,
        overrides: Box<RuntimeOverrides>,
    },
    Bridge(HostBridge),
    Unavailable,
}

async fn run(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    options: Options,
) -> io::Result<RunOutcome> {
    let mut app = App::new();
    let mut runtime = if let Some(pipe) = options.bridge_path.clone() {
        Runtime::Bridge(HostBridge::connect(pipe)?)
    } else {
        match load_config(options.overrides.clone()).and_then(start) {
            Ok(host) => Runtime::Native {
                host,
                overrides: Box::new(options.overrides.clone()),
            },
            Err(error) => {
                app.set_runtime_unavailable(error.to_string());
                Runtime::Unavailable
            }
        }
    };
    let mut last_tick = Instant::now();
    loop {
        drain_runtime(&mut runtime, &mut app);
        if last_tick.elapsed() >= Duration::from_millis(500) {
            if let Some(action) = app.handle_tick() {
                dispatch_action(&mut app, &mut runtime, action);
            }
            last_tick = Instant::now();
        }
        terminal.draw(|frame| app.draw(frame))?;
        if !event::poll(Duration::from_millis(50))? {
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == event::KeyEventKind::Press => {
                let action = app.handle_key(key);
                if matches!(action, InputAction::Quit) {
                    shutdown(&mut runtime);
                    return Ok(RunOutcome::Quit);
                }
                if matches!(action, InputAction::OpenSettings) {
                    shutdown(&mut runtime);
                    return Ok(RunOutcome::OpenSettings);
                }
                dispatch_action(&mut app, &mut runtime, action);
            }
            Event::Mouse(mouse) => app.handle_mouse(mouse),
            Event::Paste(text) => app.handle_paste(&text),
            _ => {}
        }
    }
}

fn drain_runtime(runtime: &mut Runtime, app: &mut App) {
    match runtime {
        Runtime::Native { host, .. } => {
            while let Ok(event) = host.events.try_recv() {
                apply_host_event(app, event);
            }
        }
        Runtime::Bridge(bridge) => {
            while let Some(inbound) = bridge.try_recv() {
                match inbound {
                    UiInbound::Event { event } => app.apply_event(*event),
                    UiInbound::HostClosed { reason } => {
                        app.apply_event(VcpEvent::RuntimeWarning { message: reason })
                    }
                }
            }
        }
        Runtime::Unavailable => {}
    }
}

fn apply_host_event(app: &mut App, event: HostEvent) {
    match event {
        HostEvent::Warning(message) => app.apply_event(VcpEvent::RuntimeWarning { message }),
        HostEvent::ToolboxWs {
            channel,
            kind,
            payload,
        } => {
            if let Some(event) = toolbox_observation(channel, kind, payload) {
                app.apply_event(event);
            }
        }
        HostEvent::Approval(request) => app.apply_event(VcpEvent::ApprovalRequested {
            approval_id: request.approval_id,
            tool_name: request.tool_name,
            risk: request.risk,
            reason: request.reason,
            argument_summary: request.argument_summary,
            expires_at_ms: Some(request.expires_at_ms),
            binding: Some(ApprovalBinding {
                session_id: request.session_id,
                turn_id: request.turn_id,
                tool_call_id: request.tool_call_id,
                arguments_hash: request.arguments_hash,
            }),
        }),
        HostEvent::Control { kind, payload, .. } => match kind.as_str() {
            "models" => app.open_choice_picker(
                "model",
                "模型",
                choice_items(&payload, "id", "id", "contextWindow"),
            ),
            "agents" => app.open_choice_picker(
                "agent",
                "Agent",
                choice_items(&payload, "id", "name", "model"),
            ),
            "topics" => app.open_choice_picker(
                "topic",
                "Agent Topic",
                topic_choice_items(&payload),
            ),
            "interaction-queue" => app.apply_event(VcpEvent::InteractionQueue {
                items: interaction_items(&payload),
            }),
            "settings" => apply_settings_snapshot(app, &payload, false),
            "settings-updated" => apply_settings_snapshot(
                app,
                payload.get("settings").unwrap_or(&payload),
                payload
                    .get("restartRequired")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            ),
            "topic-read-only" => app.apply_event(topic_snapshot_event(&payload)),
            "topic-renamed" => app.apply_event(VcpEvent::Notice {
                title: "Topic 已重命名".into(),
                message: format!(
                    "{} → {}",
                    payload
                        .get("topicId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    payload
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名")
                ),
            }),
            "topic-deleted" => app.apply_event(VcpEvent::Notice {
                title: "Topic 已删除".into(),
                message: payload
                    .get("topicId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            }),
            "topic-takeover-pending" => app.apply_event(VcpEvent::Notice {
                title: "Topic 接管".into(),
                message: format!(
                    "已请求 {} 的协作式接管；旧持有者必须先取消 Turn、保存 checkpoint 并释放 lease。",
                    payload
                        .get("topicId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ),
            }),
            "control-error" => app.apply_event(VcpEvent::RuntimeWarning {
                message: payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("控制命令失败")
                    .to_string(),
            }),
            _ => app.apply_event(VcpEvent::Notice {
                title: kind,
                message: serde_json::to_string_pretty(&payload)
                    .unwrap_or_else(|_| payload.to_string()),
            }),
        },
        HostEvent::Wire(message) if message.kind == "host-ready" => {
            app.apply_theme_name(message.string("theme").unwrap_or("Auto"));
            app.apply_event(VcpEvent::SessionStarted {
                agent: message.string("agent").unwrap_or("Nova").to_string(),
                model: message.string("model").unwrap_or("").to_string(),
                workspace: message.string("workspace").unwrap_or(".").to_string(),
            })
        }
        HostEvent::Wire(message) if message.kind == "event" => {
            apply_core_event(app, message.value("event").unwrap_or(&Value::Null))
        }
        HostEvent::Wire(message) if message.kind == "ack" => {
            let result = message.value("result").unwrap_or(&Value::Null);
            if result.get("cancelled").and_then(Value::as_bool) == Some(true) {
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: "任务已取消".into(),
                });
            }
            if let Some(error) = result.get("error").and_then(Value::as_str) {
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: error.into(),
                });
            }
        }
        _ => {}
    }
}

fn interaction_items(value: &Value) -> Vec<InteractionItem> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(InteractionItem {
                interaction_id: item.get("interactionId")?.as_str()?.to_string(),
                kind: item
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("follow-up")
                    .to_string(),
                prompt: item
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                consumed: item
                    .get("consumed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn budget_event(value: &Value, restart_required: bool) -> VcpEvent {
    let budget = value.get("budget").unwrap_or(value);
    VcpEvent::Budget {
        max_requests_per_turn: budget.get("maxRequestsPerTurn").and_then(Value::as_u64),
        max_tokens_per_turn: budget.get("maxTokensPerTurn").and_then(Value::as_u64),
        restart_required,
    }
}

fn apply_settings_snapshot(app: &mut App, value: &Value, restart_required: bool) {
    app.apply_event(VcpEvent::SettingsSummary {
        default_model: value
            .get("defaultModel")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        default_agent: value
            .get("defaultAgentId")
            .and_then(Value::as_str)
            .unwrap_or("Nova")
            .to_string(),
        theme: value
            .get("theme")
            .and_then(Value::as_str)
            .unwrap_or("Auto")
            .to_string(),
        permission_mode: value
            .get("permissionMode")
            .and_then(Value::as_str)
            .unwrap_or("ask")
            .to_string(),
        restart_required,
    });
    app.apply_event(budget_event(value, restart_required));
}

fn topic_snapshot_event(value: &Value) -> VcpEvent {
    let state = value.get("state").unwrap_or(&Value::Null);
    let history = value
        .get("history")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let preview = history
        .iter()
        .rev()
        .find_map(|entry| {
            entry
                .get("content")
                .and_then(Value::as_str)
                .or_else(|| entry.get("text").and_then(Value::as_str))
        })
        .unwrap_or("没有可显示的文本预览");
    VcpEvent::TopicSnapshot {
        topic_id: value
            .get("topicId")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        history_entries: history.len(),
        state: state
            .get("status")
            .and_then(Value::as_str)
            .or_else(|| state.get("turnStatus").and_then(Value::as_str))
            .unwrap_or("checkpoint available")
            .to_string(),
        preview: preview.chars().take(600).collect(),
    }
}

fn toolbox_observation(channel: String, kind: String, payload: Value) -> Option<VcpEvent> {
    if kind == "backend-approval-request" {
        let tool = payload
            .get("toolName")
            .or_else(|| payload.get("tool"))
            .and_then(Value::as_str)
            .unwrap_or("VCPToolBox tool");
        return Some(VcpEvent::ToolboxObservation {
            channel,
            kind,
            title: "等待 ToolBox 后端审批".into(),
            detail: format!(
                "{tool} 正在等待 ToolBox 自己的审批结果。客户端 always-approve/yolo 不会绕过此阶段。"
            ),
        });
    }

    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(kind.as_str())
        .to_string();
    if matches!(
        event_type.as_str(),
        "connection_ack" | "META_THINKING_CHAIN"
    ) {
        return None;
    }
    let raw = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    let (title, summary) = if event_type == "RAG_RETRIEVAL_DETAILS" {
        rag_retrieval_summary(&payload)
    } else {
        let title = payload
            .get("source")
            .or_else(|| payload.get("title"))
            .or_else(|| payload.get("requestId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| friendly_toolbox_event_name(&event_type));
        let summary = [
            "message",
            "query",
            "response",
            "extractedMemories",
            "narrative",
            "error",
        ]
        .into_iter()
        .find_map(|field| payload.get(field).and_then(Value::as_str))
        .map(|value| truncate_chars(value.trim(), 280))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("收到 {event_type} 结构化事件"));
        (title, summary)
    };
    let detail = if raw.trim() == summary.trim() {
        summary
    } else {
        format!("{summary}\n\n原始元数据\n{raw}")
    };
    Some(VcpEvent::ToolboxObservation {
        channel,
        kind: event_type,
        title,
        detail,
    })
}

fn rag_retrieval_summary(payload: &Value) -> (String, String) {
    let database = payload
        .get("dbName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Unknown");
    let result_count = payload
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let query = payload
        .get("query")
        .and_then(Value::as_str)
        .map(|value| truncate_chars(value.trim(), 280))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "未提供查询文本".into());
    let mut strategies = Vec::new();
    if payload.get("fromCache").and_then(Value::as_bool) == Some(true) {
        strategies.push("缓存命中".to_string());
    }
    if payload.get("useTime").and_then(Value::as_bool) == Some(true) {
        strategies.push("时间召回".to_string());
    }
    if payload.get("useGroup").and_then(Value::as_bool) == Some(true) {
        strategies.push("分组".to_string());
    }
    if payload.get("useBM25").and_then(Value::as_bool) == Some(true) {
        strategies.push("BM25".to_string());
    }
    if payload.get("useTagMemo").and_then(Value::as_bool) == Some(true) {
        let weight = payload
            .get("tagWeight")
            .and_then(Value::as_f64)
            .map(|value| format!(" {value:.2}"))
            .unwrap_or_default();
        strategies.push(format!("标签增强{weight}"));
    }
    if payload.get("useGeodesicRerank").and_then(Value::as_bool) == Some(true) {
        strategies.push("GeoReRank".to_string());
    }
    if payload.get("useRerank").and_then(Value::as_bool) == Some(true) {
        strategies.push("ReRank".to_string());
    }
    let strategy_line = if strategies.is_empty() {
        "默认向量检索".to_string()
    } else {
        strategies.join(" · ")
    };
    let iteration = payload
        .get("iteration")
        .and_then(Value::as_u64)
        .map(|value| format!(" · 第 {value} 轮"))
        .unwrap_or_default();
    (
        format!("RAG 检索 · {database} · {result_count} 条命中"),
        format!("查询：{query}\n策略：{strategy_line}{iteration}"),
    )
}

fn friendly_toolbox_event_name(event_type: &str) -> String {
    match event_type {
        "META_THINKING_CHAIN" => "元思考链".into(),
        "AGENT_PRIVATE_CHAT_PREVIEW" => "Agent 私聊预览".into(),
        "AI_MEMO_RETRIEVAL" => "记忆检索".into(),
        "DailyNote" => "日记召回".into(),
        value if value.starts_with("AGENT_DREAM_") => "Agent 梦境".into(),
        "notification" => "ToolBox 通知".into(),
        other => other.to_string(),
    }
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let head: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn apply_core_event(app: &mut App, event: &Value) {
    let payload = event.get("payload").unwrap_or(&Value::Null);
    match event.get("type").and_then(Value::as_str) {
        Some("runtime.ready") => {
            app.apply_theme_name(
                payload
                    .get("theme")
                    .and_then(Value::as_str)
                    .unwrap_or("Auto"),
            );
            app.apply_event(VcpEvent::SessionStarted {
                agent: payload
                    .get("agent")
                    .and_then(Value::as_str)
                    .unwrap_or("Nova")
                    .to_string(),
                model: payload
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                workspace: payload
                    .get("workspace")
                    .and_then(Value::as_str)
                    .unwrap_or(".")
                    .to_string(),
            });
            app.set_context_window(payload.get("contextWindow").and_then(Value::as_u64));
        }
        Some("assistant.delta") => app.apply_event(VcpEvent::AssistantDelta {
            text: payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        Some("assistant.completed") => {
            app.apply_event(VcpEvent::AssistantCompleted);
            if let Some(usage) = payload.get("usage") {
                apply_usage(app, usage);
            }
        }
        Some("turn.completed") => {
            if let Some(usage) = payload.get("usage") {
                apply_usage(app, usage);
            }
            app.apply_event(VcpEvent::TurnCompleted);
        }
        Some("reasoning.delta") => app.apply_event(VcpEvent::ReasoningDelta {
            text: payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        Some("reasoning.completed") => app.apply_event(VcpEvent::ReasoningCompleted),
        Some("tool.requested") => app.apply_event(VcpEvent::ToolRequested {
            call_id: event
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string(),
            tool_name: payload
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("vcp_invoke")
                .to_string(),
        }),
        Some("tool.awaiting_local_approval") => {
            apply_tool_status(app, event, payload, ToolStatus::AwaitingApproval)
        }
        Some("tool.running") => apply_tool_status(app, event, payload, ToolStatus::Running),
        Some("tool.completed") => apply_tool_status(app, event, payload, ToolStatus::Completed),
        Some("tool.failed") => apply_tool_status(app, event, payload, ToolStatus::Failed),
        Some("context.compaction.started") => app.apply_event(VcpEvent::Notice {
            title: "Context".into(),
            message: "正在安全压缩上下文…".into(),
        }),
        Some("context.compaction.completed") => app.apply_event(VcpEvent::Notice {
            title: "Context".into(),
            message: "上下文压缩完成".into(),
        }),
        Some("context.compaction.failed") => app.apply_event(VcpEvent::RuntimeWarning {
            message: payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("上下文压缩失败")
                .to_string(),
        }),
        _ => {}
    }
}

fn choice_items(value: &Value, id_key: &str, label_key: &str, detail_key: &str) -> Vec<ChoiceItem> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get(id_key)?.as_str()?.to_string();
            Some(ChoiceItem {
                label: item
                    .get(label_key)
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                detail: item
                    .get(detail_key)
                    .map(|value| {
                        value
                            .as_str()
                            .map(ToOwned::to_owned)
                            .unwrap_or_else(|| value.to_string())
                    })
                    .unwrap_or_default(),
                id,
            })
        })
        .collect()
}

fn topic_choice_items(value: &Value) -> Vec<ChoiceItem> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let state = if item.get("inUse").and_then(Value::as_bool) == Some(true) {
                "in use"
            } else if item.get("readOnly").and_then(Value::as_bool) == Some(true) {
                "read only"
            } else {
                "available"
            };
            Some(ChoiceItem {
                label: item
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                detail: format!(
                    "{} · {} · {}",
                    item.get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown model"),
                    state,
                    item.get("workspaceRef")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown workspace")
                ),
                id,
            })
        })
        .collect()
}

fn apply_tool_status(app: &mut App, event: &Value, payload: &Value, status: ToolStatus) {
    app.apply_event(VcpEvent::ToolStatus {
        call_id: event
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string(),
        tool_name: payload
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("vcp_invoke")
            .to_string(),
        status,
        detail: payload
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    });
}

fn apply_usage(app: &mut App, usage: &Value) {
    let input = usage
        .get("input")
        .or_else(|| usage.get("prompt_tokens"))
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("output")
        .or_else(|| usage.get("completion_tokens"))
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    app.apply_event(VcpEvent::Usage {
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: usage.get("reasoning").and_then(Value::as_u64).unwrap_or(0),
        cache_read_tokens: usage
            .get("cacheRead")
            .or_else(|| usage.get("cache_read"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_write_tokens: usage
            .get("cacheWrite")
            .or_else(|| usage.get("cache_write"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        total_tokens: usage
            .get("totalTokens")
            .or_else(|| usage.get("total_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(input + output),
        requests: usage.get("requests").and_then(Value::as_u64).unwrap_or(0),
        context_window: usage.get("contextWindow").and_then(Value::as_u64),
        estimated: usage
            .get("estimated")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        source: usage
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("estimated")
            .to_string(),
    });
}

fn dispatch_action(app: &mut App, runtime: &mut Runtime, action: InputAction) {
    match action {
        InputAction::None | InputAction::Clear | InputAction::OpenSettings => {}
        InputAction::ThemeChanged(theme) => send(
            runtime,
            HostCommand::UpdateSettings {
                request_id: tui_request_id(),
                update: TuiSettingsUpdate {
                    theme: Some(theme.name().to_string()),
                    ..TuiSettingsUpdate::default()
                },
            },
        ),
        InputAction::Demo => app.load_demo(),
        InputAction::Submit(prompt) => send(
            runtime,
            HostCommand::StartTurn {
                prompt,
                turn_id: None,
            },
        ),
        InputAction::Cancel => send(runtime, HostCommand::Cancel),
        InputAction::Approval {
            approval_id,
            allowed,
            binding,
        } => send(
            runtime,
            HostCommand::Approval {
                approval_id,
                allowed,
                binding: binding.map(|value| {
                    (
                        value.session_id,
                        value.turn_id,
                        value.tool_call_id,
                        value.arguments_hash,
                    )
                }),
            },
        ),
        InputAction::Command(command) => dispatch_command(app, runtime, command),
        InputAction::Quit => shutdown(runtime),
    }
}

fn dispatch_command(app: &mut App, runtime: &mut Runtime, command: String) {
    let mut parts = command.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or("");
    let argument = parts.next().unwrap_or("").trim().to_string();
    match name {
        "/steer" if !argument.is_empty() => send(runtime, HostCommand::Steer { prompt: argument }),
        "/follow-up" if !argument.is_empty() => {
            send(runtime, HostCommand::FollowUp { prompt: argument })
        }
        "/model" if argument.is_empty() => send(
            runtime,
            HostCommand::ListModels {
                request_id: tui_request_id(),
            },
        ),
        "/model" => restart_native(runtime, app, |overrides| {
            overrides.model = Some(argument);
            overrides.resume = None;
        }),
        "/agent" if argument.is_empty() => send(
            runtime,
            HostCommand::ListAgents {
                request_id: tui_request_id(),
            },
        ),
        "/agent" => restart_native(runtime, app, |overrides| {
            overrides.agent = Some(argument);
            overrides.resume = None;
        }),
        "/topics" if argument.is_empty() => send(
            runtime,
            HostCommand::ListTopics {
                request_id: tui_request_id(),
                agent_id: None,
            },
        ),
        "/topics" if argument.starts_with("rename ") => {
            let rest = argument.trim_start_matches("rename ");
            if let Some((topic_id, title)) = rest.split_once(char::is_whitespace) {
                send(
                    runtime,
                    HostCommand::RenameTopic {
                        request_id: tui_request_id(),
                        topic_id: topic_id.into(),
                        title: title.trim().into(),
                        agent_id: None,
                    },
                );
            }
        }
        "/topics" if argument.starts_with("delete ") => {
            let rest = argument.trim_start_matches("delete ").trim();
            let topic_id = rest.strip_suffix(" --confirm").map(str::trim);
            if let Some(topic_id) = topic_id.filter(|value| !value.is_empty()) {
                send(
                    runtime,
                    HostCommand::DeleteTopic {
                        request_id: tui_request_id(),
                        topic_id: topic_id.into(),
                        agent_id: None,
                    },
                );
            } else {
                app.apply_event(VcpEvent::Notice {
                    title: "确认删除 Topic".into(),
                    message: format!(
                        "删除不会影响其他 Topic。确认后执行：/topics delete {rest} --confirm"
                    ),
                });
            }
        }
        "/topics" if argument.starts_with("read ") => send(
            runtime,
            HostCommand::ReadTopic {
                request_id: tui_request_id(),
                agent_id: None,
                topic_id: argument.trim_start_matches("read ").trim().into(),
            },
        ),
        "/topics" if argument.starts_with("takeover ") => send(
            runtime,
            HostCommand::RequestTopicTakeover {
                request_id: tui_request_id(),
                agent_id: None,
                topic_id: argument.trim_start_matches("takeover ").trim().into(),
                requester_id: format!("tui_{}", std::process::id()),
            },
        ),
        "/resume" if !argument.is_empty() => restart_native(runtime, app, |overrides| {
            overrides.resume = Some(argument);
        }),
        "/new" => restart_native(runtime, app, |overrides| overrides.resume = None),
        "/clear-queue" => send(
            runtime,
            HostCommand::ClearInteractionQueue {
                request_id: tui_request_id(),
            },
        ),
        "/queue" if argument == "clear" => send(
            runtime,
            HostCommand::ClearInteractionQueue {
                request_id: tui_request_id(),
            },
        ),
        "/compact" => send(runtime, HostCommand::Compact),
        "/permissions" if matches!(argument.as_str(), "ask" | "always-approve" | "yolo") => {
            let always = argument != "ask";
            send(
                runtime,
                HostCommand::UpdateSettings {
                    request_id: tui_request_id(),
                    update: TuiSettingsUpdate {
                        permission_mode: Some(if always { "always-approve" } else { "ask" }.into()),
                        ..TuiSettingsUpdate::default()
                    },
                },
            );
            restart_native(runtime, app, |overrides| overrides.always_approve = always);
        }
        "/settings" => send(
            runtime,
            HostCommand::GetSettings {
                request_id: tui_request_id(),
            },
        ),
        "/queue" if argument.is_empty() => send(
            runtime,
            HostCommand::ListInteractionQueue {
                request_id: tui_request_id(),
            },
        ),
        "/queue" if argument.starts_with("remove ") => {
            let interaction_id = argument.trim_start_matches("remove ").trim();
            if interaction_id.is_empty() {
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: "用法：/queue remove <interactionId>".into(),
                });
            } else {
                send(
                    runtime,
                    HostCommand::RemoveInteractionQueueItem {
                        request_id: tui_request_id(),
                        interaction_id: interaction_id.into(),
                    },
                );
            }
        }
        "/queue" if argument.starts_with("replace ") => {
            let rest = argument.trim_start_matches("replace ").trim();
            if let Some((interaction_id, prompt)) = rest.split_once(char::is_whitespace) {
                send(
                    runtime,
                    HostCommand::ReplaceInteractionQueueItem {
                        request_id: tui_request_id(),
                        interaction_id: interaction_id.into(),
                        prompt: prompt.trim().into(),
                    },
                );
            } else {
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: "用法：/queue replace <interactionId> <prompt>".into(),
                });
            }
        }
        "/budget" if !argument.is_empty() => {
            let mut budget = BudgetLimits::default();
            for item in argument.split_whitespace() {
                let Some((key, value)) = item.split_once('=') else {
                    continue;
                };
                let parsed = value.parse::<u64>().ok().filter(|value| *value > 0);
                match key {
                    "requests" => budget.max_requests_per_turn = parsed,
                    "tokens" => budget.max_tokens_per_turn = parsed,
                    _ => {}
                }
            }
            if budget.max_requests_per_turn.is_none() && budget.max_tokens_per_turn.is_none() {
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: "用法：/budget requests=<n> tokens=<n>；数值必须大于 0".into(),
                });
            } else {
                send(
                    runtime,
                    HostCommand::UpdateSettings {
                        request_id: tui_request_id(),
                        update: TuiSettingsUpdate {
                            budget: Some(budget),
                            ..TuiSettingsUpdate::default()
                        },
                    },
                );
            }
        }
        "/usage" => app.show_usage(),
        "/budget" => send(
            runtime,
            HostCommand::GetSettings {
                request_id: tui_request_id(),
            },
        ),
        "/reasoning" => app.toggle_reasoning_command(),
        "/toolbox" => app.toggle_toolbox_observation_command(),
        "/status" => app.show_runtime_status(),
        _ => app.apply_event(VcpEvent::RuntimeWarning {
            message: format!("未知或缺少参数的命令：{command}"),
        }),
    }
}

fn restart_native(
    runtime: &mut Runtime,
    app: &mut App,
    update: impl FnOnce(&mut RuntimeOverrides),
) {
    let Runtime::Native { host, overrides } = runtime else {
        app.apply_event(VcpEvent::RuntimeWarning {
            message: "当前 bridge/配置阻断模式不支持重建 Rust Session".into(),
        });
        return;
    };
    let _ = host.commands.send(HostCommand::Shutdown);
    update(overrides);
    match load_config((**overrides).clone()).and_then(start) {
        Ok(next) => {
            *host = next;
            app.apply_event(VcpEvent::Notice {
                title: "Session".into(),
                message: "已创建新的 Rust Session".into(),
            });
        }
        Err(error) => app.apply_event(VcpEvent::RuntimeWarning {
            message: error.to_string(),
        }),
    }
}

fn send(runtime: &mut Runtime, command: HostCommand) {
    match runtime {
        Runtime::Native { host, .. } => {
            let _ = host.commands.send(command);
        }
        Runtime::Bridge(bridge) => match command {
            HostCommand::StartTurn { prompt, .. } => bridge.send(UiAction::Submit { prompt }),
            HostCommand::Cancel => bridge.send(UiAction::Cancel),
            HostCommand::Approval {
                approval_id,
                allowed,
                ..
            } => bridge.send(UiAction::Approval {
                approval_id,
                allowed,
            }),
            HostCommand::Steer { prompt } | HostCommand::FollowUp { prompt } => {
                bridge.send(UiAction::Command {
                    command: format!("/steer {prompt}"),
                })
            }
            _ => {}
        },
        Runtime::Unavailable => {}
    }
}

fn shutdown(runtime: &mut Runtime) {
    match runtime {
        Runtime::Native { host, .. } => {
            let _ = host.commands.send(HostCommand::Shutdown);
        }
        Runtime::Bridge(bridge) => bridge.send(UiAction::Quit),
        Runtime::Unavailable => {}
    }
}

#[derive(Clone)]
struct Options {
    bridge_path: Option<String>,
    use_alternate_screen: bool,
    help: bool,
    version: bool,
    open_settings: bool,
    overrides: RuntimeOverrides,
}

fn parse_options() -> Options {
    let mut args = std::env::args().skip(1);
    let mut screen_mode_explicit = false;
    let mut options = Options {
        bridge_path: None,
        use_alternate_screen: true,
        help: false,
        version: false,
        open_settings: false,
        overrides: RuntimeOverrides::default(),
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bridge" => options.bridge_path = args.next(),
            "--minimal" | "--no-alt-screen" => {
                options.use_alternate_screen = false;
                screen_mode_explicit = true;
            }
            "--fullscreen" => {
                options.use_alternate_screen = true;
                screen_mode_explicit = true;
            }
            "--model" | "-m" => options.overrides.model = args.next(),
            "--agent" | "-a" => options.overrides.agent = args.next(),
            "--settings-path" => options.overrides.settings_path = args.next().map(PathBuf::from),
            "--agents-dir" => options.overrides.agents_dir = args.next().map(PathBuf::from),
            "--resume" => options.overrides.resume = args.next(),
            "--settings" => options.open_settings = true,
            "--permission-mode" => {
                options.overrides.always_approve = matches!(
                    args.next().as_deref(),
                    Some("always-approve") | Some("yolo")
                );
            }
            "--always-approve" | "--yolo" => options.overrides.always_approve = true,
            "--help" | "-h" => options.help = true,
            "--version" | "-v" => options.version = true,
            value if value.starts_with('-') => {}
            value => {
                if options.overrides.workspace.is_none() {
                    options.overrides.workspace = Some(PathBuf::from(value));
                }
            }
        }
    }
    if !screen_mode_explicit {
        let path = options
            .overrides
            .settings_path
            .clone()
            .unwrap_or_else(default_settings_path);
        if let Ok(raw) = std::fs::read_to_string(path)
            && let Ok(settings) = serde_json::from_str::<Value>(&raw)
            && settings
                .pointer("/agentRuntime/tui/screenMode")
                .and_then(Value::as_str)
                == Some("minimal")
        {
            options.use_alternate_screen = false;
        }
    }
    options
}

fn run_settings_wizard(overrides: &RuntimeOverrides) -> io::Result<()> {
    let path = overrides
        .settings_path
        .clone()
        .unwrap_or_else(default_settings_path);
    println!("\nVCP Agent 共享配置向导");
    println!("设置文件：{}", path.display());
    println!("直接回车会保留原值；API Key 不会回显。\n");
    let server_url = prompt_line("VCP Server URL")?;
    let api_key = rpassword::prompt_password("VCP API Key: ")?;
    let default_model = prompt_line("默认模型 ID")?;
    let default_agent_id = prompt_line("默认 Agent（Nova）")?;
    let optional = |value: String| (!value.trim().is_empty()).then(|| value.trim().to_string());
    update_shared_settings(
        &path,
        &TuiSettingsUpdate {
            server_url: optional(server_url),
            api_key: optional(api_key),
            default_model: optional(default_model),
            default_agent_id: optional(default_agent_id),
            ..TuiSettingsUpdate::default()
        },
    )
    .map_err(io::Error::other)?;
    println!("配置已安全写入。\n");
    Ok(())
}

fn prompt_line(label: &str) -> io::Result<String> {
    print!("{label}: ");
    io::stdout().flush()?;
    let mut value = String::new();
    io::stdin().read_line(&mut value)?;
    Ok(value.trim_end().to_string())
}

fn print_help() {
    println!(
        "VCP Agent (pure Rust)\n\nUsage:\n  vcp-agent [workspace] [options]\n\nOptions:\n  -m, --model <id>       模型\n  -a, --agent <id|name>  Agent（默认 Nova）\n      --settings         启动前打开共享配置向导\n      --settings-path <path>\n      --resume <id|latest>\n      --minimal | --fullscreen\n      --permission-mode <ask|always-approve>\n      --yolo\n  -h, --help\n  -v, --version\n\nEnvironment: VCP_SERVER_URL, VCP_API_KEY, VCP_AGENT_SETTINGS_PATH, VCP_AGENT_AGENTS_DIR"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_tui_submit_uses_the_rust_host_command_channel() {
        let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, events) = tokio::sync::mpsc::unbounded_channel();
        let mut runtime = Runtime::Native {
            host: RunningHost {
                commands,
                events,
                session_id: "session-test".into(),
                topic_id: "topic-test".into(),
            },
            overrides: Box::new(RuntimeOverrides::default()),
        };
        let mut app = App::new();

        dispatch_action(
            &mut app,
            &mut runtime,
            InputAction::Submit("通过 Rust Host 执行".into()),
        );

        match command_rx.try_recv().expect("native Host command") {
            HostCommand::StartTurn { prompt, turn_id } => {
                assert_eq!(prompt, "通过 Rust Host 执行");
                assert_eq!(turn_id, None);
            }
            _ => panic!("TUI submit must project to HostCommand::StartTurn"),
        }
    }

    #[test]
    fn queue_item_commands_are_forwarded_to_the_authoritative_host() {
        let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, events) = tokio::sync::mpsc::unbounded_channel();
        let mut runtime = Runtime::Native {
            host: RunningHost {
                commands,
                events,
                session_id: "session-test".into(),
                topic_id: "topic-test".into(),
            },
            overrides: Box::new(RuntimeOverrides::default()),
        };
        let mut app = App::new();

        dispatch_command(&mut app, &mut runtime, "/queue remove interaction-1".into());
        assert!(matches!(
            command_rx.try_recv().expect("remove command"),
            HostCommand::RemoveInteractionQueueItem { interaction_id, .. }
                if interaction_id == "interaction-1"
        ));

        dispatch_command(
            &mut app,
            &mut runtime,
            "/queue replace interaction-2 改成先检查测试".into(),
        );
        assert!(matches!(
            command_rx.try_recv().expect("replace command"),
            HostCommand::ReplaceInteractionQueueItem { interaction_id, prompt, .. }
                if interaction_id == "interaction-2" && prompt == "改成先检查测试"
        ));
    }

    #[test]
    fn usage_is_local_projection_and_budget_queries_host_settings() {
        let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, events) = tokio::sync::mpsc::unbounded_channel();
        let mut runtime = Runtime::Native {
            host: RunningHost {
                commands,
                events,
                session_id: "session-test".into(),
                topic_id: "topic-test".into(),
            },
            overrides: Box::new(RuntimeOverrides::default()),
        };
        let mut app = App::new();

        dispatch_command(&mut app, &mut runtime, "/usage".into());
        assert_eq!(
            app.messages.last().map(|block| block.title.as_str()),
            Some("Usage")
        );
        assert!(command_rx.try_recv().is_err());

        dispatch_command(&mut app, &mut runtime, "/budget".into());
        assert!(matches!(
            command_rx.try_recv().expect("settings request"),
            HostCommand::GetSettings { .. }
        ));

        dispatch_command(&mut app, &mut runtime, "/settings".into());
        assert!(matches!(
            command_rx.try_recv().expect("settings summary request"),
            HostCommand::GetSettings { .. }
        ));
    }

    #[test]
    fn topic_delete_requires_explicit_confirmation() {
        let (commands, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let (_event_tx, events) = tokio::sync::mpsc::unbounded_channel();
        let mut runtime = Runtime::Native {
            host: RunningHost {
                commands,
                events,
                session_id: "session-test".into(),
                topic_id: "topic-test".into(),
            },
            overrides: Box::new(RuntimeOverrides::default()),
        };
        let mut app = App::new();

        dispatch_command(&mut app, &mut runtime, "/topics delete old-topic".into());
        assert!(command_rx.try_recv().is_err());
        assert_eq!(
            app.messages.last().map(|block| block.title.as_str()),
            Some("确认删除 Topic")
        );

        dispatch_command(
            &mut app,
            &mut runtime,
            "/topics delete old-topic --confirm".into(),
        );
        assert!(matches!(
            command_rx.try_recv().expect("confirmed delete"),
            HostCommand::DeleteTopic { topic_id, .. } if topic_id == "old-topic"
        ));
    }

    #[test]
    fn backend_approval_observation_is_explicit_and_not_locally_resolved() {
        let event = toolbox_observation(
            "VCPInfo".into(),
            "backend-approval-request".into(),
            serde_json::json!({"toolName":"PowerShellExecutor","approvalId":"backend-1"}),
        )
        .expect("backend approval must remain visible");
        let VcpEvent::ToolboxObservation { title, detail, .. } = event else {
            panic!("expected observer event");
        };
        assert_eq!(title, "等待 ToolBox 后端审批");
        assert!(detail.contains("PowerShellExecutor"));
        assert!(detail.contains("不会绕过"));
    }

    #[test]
    fn rag_retrieval_observation_uses_a_compact_structured_summary() {
        let event = toolbox_observation(
            "Info".into(),
            "notification".into(),
            serde_json::json!({
                "type":"RAG_RETRIEVAL_DETAILS",
                "dbName":"KnowledgeBase",
                "query":"VCPAgent 如何调用插件",
                "results":[{"score":0.9},{"score":0.8}],
                "iteration":2,
                "useTime":true,
                "useTagMemo":true,
                "tagWeight":0.4595,
                "useGeodesicRerank":true
            }),
        )
        .expect("RAG retrieval must remain visible");
        let VcpEvent::ToolboxObservation {
            kind,
            title,
            detail,
            ..
        } = event
        else {
            panic!("expected observer event");
        };
        assert_eq!(kind, "RAG_RETRIEVAL_DETAILS");
        assert_eq!(title, "RAG 检索 · KnowledgeBase · 2 条命中");
        assert!(detail.contains("查询：VCPAgent 如何调用插件"));
        assert!(detail.contains("时间召回 · 标签增强 0.46 · GeoReRank · 第 2 轮"));
        assert!(detail.contains("原始元数据"));
    }

    #[test]
    fn transport_ack_and_meta_chain_do_not_pollute_the_conversation() {
        assert!(
            toolbox_observation(
                "Info".into(),
                "notification".into(),
                serde_json::json!({"type":"connection_ack","message":"connected"})
            )
            .is_none()
        );
        assert!(
            toolbox_observation(
                "Info".into(),
                "notification".into(),
                serde_json::json!({"type":"META_THINKING_CHAIN","query":"internal"})
            )
            .is_none()
        );
    }

    #[test]
    fn topic_catalog_labels_lease_state_without_creating_local_topic_truth() {
        let items = topic_choice_items(&serde_json::json!([{
            "id":"topic-live",
            "title":"正在执行",
            "model":"gpt-5.6-terra",
            "workspaceRef":"C:/VCP/workspace",
            "inUse":true,
            "readOnly":false
        }]));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "topic-live");
        assert!(items[0].detail.contains("in use"));
        assert!(items[0].detail.contains("C:/VCP/workspace"));
    }
}
