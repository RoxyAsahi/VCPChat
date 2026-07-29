#![cfg(windows)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};
use tokio::net::windows::named_pipe::ServerOptions;
use vcp_agent_pty_harness::{PtyHarness, keys};
use vcp_agent_tui::{ApprovalBinding, UiAction, UiInbound, VcpEvent};

const WAIT: Duration = Duration::from_secs(12);
const LIVE_WAIT: Duration = Duration::from_secs(180);

struct BridgeFixture {
    pipe: String,
    actions: mpsc::Receiver<UiAction>,
    done: Option<thread::JoinHandle<()>>,
}

impl BridgeFixture {
    fn start(events: Vec<VcpEvent>) -> Self {
        let slash = char::from(92);
        let pipe = format!(
            "{slash}{slash}.{slash}pipe{slash}vcp-agent-pty-{}-{}",
            std::process::id(),
            unique_suffix()
        );
        let server_pipe = pipe.clone();
        let (action_tx, actions) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let done = thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .expect("bridge runtime")
                .block_on(async move {
                    let server = ServerOptions::new()
                        .access_outbound(true)
                        .first_pipe_instance(true)
                        .create(&server_pipe)
                        .expect("create bridge pipe");
                    ready_tx.send(()).expect("announce pipe");
                    server.connect().await.expect("connect bridge");
                    let (reader, mut writer) = tokio::io::split(server);
                    let mut lines =
                        tokio::io::AsyncBufReadExt::lines(tokio::io::BufReader::new(reader));
                    let first = lines
                        .next_line()
                        .await
                        .expect("read ready")
                        .expect("ready line");
                    action_tx
                        .send(serde_json::from_str(&first).expect("parse ready"))
                        .expect("send ready");
                    for event in events {
                        let line = serde_json::to_string(&UiInbound::Event {
                            event: Box::new(event),
                        })
                        .expect("serialize event");
                        tokio::io::AsyncWriteExt::write_all(&mut writer, line.as_bytes())
                            .await
                            .expect("write event");
                        tokio::io::AsyncWriteExt::write_all(&mut writer, &[10])
                            .await
                            .expect("write newline");
                    }
                    tokio::io::AsyncWriteExt::flush(&mut writer)
                        .await
                        .expect("flush events");
                    while let Ok(Some(line)) = lines.next_line().await {
                        let Ok(action) = serde_json::from_str::<UiAction>(&line) else {
                            continue;
                        };
                        let quit = action == UiAction::Quit;
                        if action_tx.send(action).is_err() || quit {
                            break;
                        }
                    }
                });
        });
        ready_rx.recv_timeout(WAIT).expect("pipe readiness");
        Self {
            pipe,
            actions,
            done: Some(done),
        }
    }

    fn wait_for_action(&self, expected: impl Fn(&UiAction) -> bool) -> Option<UiAction> {
        loop {
            let Ok(action) = self.actions.recv_timeout(WAIT) else {
                return None;
            };
            if expected(&action) {
                return Some(action);
            }
        }
    }
}

impl Drop for BridgeFixture {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            done.join().expect("bridge clean exit");
        }
    }
}

fn unique_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos()
}

fn spawn_tui(pipe: &str, rows: u16, cols: u16, mode: &str) -> PtyHarness {
    spawn_tui_with_env(&["--bridge", pipe, mode], rows, cols, BTreeMap::new())
}

fn spawn_tui_with_env(
    args: &[&str],
    rows: u16,
    cols: u16,
    env: BTreeMap<String, String>,
) -> PtyHarness {
    let mut tui = PtyHarness::spawn(
        &PathBuf::from(env!("CARGO_BIN_EXE_vcp-agent")),
        rows,
        cols,
        args,
        &env,
        Some(Path::new(env!("CARGO_MANIFEST_DIR"))),
    )
    .expect("spawn VCP TUI");
    tui.update(Duration::from_millis(250));
    tui
}

fn quit(tui: &mut PtyHarness) {
    tui.inject(b"/quit").expect("type quit");
    tui.inject(keys::ENTER).expect("submit quit");
    assert_eq!(tui.wait_for_exit_and_drain(WAIT).expect("clean exit"), 0);
}

