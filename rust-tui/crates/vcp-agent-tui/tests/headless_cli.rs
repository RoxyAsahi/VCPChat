//! Process-level contract for `vcp-agent --print`.
//!
//! This intentionally starts the public binary rather than calling the CLI
//! library, so argument parsing, non-TTY stdin selection and stdout purity are
//! covered together.  The tiny HTTP server is a hermetic ToolBox model-gateway
//! stand-in; no VCPToolBox instance or credential is required.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener};
use std::process::{Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::tempdir;
use wait_timeout::ChildExt as _;

fn response(body: &str, content_type: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn run_cli(
    executable: &str,
    settings: &std::path::Path,
    agents_dir: &std::path::Path,
    args: &[&str],
    stdin: &[u8],
) -> (std::process::ExitStatus, String, String) {
    let mut child = Command::new(executable)
        .args(args)
        .env("VCP_AGENT_SETTINGS_PATH", settings)
        .env("VCP_AGENT_AGENTS_DIR", agents_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let status = child
        .wait_timeout(Duration::from_secs(15))
        .unwrap()
        .unwrap_or_else(|| {
            let _ = child.kill();
            panic!("vcp-agent headless invocation did not exit within the deadline")
        });
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .unwrap();
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (status, stdout, stderr)
}

#[test]
fn pipe_syntax_and_print_mode_keep_json_stdout_machine_readable() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let running_server = Arc::clone(&running);
    let received_server = Arc::clone(&received);
    let server = thread::spawn(move || {
        while running_server.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let received = Arc::clone(&received_server);
                    thread::spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut request = vec![0_u8; 32 * 1024];
                        let read = stream.read(&mut request).unwrap_or_default();
                        let request = String::from_utf8_lossy(&request[..read]).to_string();
                        received.lock().unwrap().push(request.clone());
                        let payload = if request.starts_with("POST /v1/chat/completions") {
                            concat!(
                                "data: {\"choices\":[{\"delta\":{\"content\":\"pipe sentinel\"}}]}\n\n",
                                "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
                                "data: [DONE]\n\n"
                            )
                        } else if request.starts_with("GET /v1/models") {
                            "{\"data\":[{\"id\":\"test-model\"}]}"
                        } else {
                            "{}"
                        };
                        let content_type = if request.starts_with("POST /v1/chat/completions") {
                            "text/event-stream"
                        } else {
                            "application/json"
                        };
                        let _ = stream.write_all(response(payload, content_type).as_bytes());
                        let _ = stream.shutdown(Shutdown::Both);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let root = tempdir().unwrap();
    let settings = root.path().join("settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({
            "vcpServerUrl": format!("http://{address}"),
            "vcpApiKey": "test-key",
            "agentRuntime": { "tui": { "defaultModel": "test-model", "defaultAgentId": "Nova" } }
        }))
        .unwrap(),
    )
    .unwrap();
    let executable = env!("CARGO_BIN_EXE_vcp-agent");
    let (explicit_status, explicit_stdout, explicit_stderr) = run_cli(
        executable,
        &settings,
        &root.path().join("Agents"),
        &[
            "--print",
            "summarize this input",
            "--output-format",
            "json",
            "--workspace",
            env!("CARGO_MANIFEST_DIR"),
        ],
        b"commit abc: fix parser\n",
    );
    let (pipe_status, pipe_stdout, pipe_stderr) = run_cli(
        executable,
        &settings,
        &root.path().join("Agents"),
        &[
            "summarize this input",
            "--output-format",
            "json",
            "--workspace",
            env!("CARGO_MANIFEST_DIR"),
        ],
        b"commit positional: ensure non-tty entrypoint\n",
    );
    running.store(false, Ordering::Relaxed);
    server.join().unwrap();

    assert!(explicit_status.success(), "stderr: {explicit_stderr}");
    assert!(pipe_status.success(), "stderr: {pipe_stderr}");
    for stdout in [&explicit_stdout, &pipe_stdout] {
        let result: Value =
            serde_json::from_str(stdout).expect("stdout must contain only one JSON result");
        assert_eq!(result["text"], "pipe sentinel");
        assert_eq!(result["stopReason"], "completed");
        assert_eq!(result["persistent"], false);
    }
    assert!(
        received
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.contains("commit abc: fix parser")
                && request.contains("vcpscript-stdin")),
        "the model request must contain the piped input behind the explicit boundary"
    );
    assert!(
        received.lock().unwrap().iter().any(|request| request
            .contains("commit positional: ensure non-tty entrypoint")
            && request.contains("vcpscript-stdin")),
        "non-TTY stdin plus a positional prompt must select the script entrypoint"
    );
}

