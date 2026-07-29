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
    App, ApprovalBinding, ChoiceItem, HostBridge, InputAction, PermissionMode, RuntimeState,
    ToolBoxState, ToolStatus, UiAction, UiInbound, VcpEvent,
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
        let mut terminal = enter_terminal(use_alternate_screen)?;
        let outcome = run(&mut terminal, options.clone()).await;
        restore_terminal(&mut terminal, use_alternate_screen)?;
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

fn enter_terminal(
    use_alternate_screen: bool,
) -> io::Result<Terminal<CrosstermBackend<std::io::Stdout>>> {
    enable_raw_mode()?;
    let mut output = stdout();
    if use_alternate_screen {
        output.execute(EnterAlternateScreen)?;
    }
    output.execute(EnableMouseCapture)?;
    output.execute(EnableBracketedPaste)?;
    Terminal::new(CrosstermBackend::new(output))
}

fn restore_terminal(
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
    use_alternate_screen: bool,
) -> io::Result<()> {
    disable_raw_mode()?;
    terminal.backend_mut().execute(DisableBracketedPaste)?;
    terminal.backend_mut().execute(DisableMouseCapture)?;
    if use_alternate_screen {
        terminal.backend_mut().execute(LeaveAlternateScreen)?;
    }
    terminal.show_cursor()
}

enum Runtime {
    Native {
        host: RunningHost,
        overrides: Box<RuntimeOverrides>,
    },
    Bridge(HostBridge),
    Demo,
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
                app.apply_event(VcpEvent::RuntimeWarning {
                    message: error.to_string(),
                });
                Runtime::Demo
            }
        }
    };
    if matches!(runtime, Runtime::Demo) {
        app.apply_event(VcpEvent::SessionStarted {
            agent: "Nova".into(),
            model: options
                .overrides
                .model
                .clone()
                .unwrap_or_else(|| "未配置模型".into()),
            workspace: options
                .overrides
                .workspace
                .as_ref()
                .map(|value| value.display().to_string())
                .unwrap_or_else(|| ".".into()),
        });
    }
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
        Runtime::Demo => {}
    }
}