#[test]
fn fullscreen_renders_cjk_stream_across_resize_storm_and_restores_terminal() {
    let first = "FIRST_VCP_STREAM_SENTINEL 中文表格";
    let last = "LAST_VCP_STREAM_SENTINEL 完成";
    let markdown = format!(
        "{first}\n\n| 项目 | 状态 |\n|---|---|\n| Agent | 正常 |\n\n{}\n\n{last}",
        "中间流式内容。".repeat(24)
    );
    let fixture = BridgeFixture::start(vec![
        VcpEvent::SessionStarted {
            agent: "Nova".into(),
            model: "gpt-5.6-terra".into(),
            workspace: "C:/VCP/中文 workspace".into(),
        },
        VcpEvent::AssistantDelta { text: markdown },
        VcpEvent::AssistantCompleted,
    ]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 60, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.wait_for_text(last, WAIT)
        .expect("live stream follows tail");
    for (rows, cols) in [(30, 80), (18, 120), (26, 60), (24, 80)] {
        tui.resize(rows, cols).expect("resize");
        tui.update(Duration::from_millis(120));
    }
    assert!(tui.screen_contents().contains(last));
    quit(&mut tui);
    let raw = tui.raw_output();
    assert!(raw.windows(8).any(|w| w == b"\x1b[?1049h"));
    assert!(raw.windows(8).any(|w| w == b"\x1b[?1049l"));
    assert!(raw.windows(8).any(|w| w == b"\x1b[?2004l"));
    assert!(raw.windows(6).any(|w| w == b"\x1b[?25h"));
}

#[test]
fn ctrl_s_submits_a_real_prompt_through_conpty() {
    let fixture = BridgeFixture::start(Vec::new());
    let mut tui = spawn_tui(&fixture.pipe, 24, 80, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.inject("PTY_SUBMIT_中文".as_bytes())
        .expect("type prompt");
    tui.inject(keys::CTRL_S).expect("submit prompt");
    assert_eq!(
        fixture
            .wait_for_action(|action| matches!(action, UiAction::Submit { .. }))
            .expect("submit action"),
        UiAction::Submit {
            prompt: "PTY_SUBMIT_中文".into()
        }
    );
    quit(&mut tui);
}

#[test]
fn approval_enter_uses_deny_default() {
    let fixture = BridgeFixture::start(vec![VcpEvent::ApprovalRequested {
        approval_id: "approval-1".into(),
        tool_name: "PowerShellExecutor".into(),
        risk: "high".into(),
        reason: "执行命令".into(),
        argument_summary: "Get-Location".into(),
        expires_at_ms: None,
        binding: Some(ApprovalBinding {
            session_id: "session-1".into(),
            turn_id: "turn-1".into(),
            tool_call_id: "call-1".into(),
            arguments_hash: "sha256:abc".into(),
        }),
    }]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 80, "--fullscreen");
    if fixture
        .wait_for_action(|action| *action == UiAction::Ready)
        .is_none()
    {
        tui.update(Duration::from_millis(250));
        panic!(
            "bridge ready timeout; pipe={:?}; screen={:?}; raw={:?}",
            fixture.pipe,
            tui.screen_contents(),
            String::from_utf8_lossy(tui.raw_output())
        );
    }
    tui.wait_for_text("拒绝", WAIT).expect("approval modal");
    tui.inject(keys::ENTER).expect("default decision");
    assert_eq!(
        fixture
            .wait_for_action(|a| matches!(a, UiAction::Approval { .. }))
            .expect("approval action"),
        UiAction::Approval {
            approval_id: "approval-1".into(),
            allowed: false
        }
    );
    quit(&mut tui);
}

#[test]
fn minimal_mode_survives_resize_without_alternate_screen_or_duplicate_commit() {
    let sentinel = "MINIMAL_VCP_SENTINEL 中文";
    let fixture = BridgeFixture::start(vec![
        VcpEvent::AssistantDelta {
            text: sentinel.into(),
        },
        VcpEvent::AssistantCompleted,
    ]);
    let mut tui = spawn_tui(&fixture.pipe, 20, 80, "--minimal");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.wait_for_text(sentinel, WAIT).expect("minimal stream");
    for (rows, cols) in [(16, 60), (30, 120), (20, 80)] {
        tui.resize(rows, cols).expect("resize");
        tui.update(Duration::from_millis(100));
    }
    assert!(!tui.raw_output().windows(8).any(|w| w == b"\x1b[?1049h"));
    assert_eq!(tui.screen_contents().matches(sentinel).count(), 1);
    quit(&mut tui);
}

#[test]
fn active_turn_ctrl_c_emits_cancel_and_recovery_projection_is_visible() {
    let fixture = BridgeFixture::start(vec![
        VcpEvent::SessionStarted {
            agent: "Nova".into(),
            model: "gpt-5.6-terra".into(),
            workspace: "C:/VCP/recovery".into(),
        },
        VcpEvent::RuntimeStatus {
            runtime: vcp_agent_tui::RuntimeState::Working,
            toolbox: vcp_agent_tui::ToolBoxState::Connected,
            permission_mode: vcp_agent_tui::PermissionMode::Ask,
        },
        VcpEvent::Notice {
            title: "Topic recovery".into(),
            message: "RESTORED_INTERRUPTED_CHECKPOINT".into(),
        },
    ]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 80, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.wait_for_text("RESTORED_INTERRUPTED_CHECKPOINT", WAIT)
        .expect("recovery projection");
    tui.inject(keys::CTRL_C).expect("cancel active turn");
    assert_eq!(
        fixture
            .wait_for_action(|action| *action == UiAction::Cancel)
            .expect("cancel action"),
        UiAction::Cancel
    );
    quit(&mut tui);
}

#[test]
fn long_tool_result_is_inspectable_in_a_scrollable_detail_overlay() {
    let detail = format!(
        "LONG_TOOL_RESULT_BEGIN\n{}LONG_TOOL_RESULT_END",
        "第 42 行工具输出用于验证滚动。\n".repeat(90)
    );
    let fixture = BridgeFixture::start(vec![VcpEvent::ToolStatus {
        call_id: "call-long".into(),
        tool_name: "FileOperator".into(),
        status: vcp_agent_tui::ToolStatus::Completed,
        detail,
    }]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 80, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.inject(keys::CTRL_O).expect("open tool detail");
    tui.wait_for_text("LONG_TOOL_RESULT_BEGIN", WAIT)
        .expect("tool detail start");
    // CJK wrapping can turn one logical line into several visual rows. Scroll
    // far enough to prove the overlay exposes the bounded tail as well as the
    // first page.
    for _ in 0..240 {
        tui.inject(keys::DOWN).expect("scroll tool detail");
    }
    tui.update(Duration::from_millis(250));
    tui.wait_for_text("LONG_TOOL_RESULT_END", WAIT)
        .expect("tool detail tail");
    tui.inject(keys::ESC).expect("close tool detail");
    quit(&mut tui);
}

#[test]
fn rag_observation_hides_raw_metadata_until_toolbox_expand_command() {
    let fixture = BridgeFixture::start(vec![
        VcpEvent::ToolboxObservation {
            channel: "Info".into(),
            kind: "RAG_RETRIEVAL_DETAILS".into(),
            title: "RAG 检索 · KnowledgeBase · 2 条命中".into(),
            detail: "查询：VCP Agent 插件协议\n策略：时间召回 · 标签增强 0.46 · GeoReRank\n\n原始元数据\n{\"RAG_RAW_TAG_WEIGHT_SENTINEL\":0.4595}".into(),
        },
        VcpEvent::ToolboxObservation {
            channel: "Info".into(),
            kind: "RAG_RETRIEVAL_DETAILS".into(),
            title: "RAG 检索 · Nova · 3 条命中".into(),
            detail: "查询：VCP Agent 插件协议\n策略：时间召回 · 标签增强 0.46 · GeoReRank\n\n原始元数据\n{\"RAG_RAW_NOVA_SENTINEL\":3}".into(),
        },
    ]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 100, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.wait_for_text("RAG 检索 · 2 源 · 5 命中", WAIT)
        .expect("compact RAG summary");
    let collapsed = tui.screen_contents();
    assert!(collapsed.contains("VCP Agent 插件协议"));
    assert!(collapsed.contains("KnowledgeBase 2 · Nova 3"));
    assert!(!collapsed.contains("RAG_RAW_TAG_WEIGHT_SENTINEL"));
    assert!(!collapsed.contains("RAG_RAW_NOVA_SENTINEL"));

    tui.inject(b"/toolbox").expect("type toolbox command");
    tui.inject(keys::ENTER).expect("expand toolbox event");
    tui.wait_for_text("RAG_RAW_TAG_WEIGHT_SENTINEL", WAIT)
        .expect("expanded raw RAG metadata");
    tui.wait_for_text("RAG_RAW_NOVA_SENTINEL", WAIT)
        .expect("expanded second RAG source metadata");
    quit(&mut tui);
}

#[test]
fn repeated_session_projection_switch_keeps_only_the_latest_identity() {
    let fixture = BridgeFixture::start(vec![
        VcpEvent::SessionStarted {
            agent: "OldAgentSentinel".into(),
            model: "old-model".into(),
            workspace: "C:/old-workspace".into(),
        },
        VcpEvent::AssistantDelta {
            text: "OLD_SESSION_TRANSCRIPT_SENTINEL".into(),
        },
        VcpEvent::SessionStarted {
            agent: "Nova".into(),
            model: "gpt-5.6-terra".into(),
            workspace: "C:/new-workspace".into(),
        },
    ]);
    let mut tui = spawn_tui(&fixture.pipe, 24, 100, "--fullscreen");
    assert_eq!(
        fixture.wait_for_action(|action| *action == UiAction::Ready),
        Some(UiAction::Ready)
    );
    tui.wait_for_text("gpt-5.6-terra", WAIT)
        .expect("latest session projection");
    let screen = tui.screen_contents();
    assert!(screen.contains("Nova"));
    assert!(!screen.contains("OLD_SESSION_TRANSCRIPT_SENTINEL"));
    assert!(!screen.contains("OldAgentSentinel"));
    quit(&mut tui);
}

#[test]
fn debug_panic_restores_terminal_modes() {
    let mut env = BTreeMap::new();
    env.insert("VCP_AGENT_TUI_TEST_PANIC_AFTER_INIT".into(), "1".into());
    let mut tui = spawn_tui_with_env(&["--fullscreen"], 24, 80, env);
    assert_ne!(
        tui.wait_for_exit_and_drain(WAIT)
            .expect("panic fixture exit"),
        0
    );
    let raw = tui.raw_output();
    assert!(raw.windows(8).any(|w| w == b"\x1b[?1049h"));
    assert!(raw.windows(8).any(|w| w == b"\x1b[?1049l"));
    assert!(raw.windows(8).any(|w| w == b"\x1b[?2004l"));
    assert!(raw.windows(6).any(|w| w == b"\x1b[?25h"));
}

#[test]
#[ignore = "requires VCP_AGENT_TUI_LIVE=1 and a real VCPToolBox"]
fn native_tui_live_executes_fileoperator_from_real_keyboard_input() {
    assert_eq!(
        std::env::var("VCP_AGENT_TUI_LIVE").as_deref(),
        Ok("1"),
        "set VCP_AGENT_TUI_LIVE=1 to acknowledge real model/tool usage"
    );
    let server_url = std::env::var("VCP_SERVER_URL").expect("VCP_SERVER_URL");
    let api_key = std::env::var("VCP_API_KEY").expect("VCP_API_KEY");
    let agents_dir = std::env::var("VCP_AGENT_AGENTS_DIR").expect("VCP_AGENT_AGENTS_DIR");
    let root = std::env::temp_dir().join(format!(
        "vcp-agent-tui-live-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    std::fs::create_dir_all(&root).expect("create isolated live settings root");
    let settings_path = root.join("settings.json");
    std::fs::write(&settings_path, "{}").expect("write isolated live settings");

    let mut env = BTreeMap::new();
    env.insert("VCP_SERVER_URL".into(), server_url);
    env.insert("VCP_API_KEY".into(), api_key);
    env.insert("VCP_AGENT_AGENTS_DIR".into(), agents_dir);
    env.insert(
        "VCP_AGENT_SETTINGS_PATH".into(),
        settings_path.display().to_string(),
    );
    let settings_arg = settings_path.display().to_string();
    let workspace_arg = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("repository root")
        .display()
        .to_string();
    let args = [
        workspace_arg.as_str(),
        "--fullscreen",
        "--model",
        "gpt-5.6-terra",
        "--agent",
        "Nova",
        "--settings-path",
        settings_arg.as_str(),
    ];
    let mut tui = spawn_tui_with_env(&args, 30, 100, env);
    tui.wait_for_text("会话已就绪", WAIT)
        .expect("native TUI ready");

    let prompt = "使用 VCPToolBox 文件工具读取当前 workspace 的 package.json，然后仅回答其中 name 字段的值。必须实际调用工具，不要凭记忆。";
    tui.inject(prompt.as_bytes()).expect("type live prompt");
    tui.inject(keys::CTRL_S).expect("submit live prompt");
    tui.wait_for_text("FileOperator", LIVE_WAIT)
        .expect("real FileOperator projection");
    tui.wait_for_text("vcp-chat-desktop", LIVE_WAIT)
        .expect("real package name from tool-backed response");
    quit(&mut tui);
    let _ = std::fs::remove_dir_all(root);
}