#[test]
fn print_mode_fails_closed_before_a_high_risk_tool_can_reach_toolbox() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let running = Arc::new(AtomicBool::new(true));
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let model_round = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let running_server = Arc::clone(&running);
    let received_server = Arc::clone(&received);
    let model_round_server = Arc::clone(&model_round);
    let server = thread::spawn(move || {
        while running_server.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let received = Arc::clone(&received_server);
                    let model_round = Arc::clone(&model_round_server);
                    thread::spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let mut request = vec![0_u8; 32 * 1024];
                        let read = stream.read(&mut request).unwrap_or_default();
                        let request = String::from_utf8_lossy(&request[..read]).to_string();
                        received.lock().unwrap().push(request.clone());
                        let payload = if request.starts_with("POST /v1/chat/completions") {
                            let round = model_round.fetch_add(1, Ordering::Relaxed);
                            if round == 0 {
                                concat!(
                                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_high\",\"type\":\"function\",\"function\":{\"name\":\"vcp_invoke\",\"arguments\":\"{\\\"toolName\\\":\\\"PowerShellExecutor\\\",\\\"arguments\\\":{\\\"command\\\":\\\"Get-Location\\\"}}\"}}]}}]}\n\n",
                                    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
                                    "data: [DONE]\n\n"
                                )
                            } else {
                                concat!(
                                    "data: {\"choices\":[{\"delta\":{\"content\":\"local denial observed\"}}]}\n\n",
                                    "data: [DONE]\n\n"
                                )
                            }
                        } else if request.starts_with("GET /v1/models") {
                            "{\"data\":[{\"id\":\"test-model\"}]}"
                        } else {
                            "{}"
                        };
                        let content_type = if request.starts_with("POST /v1/chat/completions") {
                            "text/event-stream"
                        } else {
                            "application/json"
                        };
                        let _ = stream.write_all(response(payload, content_type).as_bytes());
                        let _ = stream.shutdown(Shutdown::Both);
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });

    let root = tempdir().unwrap();
    let settings = root.path().join("settings.json");
    std::fs::write(
        &settings,
        serde_json::to_vec(&json!({
            "vcpServerUrl": format!("http://{address}"),
            "vcpApiKey": "test-key",
            "agentRuntime": { "tui": { "defaultModel": "test-model", "defaultAgentId": "Nova" } }
        }))
        .unwrap(),
    )
    .unwrap();
    let (status, stdout, stderr) = run_cli(
        env!("CARGO_BIN_EXE_vcp-agent"),
        &settings,
        &root.path().join("Agents"),
        &[
            "--print",
            "request a high risk tool",
            "--output-format",
            "json",
            "--workspace",
            env!("CARGO_MANIFEST_DIR"),
        ],
        b"",
    );
    running.store(false, Ordering::Relaxed);
    server.join().unwrap();

    assert_eq!(status.code(), Some(3), "stderr: {stderr}");
    let result: Value =
        serde_json::from_str(&stdout).expect("stdout must remain a single JSON object");
    assert_eq!(result["ok"], false);
    assert_eq!(result["stopReason"], "approval-denied");
    assert!(stderr.contains("denied local approval"));
    let requests = received.lock().unwrap();
    assert_eq!(model_round.load(Ordering::Relaxed), 2);
    assert!(
        requests
            .iter()
            .all(|request| !request.starts_with("POST /v1/human/tool")),
        "local high-risk denial must prevent marker execution"
    );
}