fn apply_host_event(app: &mut App, event: HostEvent) {
    match event {
        HostEvent::Warning(message) => app.apply_event(VcpEvent::RuntimeWarning { message }),
        HostEvent::ToolboxWs {
            channel,
            kind,
            payload,
        } => app.apply_event(VcpEvent::Notice {
            title: format!("ToolBox {channel} · {kind}"),
            message: serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string()),
        }),
        HostEvent::Approval(request) => app.apply_event(VcpEvent::ApprovalRequested {
            approval_id: request.approval_id,
            tool_name: request.tool_name,
            risk: request.risk,
            reason: request.reason,
            argument_summary: request.argument_summary,
            expires_at_ms: None,
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
                choice_items(&payload, "id", "title", "model"),
            ),
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

fn apply_core_event(app: &mut App, event: &Value) {
    let payload = event.get("payload").unwrap_or(&Value::Null);
    match event.get("type").and_then(Value::as_str) {
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
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    app.apply_event(VcpEvent::Usage {
        input_tokens: input,
        output_tokens: output,
        total_tokens: usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(input + output),
        context_window: None,
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
        "/model" if argument.is_empty() => send(runtime, HostCommand::ListModels { request_id: tui_request_id() }),
        "/model" => restart_native(runtime, app, |overrides| {
            overrides.model = Some(argument);
            overrides.resume = None;
        }),
        "/agent" if argument.is_empty() => send(runtime, HostCommand::ListAgents { request_id: tui_request_id() }),
        "/agent" => restart_native(runtime, app, |overrides| {
            overrides.agent = Some(argument);
            overrides.resume = None;
        }),
        "/topics" if argument.is_empty() => send(runtime, HostCommand::ListTopics { request_id: tui_request_id() }),
        "/topics" if argument.starts_with("rename ") => {
            let rest = argument.trim_start_matches("rename ");
            if let Some((topic_id, title)) = rest.split_once(char::is_whitespace) {
                send(runtime, HostCommand::RenameTopic { request_id: tui_request_id(), topic_id: topic_id.into(), title: title.trim().into() });
            }
        }
        "/topics" if argument.starts_with("delete ") => send(runtime, HostCommand::DeleteTopic { request_id: tui_request_id(),
            topic_id: argument.trim_start_matches("delete ").trim().into(),
        }),
        "/topics" if argument.starts_with("read ") => send(runtime, HostCommand::ReadTopic { request_id: tui_request_id(),
            topic_id: argument.trim_start_matches("read ").trim().into(),
        }),
        "/topics" if argument.starts_with("takeover ") => {
            send(runtime, HostCommand::RequestTopicTakeover {
                request_id: tui_request_id(),
                topic_id: argument.trim_start_matches("takeover ").trim().into(),
                requester_id: format!("tui_{}", std::process::id()),
            })
        }
        "/resume" if !argument.is_empty() => restart_native(runtime, app, |overrides| {
            overrides.resume = Some(argument);
        }),
        "/new" => restart_native(runtime, app, |overrides| overrides.resume = None),
        "/clear-queue" => send(runtime, HostCommand::ClearInteractionQueue { request_id: tui_request_id() }),
        "/compact" => send(runtime, HostCommand::Compact),
        "/permissions" if matches!(argument.as_str(), "ask" | "always-approve" | "yolo") => {
            let always = argument != "ask";
            send(runtime, HostCommand::UpdateSettings { request_id: tui_request_id(), update: TuiSettingsUpdate {
                permission_mode: Some(if always { "always-approve" } else { "ask" }.into()),
                ..TuiSettingsUpdate::default()
            }});
            restart_native(runtime, app, |overrides| overrides.always_approve = always);
        }
        "/settings" => app.apply_event(VcpEvent::Notice {
            title: "设置".into(),
            message: "使用 /model <id>、/agent <id>、/permissions <ask|always-approve> 修改运行设置；Server URL/API Key 继续安全读取共享 settings.json 或环境变量。".into(),
        }),
        "/queue" => send(runtime, HostCommand::ListInteractionQueue { request_id: tui_request_id() }),
        "/budget" if !argument.is_empty() => {
            let mut budget = BudgetLimits::default();
            for item in argument.split_whitespace() {
                let Some((key, value)) = item.split_once('=') else { continue };
                let parsed = value.parse::<u64>().ok().filter(|value| *value > 0);
                match key {
                    "requests" => budget.max_requests_per_turn = parsed,
                    "tokens" => budget.max_tokens_per_turn = parsed,
                    _ => {}
                }
            }
            send(runtime, HostCommand::UpdateSettings { request_id: tui_request_id(), update: TuiSettingsUpdate {
                budget: Some(budget),
                ..TuiSettingsUpdate::default()
            }});
            app.apply_event(VcpEvent::Notice { title: "Budget".into(), message: "预算已保存；下次创建 Session 生效。格式：/budget requests=20 tokens=200000".into() });
        }
        "/usage" | "/budget" => app.apply_event(VcpEvent::Notice {
            title: "Usage / Budget".into(),
            message: "当前累计 token 与上下文占比显示在 Footer；使用 /budget requests=<n> tokens=<n> 设置每轮上限。费用在没有可靠价格目录时保持未知。".into(),
        }),
        "/reasoning" => app.toggle_reasoning_command(),
        "/status" => app.apply_event(VcpEvent::RuntimeStatus {
            runtime: RuntimeState::Ready,
            toolbox: ToolBoxState::Connected,
            permission_mode: PermissionMode::Ask,
        }),
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
            message: "当前 bridge/demo 模式不支持重建 Rust Session".into(),
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
        Runtime::Demo => {}
    }
}

fn shutdown(runtime: &mut Runtime) {
    match runtime {
        Runtime::Native { host, .. } => {
            let _ = host.commands.send(HostCommand::Shutdown);
        }
        Runtime::Bridge(bridge) => bridge.send(UiAction::Quit),
        Runtime::Demo => {}
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
