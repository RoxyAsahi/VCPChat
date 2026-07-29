//! Rust-only host for the VCP Agent Core.
//!
//! This crate owns settings loading, ToolBox HTTP, the local approval gate and
//! the CoreRuntime driving loop.  It deliberately does not provide a second
//! plugin registry or an alternative executor: every actual tool operation is
//! encoded as the established VCPToolBox `/v1/human/tool` marker request.

pub mod topic;

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use topic::TopicStore;
use vcp_agent_core::CoreRuntime;
use vcp_agent_protocol::WireMessage;
use vcp_agent_vcp::{
    DirectToolboxHost, ToolboxConnection, ToolboxSseEvent, ToolboxWsChannel, ToolboxWsEvent,
};

static IDS: AtomicU64 = AtomicU64::new(1);
const LOCAL_APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Redacts a known secret from incremental model text without leaking a
/// partial match at an SSE boundary.  A provider is free to split a token at
/// any byte boundary, so applying `str::replace` to each delta separately is
/// not sufficient: `123` + `456` would otherwise expose `123456`.
///
/// This deliberately only buffers fields which the Core renders as model
/// text. Tool-call fragments remain structurally intact for the Core's native
/// tool-call assembler; their eventual user-visible proposal is redacted by
/// the approval/result boundary below.
#[derive(Debug)]
struct StreamingSecretRedactor {
    secret: String,
    tails: HashMap<String, String>,
}

impl StreamingSecretRedactor {
    fn new(secret: String) -> Self {
        Self {
            secret,
            tails: HashMap::new(),
        }
    }

    fn redact_model_delta(&mut self, delta: Value) -> Value {
        let Value::Object(mut object) = delta else {
            return redact_known_secret(delta, &self.secret);
        };
        for field in ["content", "reasoning_content", "reasoning"] {
            let Some(Value::String(fragment)) = object.get(field) else {
                continue;
            };
            let fragment = self.redact_fragment(field, fragment);
            object.insert(field.to_string(), Value::String(fragment));
        }
        // Non-rendered fields still must not contain a whole known credential
        // in an outbound event. Do not stream-buffer tool call fragments here:
        // that would corrupt their JSON argument assembly inside the Core.
        redact_known_secret(Value::Object(object), &self.secret)
    }

    fn redact_fragment(&mut self, field: &str, fragment: &str) -> String {
        if self.secret.is_empty() {
            return fragment.to_string();
        }
        let previous = self.tails.remove(field).unwrap_or_default();
        let mut combined = previous;
        combined.push_str(fragment);

        // Keep only the longest proper suffix which may become the start of
        // the secret in the next SSE event. Everything before it is safe to
        // release after replacing any complete occurrences.
        let hold = longest_secret_prefix_suffix(&combined, &self.secret);
        let safe_end = combined.len().saturating_sub(hold);
        let safe = &combined[..safe_end];
        if hold > 0 {
            self.tails
                .insert(field.to_string(), combined[safe_end..].to_string());
        }
        redact_string(safe, &self.secret)
    }

    fn flush_model_delta(&mut self) -> Option<Value> {
        if self.tails.is_empty() {
            return None;
        }
        let mut object = Map::new();
        for (field, tail) in std::mem::take(&mut self.tails) {
            // A retained value is only a proper prefix of the secret, but use
            // the normal redactor as a final fail-safe if this invariant ever
            // changes.
            object.insert(field, Value::String(redact_string(&tail, &self.secret)));
        }
        Some(Value::Object(object))
    }
}

fn longest_secret_prefix_suffix(value: &str, secret: &str) -> usize {
    // `secret` and every prefix are valid UTF-8 boundaries. Testing from the
    // longest prefix down keeps the held text minimal and retains streaming
    // responsiveness for ordinary output.
    for len in (1..secret.len()).rev() {
        if !secret.is_char_boundary(len) || !value.is_char_boundary(value.len().saturating_sub(len))
        {
            continue;
        }
        if value.ends_with(&secret[..len]) {
            return len;
        }
    }
    0
}

fn next_id(prefix: &str) -> String {
    format!(
        "{prefix}_{}_{}",
        std::process::id(),
        IDS.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Ask,
    AlwaysApprove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub model: String,
    pub system_prompt: String,
    /// Provider limits stored in VCPChat's shared Agent config.  Sending this
    /// through Rust keeps normal chat and Agent turns on the same output cap.
    pub context_window: u64,
    pub max_output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiSettingsUpdate {
    pub server_url: Option<String>,
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub default_agent_id: Option<String>,
    pub theme: Option<String>,
    pub screen_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub budget: Option<BudgetLimits>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetLimits {
    pub max_requests_per_turn: Option<u64>,
    pub max_tokens_per_turn: Option<u64>,
}

/// Non-sensitive part of the shared Agent settings that an untrusted UI may
/// render.  In particular this deliberately excludes `server_url` and
/// `api_key`: a GUI never needs either value merely to show or edit a budget.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiSettingsSnapshot {
    pub default_model: String,
    pub default_agent_id: String,
    pub theme: String,
    pub permission_mode: String,
    pub budget: BudgetLimits,
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub settings_path: PathBuf,
    pub agents_dir: PathBuf,
    pub server_url: String,
    pub api_key: String,
    pub model: String,
    pub agent: AgentProfile,
    pub workspace: PathBuf,
    pub permission_mode: PermissionMode,
    pub context_window: u64,
    pub max_output: u64,
    pub data_root: PathBuf,
    pub topic_id: String,
    pub initial_messages: Vec<Value>,
    pub budget: BudgetLimits,
    pub theme: String,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeOverrides {
    pub settings_path: Option<PathBuf>,
    pub agents_dir: Option<PathBuf>,
    pub server_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub workspace: Option<PathBuf>,
    pub always_approve: bool,
    pub resume: Option<String>,
}

pub fn default_settings_path() -> PathBuf {
    env::var_os("VCP_AGENT_SETTINGS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("AppData/settings.json")
        })
}

pub fn load_config(overrides: RuntimeOverrides) -> Result<HostConfig> {
    let settings_path = overrides
        .settings_path
        .unwrap_or_else(default_settings_path);
    let settings: Value = match fs::read_to_string(&settings_path) {
        Ok(raw) => serde_json::from_str(&raw)
            .with_context(|| format!("settings JSON is invalid: {}", settings_path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => {
            return Err(error).with_context(|| format!("cannot read {}", settings_path.display()));
        }
    };
    let tui = settings
        .pointer("/agentRuntime/tui")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let env_value = |name: &str| env::var(name).ok().filter(|value| !value.trim().is_empty());
    let choose = |cli: Option<String>, environment: Option<String>, saved: Option<&str>| {
        cli.filter(|value| !value.trim().is_empty())
            .or(environment)
            .or_else(|| {
                saved
                    .map(ToOwned::to_owned)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_default()
    };
    let server_url = choose(
        overrides.server_url,
        env_value("VCP_SERVER_URL"),
        settings.get("vcpServerUrl").and_then(Value::as_str),
    );
    let api_key = choose(
        overrides.api_key,
        env_value("VCP_API_KEY"),
        settings.get("vcpApiKey").and_then(Value::as_str),
    );
    let requested_agent = overrides
        .agent
        .or_else(|| {
            tui.get("defaultAgentId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "nova".to_string());
    let agents_dir = overrides
        .agents_dir
        .or_else(|| env::var_os("VCP_AGENT_AGENTS_DIR").map(PathBuf::from))
        .unwrap_or_else(|| {
            settings_path
                .parent()
                .unwrap_or(Path::new("."))
                .join("Agents")
        });
    let agent = load_agent(&agents_dir, &requested_agent)?;
    let model = choose(
        overrides.model,
        None,
        tui.get("defaultModel").and_then(Value::as_str),
    );
    let model = if model.is_empty() {
        agent.model.clone()
    } else {
        model
    };
    if server_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err(anyhow!(
            "缺少 VCP Server URL、API Key 或默认模型；可通过 settings.json、环境变量或 --model 配置"
        ));
    }
    let workspace = canonical_workspace(
        overrides
            .workspace
            .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    )?;
    let permission_mode = if overrides.always_approve
        || tui.get("permissionMode").and_then(Value::as_str) == Some("always-approve")
    {
        PermissionMode::AlwaysApprove
    } else {
        PermissionMode::Ask
    };
    let data_root = settings_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("UserData");
    let store = TopicStore::new(data_root.clone());
    let topic_id = match overrides.resume.as_deref() {
        Some("latest") => store
            .latest_topic(&agent.id)?
            .ok_or_else(|| anyhow!("没有可恢复的 Agent Topic"))?,
        Some(id) => id.to_string(),
        None => next_id("topic"),
    };
    let initial_messages = if overrides.resume.is_some() {
        store.load_snapshot(&agent.id, &topic_id)?
    } else {
        Vec::new()
    };
    let budget = tui
        .get("budget")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let theme = tui
        .get("theme")
        .and_then(Value::as_str)
        .unwrap_or("Auto")
        .to_string();
    Ok(HostConfig {
        settings_path,
        agents_dir,
        server_url,
        api_key,
        model,
        context_window: agent.context_window,
        max_output: agent.max_output,
        agent,
        workspace,
        permission_mode,
        data_root,
        topic_id,
        initial_messages,
        budget,
        theme,
    })
}

fn canonical_workspace(path: PathBuf) -> Result<PathBuf> {
    let canonical = fs::canonicalize(&path)
        .with_context(|| format!("workspace does not exist: {}", path.display()))?;
    if !canonical.is_dir() {
        return Err(anyhow!(
            "workspace is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn nova() -> AgentProfile {
    AgentProfile {
        id: "nova".into(),
        name: "Nova".into(),
        model: String::new(),
        system_prompt: "{{Nova}}".into(),
        context_window: 0,
        max_output: 0,
    }
}

pub fn load_agent(agents_dir: &Path, requested: &str) -> Result<AgentProfile> {
    let needle = requested.trim().to_lowercase();
    if let Ok(entries) = fs::read_dir(agents_dir) {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            let id = entry.file_name().to_string_lossy().to_string();
            let path = entry.path().join("config.json");
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let name = value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let prompt = value
                .get("systemPrompt")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if name.is_empty() || prompt.is_empty() {
                continue;
            }
            if id.to_lowercase() == needle || name.to_lowercase() == needle {
                return Ok(AgentProfile {
                    id,
                    name: name.to_string(),
                    model: value
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string(),
                    system_prompt: prompt.to_string(),
                    context_window: value
                        .get("contextTokenLimit")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    max_output: value
                        .get("maxOutputTokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                });
            }
        }
    }
    if needle.is_empty() || needle == "nova" {
        return Ok(nova());
    }
    Err(anyhow!("没有找到 Agent：{requested}"))
}

pub fn list_agents(agents_dir: &Path) -> Vec<AgentProfile> {
    let mut agents = Vec::new();
    if let Ok(entries) = fs::read_dir(agents_dir) {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            let id = entry.file_name().to_string_lossy().to_string();
            if let Ok(agent) = load_agent(agents_dir, &id) {
                agents.push(agent);
            }
        }
    }
    if !agents
        .iter()
        .any(|agent| agent.name.eq_ignore_ascii_case("nova"))
    {
        agents.push(nova());
    }
    agents.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    agents
}

pub fn update_shared_settings(path: &Path, update: &TuiSettingsUpdate) -> Result<()> {
    let mut settings: Value = match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).context("settings JSON is invalid")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    if !settings.is_object() {
        return Err(anyhow!("settings root must be an object"));
    }
    if let Some(value) = update.server_url.as_ref() {
        settings["vcpServerUrl"] = Value::String(value.trim().to_string());
    }
    if let Some(value) = update.api_key.as_ref() {
        settings["vcpApiKey"] = Value::String(value.to_string());
    }
    if settings.pointer("/agentRuntime/tui").is_none() {
        settings["agentRuntime"]["tui"] = json!({});
    }
    for (key, value) in [
        ("defaultModel", update.default_model.as_ref()),
        ("defaultAgentId", update.default_agent_id.as_ref()),
        ("theme", update.theme.as_ref()),
        ("screenMode", update.screen_mode.as_ref()),
        ("permissionMode", update.permission_mode.as_ref()),
    ] {
        if let Some(value) = value {
            settings["agentRuntime"]["tui"][key] = Value::String(value.to_string());
        }
    }
    if let Some(budget) = update.budget.as_ref() {
        settings["agentRuntime"]["tui"]["budget"] = serde_json::to_value(budget)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let backup = path.with_extension("bak");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(&settings)?)?;
    file.sync_all()?;
    if path.exists() {
        let _ = fs::copy(path, &backup);
    }
    fs::rename(&temporary, path).or_else(|_| {
        fs::copy(&temporary, path)
            .map(|_| ())
            .and_then(|_| fs::remove_file(&temporary))
    })?;
    Ok(())
}

fn permission_mode_name(mode: PermissionMode) -> String {
    match mode {
        PermissionMode::Ask => "ask".into(),
        PermissionMode::AlwaysApprove => "always-approve".into(),
    }
}

fn tui_settings_snapshot(config: &HostConfig) -> TuiSettingsSnapshot {
    TuiSettingsSnapshot {
        default_model: config.model.clone(),
        default_agent_id: config.agent.id.clone(),
        theme: config.theme.clone(),
        permission_mode: permission_mode_name(config.permission_mode),
        budget: config.budget.clone(),
    }
}

fn snapshot_after_update(config: &HostConfig, update: &TuiSettingsUpdate) -> TuiSettingsSnapshot {
    let mut snapshot = tui_settings_snapshot(config);
    if let Some(value) = update.default_model.as_ref() {
        snapshot.default_model = value.trim().to_string();
    }
    if let Some(value) = update.default_agent_id.as_ref() {
        snapshot.default_agent_id = value.trim().to_string();
    }
    if let Some(value) = update.theme.as_ref() {
        snapshot.theme = value.to_string();
    }
    if let Some(value) = update.permission_mode.as_ref() {
        snapshot.permission_mode = value.to_string();
    }
    if let Some(value) = update.budget.as_ref() {
        snapshot.budget = value.clone();
    }
    snapshot
}

fn parse_models(value: &Value) -> Vec<ModelProfile> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut models: Vec<ModelProfile> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            Some(ModelProfile {
                id: id.to_string(),
                context_window: entry
                    .get("context_window")
                    .or_else(|| entry.get("contextWindow"))
                    .and_then(Value::as_u64),
                max_output: entry
                    .get("max_output_tokens")
                    .or_else(|| entry.get("maxOutput"))
                    .and_then(Value::as_u64),
            })
        })
        .collect();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models
}

#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub approval_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub arguments_hash: String,
    pub tool_name: String,
    pub risk: String,
    pub reason: String,
    pub argument_summary: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone)]
pub enum HostEvent {
    Wire(WireMessage),
    Approval(ApprovalRequest),
    Control {
        request_id: String,
        kind: String,
        payload: Value,
    },
    /// Read-only ToolBox observability; it is never a capability execution
    /// channel and cannot cause a local tool call.
    ToolboxWs {
        channel: String,
        kind: String,
        payload: Value,
    },
    Warning(String),
}

#[derive(Debug)]
pub enum HostCommand {
    StartTurn {
        prompt: String,
        /// GUI hosts already own a public Turn identity. Preserve it through
        /// the Host/Core boundary so terminal events can update the same UI
        /// state. Standalone callers leave this empty and Host generates one.
        turn_id: Option<String>,
    },
    Cancel,
    Steer {
        prompt: String,
    },
    FollowUp {
        prompt: String,
    },
    ListAgents {
        request_id: String,
    },
    ListModels {
        request_id: String,
    },
    ListTopics {
        request_id: String,
        agent_id: Option<String>,
    },
    ReadTopic {
        request_id: String,
        topic_id: String,
        agent_id: Option<String>,
    },
    RequestTopicTakeover {
        request_id: String,
        topic_id: String,
        requester_id: String,
        agent_id: Option<String>,
    },
    ListInteractionQueue {
        request_id: String,
    },
    RenameTopic {
        request_id: String,
        topic_id: String,
        title: String,
        agent_id: Option<String>,
    },
    DeleteTopic {
        request_id: String,
        topic_id: String,
        agent_id: Option<String>,
    },
    ReplaceInteractionQueue {
        request_id: String,
        interactions: Vec<Value>,
    },
    RemoveInteractionQueueItem {
        request_id: String,
        interaction_id: String,
    },
    ReplaceInteractionQueueItem {
        request_id: String,
        interaction_id: String,
        prompt: String,
    },
    GetSettings {
        request_id: String,
    },
    UpdateSettings {
        request_id: String,
        update: TuiSettingsUpdate,
    },
    ClearInteractionQueue {
        request_id: String,
    },
    /// The GUI attachment is the only local approval surface. Losing it must
    /// fail closed rather than leave a tool request suspended in memory.
    WorkbenchPresence {
        request_id: String,
        mounted: bool,
    },
    Compact,
    Approval {
        approval_id: String,
        allowed: bool,
        binding: Option<(String, String, String, String)>,
    },
    /// Internal transport from asynchronous ToolBox tasks back into the one
    /// CoreRuntime owner. It is deliberately not exposed by the TUI API.
    Core(WireMessage),
    Shutdown,
}

pub struct RunningHost {
    pub commands: mpsc::UnboundedSender<HostCommand>,
    pub events: mpsc::UnboundedReceiver<HostEvent>,
    pub session_id: String,
    pub topic_id: String,
}

pub fn start(config: HostConfig) -> Result<RunningHost> {
    let toolbox = DirectToolboxHost::new(ToolboxConnection::new(
        &config.server_url,
        config.api_key.clone(),
    )?)?;
    let (commands_tx, commands_rx) = mpsc::unbounded_channel();
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let session_id = next_id("session");
    let owner_id = next_id("owner");
    let store = TopicStore::new(config.data_root.clone());
    store.acquire(&config.agent.id, &config.topic_id, &owner_id)?;
    let task_session = session_id.clone();
    let topic_id = config.topic_id.clone();
    let task_commands = commands_tx.clone();
    tokio::spawn(async move {
        run_host(
            config,
            toolbox,
            task_session,
            commands_rx,
            task_commands,
            events_tx,
            store,
            owner_id,
        )
        .await;
    });
    Ok(RunningHost {
        commands: commands_tx,
        events: events_rx,
        session_id,
        topic_id,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_host(
    config: HostConfig,
    toolbox: DirectToolboxHost,
    session_id: String,
    mut commands_rx: mpsc::UnboundedReceiver<HostCommand>,
    commands_tx: mpsc::UnboundedSender<HostCommand>,
    events_tx: mpsc::UnboundedSender<HostEvent>,
    store: TopicStore,
    owner_id: String,
) {
    let (core_tx, mut core_rx) = mpsc::channel(256);
    let mut core = CoreRuntime::new(core_tx);
    let mut create = WireMessage::new("create-session").with_request_id(next_id("create"));
    create.session_id = Some(session_id.clone());
    // This is intentionally an environment-only integration-test hook: it
    // never persists to shared settings and is not exposed to GUI/TUI users.
    // Core validates the value and limits `required` to the first model round.
    let test_tool_choice = matches!(
        env::var("VCP_AGENT_TEST_TOOL_CHOICE").as_deref(),
        Ok("required")
    )
    .then_some("required");
    create.payload.insert(
        "options".into(),
        json!({
            "vcp": {
                "model": config.model.clone(),
                "toolChoice": test_tool_choice,
                "contextWindow": config.context_window,
                "maxOutput": config.max_output
            }, "systemPrompt": config.agent.system_prompt.clone(),
            "initialMessages": config.initial_messages.clone()
        }),
    );
    if let Err(error) = core.handle(create).await {
        let _ = events_tx.send(HostEvent::Warning(error.to_string()));
        return;
    }
    // `host-ready` used to be an ad-hoc framed message.  The v1.2 GUI
    // boundary only permits final daemon event names, so make readiness a
    // normal event with daemon-generated envelope fields instead.
    let _ = events_tx.send(HostEvent::Wire(WireMessage::new("event").put(
        "event",
        json!({
            "type": "runtime.ready",
            "payload": {
                "agent": config.agent.name.clone(),
                "model": config.model.clone(),
                "theme": config.theme.clone(),
                "workspace": config.workspace.display().to_string(),
                "contextWindow": config.context_window,
                "maxOutput": config.max_output
            }
        }),
    )));
    // Readiness is emitted by the Rust host, never inferred by Electron.
    // The renderer may show these non-sensitive facts but must not probe
    // ToolBox, settings, or a distributed node on its own.
    let _ = events_tx.send(runtime_readiness_event(initial_readiness(&config)));
    spawn_toolbox_readiness_probe(toolbox.clone(), events_tx.clone());
    let observer_tasks =
        spawn_observers(toolbox.clone(), events_tx.clone(), config.api_key.clone());
    let mut approvals: HashMap<String, ApprovalRequest> = HashMap::new();
    let mut model_tasks = HashMap::new();
    let mut turn_requests: HashMap<String, u64> = HashMap::new();
    let mut turn_tokens: HashMap<String, u64> = HashMap::new();
    let mut interaction_queue: Vec<Value> = Vec::new();
    let mut active_turn_id: Option<String> = None;
    let mut shutdown_after_takeover_checkpoint = false;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut approval_tick = tokio::time::interval(Duration::from_secs(1));
    approval_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = approval_tick.tick() => {
                let now = now_millis();
                let expired: Vec<String> = approvals
                    .iter()
                    .filter(|(_, request)| request.expires_at_ms <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for approval_id in expired {
                    if let Some(request) = approvals.remove(&approval_id) {
                        deny_approval(
                            &mut core,
                            &events_tx,
                            request,
                            "local approval timed out",
                        )
                        .await;
                    }
                }
            }
            _ = heartbeat.tick() => {
                if let Err(error) = store.heartbeat(&config.agent.id, &config.topic_id, &owner_id) {
                    let _ = events_tx.send(HostEvent::Warning(format!("Agent Topic lease lost: {error}")));
                    break;
                }
                match store.take_takeover_request(&config.agent.id, &config.topic_id, &owner_id) {
                    Ok(Some(requested_by)) => {
                        let _ = events_tx.send(session_notice_event(
                            &session_id,
                            "topic.takeover_requested",
                            json!({
                                "topicId": config.topic_id,
                                "requestedBy": requested_by,
                                "action": "cancelling-and-releasing"
                            }),
                        ));
                        approvals.clear();
                        shutdown_after_takeover_checkpoint = true;
                        let _ = core.handle(session_command("cancel-turn", &session_id)).await;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let _ = events_tx.send(HostEvent::Warning(format!(
                            "cannot inspect Agent Topic takeover request: {error}"
                        )));
                    }
                }
            }
            Some(command) = commands_rx.recv() => match command {
                HostCommand::Shutdown => break,
                HostCommand::Core(message) => {
                    if message.kind == "model-done" {
                        let turn = message.turn_id.clone().unwrap_or_default();
                        let total = message.value("usage").and_then(|usage| usage.get("total_tokens")).and_then(Value::as_u64).unwrap_or_default();
                        *turn_tokens.entry(turn).or_default() += total;
                    }
                    if let Err(error) = core.handle(message).await { let _ = events_tx.send(HostEvent::Warning(error.to_string())); }
                }
                HostCommand::StartTurn { prompt, turn_id } => {
                    let mut message = WireMessage::new("start-turn").with_request_id(next_id("turn"));
                    let turn_id = turn_id.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| next_id("turn"));
                    if active_turn_id.is_some() {
                        let _ = events_tx.send(turn_rejected_event(&session_id, &turn_id, "session already has an active turn"));
                        continue;
                    }
                    message.session_id = Some(session_id.clone()); message.turn_id = Some(turn_id.clone());
                    message.payload.insert("prompt".into(), Value::String(prompt.clone()));
                    message.payload.insert("compaction".into(), json!({"contextWindow": config.context_window, "maxOutput": config.max_output}));
                    match core.handle(message).await {
                        Ok(()) => {
                            active_turn_id = Some(turn_id.clone());
                            // `start-turn` ACK only confirms framed-command
                            // acceptance. The daemon-owned event is what lets
                            // every UI projection show the user message and
                            // enter its cancellable running state.
                            let _ = events_tx.send(session_event(
                                &session_id,
                                &turn_id,
                                "turn.started",
                                json!({ "prompt": prompt }),
                            ));
                        }
                        Err(error) => { let _ = events_tx.send(HostEvent::Warning(error.to_string())); }
                    }
                }
                HostCommand::Cancel => {
                    approvals.clear();
                    let _ = core.handle(session_command("cancel-turn", &session_id)).await;
                }
                HostCommand::Steer { prompt } => {
                    let id = next_id("interaction");
                    interaction_queue.push(json!({"interactionId":id,"kind":"steer","prompt":prompt}));
                    let _ = core.handle(interaction_command("steer-turn", &session_id, id, prompt)).await;
                }
                HostCommand::FollowUp { prompt } => {
                    let id = next_id("interaction");
                    interaction_queue.push(json!({"interactionId":id,"kind":"follow-up","prompt":prompt}));
                    let _ = core.handle(interaction_command("follow-up-turn", &session_id, id, prompt)).await;
                }
                HostCommand::ListAgents { request_id } => {
                    let _ = events_tx.send(HostEvent::Control { request_id, kind: "agents".into(), payload: json!(list_agents(&config.agents_dir)) });
                }
                HostCommand::ListModels { request_id } => {
                    match toolbox.get_json("/v1/models").await {
                        Ok(value) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "models".into(), payload: json!(parse_models(&value)) }); }
                        Err(error) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "control-error".into(), payload: json!({"operation":"models","error":error.to_string()}) }); }
                    }
                }
                HostCommand::ListTopics { request_id, agent_id } => {
                    let agent_id = agent_id.unwrap_or_else(|| config.agent.id.clone());
                    match store.list(&agent_id) {
                        Ok(topics) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "topics".into(), payload: json!(topics) }); }
                        Err(error) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "control-error".into(), payload: json!({"operation":"topics","error":error.to_string()}) }); }
                    }
                }
                HostCommand::ReadTopic { request_id, topic_id, agent_id } => {
                    let agent_id = agent_id.unwrap_or_else(|| config.agent.id.clone());
                    match store.load_read_only(&agent_id, &topic_id) {
                        Ok(view) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "topic-read-only".into(), payload: view }); }
                        Err(error) => { let _ = events_tx.send(HostEvent::Control { request_id, kind: "control-error".into(), payload: json!({"operation":"topic-read-only","error":error.to_string()}) }); }
                    }
                }
                HostCommand::RequestTopicTakeover { request_id, topic_id, requester_id, agent_id } => {
                    let agent_id = agent_id.unwrap_or_else(|| config.agent.id.clone());
                    let outcome = if agent_id == config.agent.id && topic_id == config.topic_id {
                        Err(anyhow!("TOPIC_ALREADY_OWNED"))
                    } else {
                        store.request_takeover(
                            &agent_id,
                            &topic_id,
                            &requester_id,
                        )
                    };
                    let _ = events_tx.send(control_result(
                        request_id,
                        "topic-takeover-pending",
                        outcome,
                        json!({"topicId":topic_id,"requesterId":requester_id}),
                    ));
                }
                HostCommand::ListInteractionQueue { request_id } => {
                    let _ = events_tx.send(HostEvent::Control { request_id, kind: "interaction-queue".into(), payload: Value::Array(interaction_queue.clone()) });
                }
                HostCommand::RenameTopic { request_id, topic_id, title, agent_id } => {
                    let agent_id = agent_id.unwrap_or_else(|| config.agent.id.clone());
                    let outcome = store.rename(&agent_id, &topic_id, &title);
                    let _ = events_tx.send(control_result(request_id, "topic-renamed", outcome, json!({"topicId":topic_id,"title":title})));
                }
                HostCommand::DeleteTopic { request_id, topic_id, agent_id } => {
                    let agent_id = agent_id.unwrap_or_else(|| config.agent.id.clone());
                    let outcome = store.delete(&agent_id, &topic_id);
                    let _ = events_tx.send(control_result(request_id, "topic-deleted", outcome, json!({"topicId":topic_id})));
                }
                HostCommand::ReplaceInteractionQueue { request_id, interactions } => {
                    replace_interaction_queue(
                        &mut core,
                        &events_tx,
                        &session_id,
                        &mut interaction_queue,
                        request_id,
                        interactions,
                    )
                    .await;
                }
                HostCommand::RemoveInteractionQueueItem {
                    request_id,
                    interaction_id,
                } => {
                    let next = match remove_interaction_item(&interaction_queue, &interaction_id) {
                        Ok(next) => next,
                        Err(error) => {
                            let _ = events_tx.send(control_error(
                                request_id,
                                "remove-interaction-queue-item",
                                error.to_string(),
                            ));
                            continue;
                        }
                    };
                    replace_interaction_queue(
                        &mut core,
                        &events_tx,
                        &session_id,
                        &mut interaction_queue,
                        request_id,
                        next,
                    )
                    .await;
                }
                HostCommand::ReplaceInteractionQueueItem {
                    request_id,
                    interaction_id,
                    prompt,
                } => {
                    let next = match replace_interaction_item(
                        &interaction_queue,
                        &interaction_id,
                        prompt,
                    ) {
                        Ok(next) => next,
                        Err(error) => {
                            let _ = events_tx.send(control_error(
                                request_id,
                                "replace-interaction-queue-item",
                                error.to_string(),
                            ));
                            continue;
                        }
                    };
                    replace_interaction_queue(
                        &mut core,
                        &events_tx,
                        &session_id,
                        &mut interaction_queue,
                        request_id,
                        next,
                    )
                    .await;
                }
                HostCommand::GetSettings { request_id } => {
                    let _ = events_tx.send(HostEvent::Control {
                        request_id,
                        kind: "settings".into(),
                        payload: serde_json::to_value(tui_settings_snapshot(&config))
                            .unwrap_or_else(|_| json!({})),
                    });
                }
                HostCommand::UpdateSettings { request_id, update } => {
                    let outcome = update_shared_settings(&config.settings_path, &update);
                    match outcome {
                        Ok(()) => {
                            let _ = events_tx.send(HostEvent::Control {
                                request_id,
                                kind: "settings-updated".into(),
                                payload: json!({
                                    "restartRequired": true,
                                    "settings": snapshot_after_update(&config, &update),
                                }),
                            });
                        }
                        Err(error) => {
                            let _ = events_tx.send(HostEvent::Control {
                                request_id,
                                kind: "control-error".into(),
                                payload: json!({"operation":"settings-updated","error":error.to_string()}),
                            });
                        }
                    }
                }
                HostCommand::ClearInteractionQueue { request_id } => {
                    interaction_queue.clear();
                    let _ = core.handle(session_command("clear-interaction-queue", &session_id)).await;
                    let _ = events_tx.send(HostEvent::Control { request_id, kind: "interaction-queue".into(), payload: json!([]) });
                }
                HostCommand::WorkbenchPresence { request_id, mounted } => {
                    let mut denied = 0_usize;
                    if !mounted {
                        for (_, request) in approvals.drain() {
                            denied += 1;
                            let mut result = WireMessage::new("tool-result").put("ok", false).put("error", "workbench closed before local approval");
                            result.session_id = Some(request.session_id);
                            result.turn_id = Some(request.turn_id);
                            result.tool_call_id = Some(request.tool_call_id);
                            let denial_event = tool_event(
                                "approval.resolved",
                                &result,
                                json!({
                                    "approvalId": request.approval_id,
                                    "decision": "deny",
                                    "reason": "workbench closed before local approval",
                                }),
                            );
                            let _ = core.handle(result).await;
                            // Closing the only GUI approval surface is an
                            // explicit local denial, not a silent map clear.
                            // Emit the final daemon event after delivering the
                            // deny result to Core so every frontend removes its
                            // card from the same authoritative transition.
                            let _ = events_tx.send(denial_event);
                        }
                    }
                    let _ = events_tx.send(HostEvent::Control {
                        request_id,
                        kind: "workbench-presence".into(),
                        payload: json!({"mounted": mounted, "deniedApprovals": denied}),
                    });
                }
                HostCommand::Compact => {
                    let turn_id = next_id("turn");
                    if active_turn_id.is_some() {
                        let _ = events_tx.send(compaction_failed_event(&session_id, &turn_id, "session already has an active turn"));
                        continue;
                    }
                    let mut message = WireMessage::new("start-turn").with_request_id(next_id("compact"));
                    message.session_id = Some(session_id.clone());
                    message.turn_id = Some(turn_id.clone());
                    message.payload.insert("prompt".into(), Value::String(String::new()));
                    message.payload.insert("compaction".into(), json!({
                        "contextWindow": config.context_window,
                        "maxOutput": config.max_output,
                        "force": true,
                        "only": true
                    }));
                    match core.handle(message).await {
                        Ok(()) => active_turn_id = Some(turn_id),
                        Err(error) => { let _ = events_tx.send(compaction_failed_event(&session_id, &turn_id, error.to_string())); }
                    }
                }
                HostCommand::Approval { approval_id, allowed, binding } => {
                    if let Some(request) = approvals.remove(&approval_id) {
                        let matched = approval_binding_matches(&request, binding.as_ref());
                        let mut result = WireMessage::new("tool-result").put("ok", allowed && matched);
                        result.session_id = Some(request.session_id); result.turn_id = Some(request.turn_id); result.tool_call_id = Some(request.tool_call_id);
                        if !allowed || !matched { result.payload.insert("error".into(), Value::String(if matched { "local approval denied".into() } else { "approval binding mismatch".into() })); }
                        let _ = core.handle(result).await;
                    }
                }
            },
            Some(outbound) = core_rx.recv() => {
                if outbound.kind == "event"
                    && let Some(event_type) = outbound.value("event").and_then(|event| event.get("type")).and_then(Value::as_str)
                    && matches!(event_type, "turn.completed" | "turn.cancelled" | "turn.failed")
                    && outbound.turn_id.as_deref() == active_turn_id.as_deref()
                {
                    active_turn_id = None;
                }
                if outbound.kind == "event"
                    && outbound.value("event").and_then(|event| event.get("type")).and_then(Value::as_str) == Some("interaction.consumed")
                    && let Some(id) = outbound.value("event").and_then(|event| event.pointer("/payload/interactionId")).and_then(Value::as_str)
                {
                    interaction_queue.retain(|item| item.get("interactionId").and_then(Value::as_str) != Some(id));
                }
                if outbound.kind == "ack" {
                    if let Some(result) = outbound.value("result") {
                        if let Some(snapshot) = result.get("snapshot") {
                            if let Err(error) = store.save(&config.agent.id, &config.topic_id, snapshot.clone(), result.get("usage").cloned().unwrap_or(Value::Null), &config.workspace, &config.model) {
                                let _ = events_tx.send(HostEvent::Warning(format!("cannot save Agent Topic: {error}")));
                            }
                        }
                    }
                    if shutdown_after_takeover_checkpoint {
                        break;
                    }
                }
                match outbound.kind.as_str() {
                    "model-request" => {
                        let turn_id = outbound.turn_id.clone().unwrap_or_default();
                        let requests = turn_requests.entry(turn_id.clone()).or_default();
                        let request_limit_hit = config.budget.max_requests_per_turn.is_some_and(|limit| *requests >= limit);
                        let token_limit_hit = config.budget.max_tokens_per_turn.is_some_and(|limit| turn_tokens.get(&turn_id).copied().unwrap_or_default() >= limit);
                        if request_limit_hit || token_limit_hit {
                            let reason = if request_limit_hit { "per-turn model request budget exceeded" } else { "per-turn token budget exceeded" };
                            let _ = events_tx.send(session_event(&session_id, &turn_id, "budget.exceeded", json!({"reason":reason,"requests":*requests,"tokens":turn_tokens.get(&turn_id).copied().unwrap_or_default()})));
                            let mut failure = WireMessage::new("model-error").with_request_id(outbound.request_id.clone().unwrap_or_default()).put("error", reason);
                            failure.session_id = outbound.session_id.clone(); failure.turn_id = outbound.turn_id.clone();
                            let _ = core.handle(failure).await;
                            continue;
                        }
                        *requests += 1;
                        let toolbox = toolbox.clone(); let commands = commands_tx.clone(); let event_tx = events_tx.clone();
                        let request_id = outbound.request_id.clone().unwrap_or_default();
                        let task = tokio::spawn(run_model_request(toolbox, outbound, commands, event_tx, config.api_key.clone()));
                        model_tasks.insert(request_id, task);
                    }
                    "model-abort" => {
                        let request_id = outbound.request_id.clone().unwrap_or_default();
                        if let Some(task) = model_tasks.remove(&request_id) { task.abort(); }
                        let toolbox = toolbox.clone();
                        tokio::spawn(async move { let _ = toolbox.interrupt(&request_id).await; });
                    }
                    "tool-request" if outbound.string("phase") == Some("preflight") => {
                        if let Some(reason) = workspace_violation(&outbound, &config.workspace) {
                            let _ = events_tx.send(tool_event("tool.failed", &outbound, json!({"toolName":"vcp_invoke","detail":reason})));
                            let mut result = WireMessage::new("tool-result").put("ok", false).put("error", reason);
                            result.session_id = outbound.session_id.clone(); result.turn_id = outbound.turn_id.clone(); result.tool_call_id = outbound.tool_call_id.clone();
                            let _ = core.handle(result).await;
                            continue;
                        }
                        let request = approval_from_wire(&outbound, &config.api_key);
                        if let Some(request) = request.as_ref() {
                            let _ = events_tx.send(tool_event("tool.requested", &outbound, json!({"toolName": request.tool_name})));
                        }
                        if request.as_ref().is_some_and(|request| request.risk == "low")
                            || config.permission_mode == PermissionMode::AlwaysApprove {
                            let mut result = WireMessage::new("tool-result").put("ok", true); result.session_id = outbound.session_id.clone(); result.turn_id = outbound.turn_id.clone(); result.tool_call_id = outbound.tool_call_id.clone(); let _ = core.handle(result).await;
                        } else if let Some(request) = request {
                            let _ = events_tx.send(tool_event("tool.awaiting_local_approval", &outbound, json!({"toolName": request.tool_name, "expiresAtMs": request.expires_at_ms})));
                            approvals.insert(request.approval_id.clone(), request.clone());
                            let _ = events_tx.send(HostEvent::Approval(request));
                        }
                    }
                    "tool-request" if outbound.string("phase") == Some("execute") => {
                        let target = outbound.value("arguments").and_then(|value| value.get("toolName")).and_then(Value::as_str).unwrap_or("vcp_invoke");
                        let _ = events_tx.send(tool_event("tool.running", &outbound, json!({"toolName": target})));
                        let toolbox = toolbox.clone(); let commands = commands_tx.clone(); let event_tx = events_tx.clone();
                        tokio::spawn(run_tool_request(toolbox, outbound, commands, event_tx, config.workspace.clone(), config.api_key.clone()));
                    }
                    _ => { let _ = events_tx.send(HostEvent::Wire(outbound)); }
                }
            }
            else => break,
        }
    }
    for (_, task) in model_tasks {
        task.abort();
    }
    for task in observer_tasks {
        task.abort();
    }
    store.release(&config.agent.id, &config.topic_id, &owner_id);
}

fn approval_binding_matches(
    request: &ApprovalRequest,
    binding: Option<&(String, String, String, String)>,
) -> bool {
    binding.is_some_and(|value| {
        value.0 == request.session_id
            && value.1 == request.turn_id
            && value.2 == request.tool_call_id
            && value.3 == request.arguments_hash
    })
}

fn control_result(request_id: String, kind: &str, result: Result<()>, payload: Value) -> HostEvent {
    match result {
        Ok(()) => HostEvent::Control {
            request_id,
            kind: kind.into(),
            payload,
        },
        Err(error) => HostEvent::Control {
            request_id,
            kind: "control-error".into(),
            payload: json!({"operation":kind,"error":error.to_string()}),
        },
    }
}

fn control_error(request_id: String, operation: &str, error: impl Into<String>) -> HostEvent {
    HostEvent::Control {
        request_id,
        kind: "control-error".into(),
        payload: json!({"operation":operation,"error":error.into()}),
    }
}

async fn replace_interaction_queue(
    core: &mut CoreRuntime,
    events: &mpsc::UnboundedSender<HostEvent>,
    session_id: &str,
    current: &mut Vec<Value>,
    request_id: String,
    next: Vec<Value>,
) {
    let mut message = session_command("replace-interaction-queue", session_id);
    message
        .payload
        .insert("interactions".into(), Value::Array(next.clone()));
    match core.handle(message).await {
        Ok(()) => {
            *current = next;
            let _ = events.send(HostEvent::Control {
                request_id,
                kind: "interaction-queue".into(),
                payload: Value::Array(current.clone()),
            });
        }
        Err(error) => {
            let _ = events.send(control_error(
                request_id,
                "replace-interaction-queue",
                error.to_string(),
            ));
        }
    }
}

fn remove_interaction_item(queue: &[Value], interaction_id: &str) -> Result<Vec<Value>> {
    let Some(index) = queue
        .iter()
        .position(|item| item.get("interactionId").and_then(Value::as_str) == Some(interaction_id))
    else {
        return Err(anyhow!("interaction not found: {interaction_id}"));
    };
    let mut next = queue.to_vec();
    next.remove(index);
    Ok(next)
}

fn replace_interaction_item(
    queue: &[Value],
    interaction_id: &str,
    prompt: String,
) -> Result<Vec<Value>> {
    if prompt.trim().is_empty() {
        return Err(anyhow!("replacement prompt is empty"));
    }
    let Some(index) = queue
        .iter()
        .position(|item| item.get("interactionId").and_then(Value::as_str) == Some(interaction_id))
    else {
        return Err(anyhow!("interaction not found: {interaction_id}"));
    };
    let mut next = queue.to_vec();
    let Some(item) = next.get_mut(index).and_then(Value::as_object_mut) else {
        return Err(anyhow!("interaction is not an object: {interaction_id}"));
    };
    item.insert("prompt".into(), Value::String(prompt));
    item.insert("consumed".into(), Value::Bool(false));
    Ok(next)
}

fn spawn_observers(
    toolbox: DirectToolboxHost,
    events: mpsc::UnboundedSender<HostEvent>,
    secret: String,
) -> Vec<tokio::task::JoinHandle<()>> {
    let mut tasks = Vec::new();
    // `/vcp-distributed-server` is a *node registration/execution* socket in
    // ToolBox, not a passive observer channel. Connecting this Agent to it
    // would create a fake capability node, so readiness derives node presence
    // from authoritative VCPLog lifecycle records instead. VCPlog/vcpinfo
    // remain read-only observers.
    for channel in [ToolboxWsChannel::Log, ToolboxWsChannel::Info] {
        let toolbox = toolbox.clone();
        let events = events.clone();
        let secret = secret.clone();
        tasks.push(tokio::spawn(async move {
            let mut delay = 1_u64;
            let mut observed_nodes = HashSet::new();
            loop {
                let name = format!("{channel:?}");
                let result = toolbox
                    .observe_websocket(channel, |event| {
                        let (kind, payload) = match event {
                            ToolboxWsEvent::Log(entry) => {
                                if let Some(capability) = capability_readiness_from_log(&entry.message, &mut observed_nodes) {
                                    let _ = events.send(runtime_readiness_event(json!({"capability": capability})));
                                }
                                ("log".to_string(), json!({"level":entry.level,"source":entry.source,"message":redact_string(&truncate(&entry.message, 16 * 1024), &secret),"timestamp":entry.timestamp}))
                            }
                            ToolboxWsEvent::Info(value) => ("notification".to_string(), redact_known_secret(redact(&value), &secret)),
                            // This is an observation only. The VCPAgent Host
                            // neither sends `tool_approval_response` nor
                            // claims the ToolBox requestId is one of its own
                            // toolCallIds.
                            ToolboxWsEvent::BackendApprovalRequest(value) => ("backend-approval-request".to_string(), redact_known_secret(redact(&value), &secret)),
                            ToolboxWsEvent::DistributedExecutionIgnored(value) => ("distributed-observation".to_string(), redact_known_secret(redact(&value), &secret)),
                        };
                        let _ = events.send(HostEvent::ToolboxWs {
                            channel: name.clone(),
                            kind,
                            payload,
                        });
                    })
                    .await;
                match result {
                    Ok(()) => delay = 1,
                    Err(error) => {
                        let _ = events.send(HostEvent::Warning(format!(
                            "ToolBox {name} WS unavailable; retrying in {delay}s: {error}"
                        )));
                    }
                }
                tokio::time::sleep(Duration::from_secs(delay)).await;
                delay = (delay * 2).min(30);
            }
        }));
    }
    tasks
}

fn initial_readiness(config: &HostConfig) -> Value {
    let server_state = if config.server_url.trim().is_empty() || config.api_key.trim().is_empty() {
        "missing"
    } else {
        "configured"
    };
    let profile_state = if config.agent.id.trim().is_empty() || config.model.trim().is_empty() {
        "missing"
    } else {
        "ready"
    };
    json!({
        "server": {
            "state": server_state,
            "detail": "VCP Server 与 API Key 由共享 VCPChat 设置提供"
        },
        "profile": {
            "state": profile_state,
            "detail": format!("{} · {}", config.agent.name, config.model)
        },
        "toolbox": {
            "state": "checking",
            "detail": "Rust daemon 正在验证 VCPToolBox"
        },
        "capability": {
            "state": "unknown",
            "detail": "等待 VCPLog 的分布式节点生命周期事件"
        }
    })
}

fn runtime_readiness_event(readiness: Value) -> HostEvent {
    HostEvent::Wire(WireMessage::new("event").put(
        "event",
        json!({ "type": "runtime.readiness", "payload": readiness }),
    ))
}

fn spawn_toolbox_readiness_probe(
    toolbox: DirectToolboxHost,
    events: mpsc::UnboundedSender<HostEvent>,
) {
    tokio::spawn(async move {
        // Readiness must settle even when a TCP peer accepts but never
        // responds.  This is a diagnostic probe, not a model/tool request;
        // leaving it in `checking` forever hides the actionable failure from
        // the Workbench and makes an offline ToolBox indistinguishable from a
        // slow start.  Do not include the transport error: it may contain a
        // credential-bearing URL supplied by the user.
        let readiness = match tokio::time::timeout(
            Duration::from_secs(5),
            toolbox.get_json("/v1/models"),
        )
        .await
        {
            Ok(Ok(_)) => json!({
                "toolbox": {
                    "state": "ready",
                    "detail": "VCPToolBox 已响应受认证的模型目录请求"
                }
            }),
            Ok(Err(_)) => json!({
                "toolbox": {
                    "state": "unavailable",
                    "detail": "VCPToolBox 的受认证探测失败；请检查服务、API Key 与网络状态"
                }
            }),
            Err(_) => json!({
                "toolbox": {
                    "state": "unavailable",
                    "detail": "VCPToolBox 在 5 秒内未响应受认证探测；请检查服务、API Key 与网络状态"
                }
            }),
        };
        let _ = events.send(runtime_readiness_event(readiness));
    });
}

fn capability_readiness_from_log(message: &str, nodes: &mut HashSet<String>) -> Option<Value> {
    const PREFIX: &str = "Distributed Server ";
    const CONNECTED: &str = " authenticated and connected.";
    const DISCONNECTED: &str = " disconnected.";
    let node = message.strip_prefix(PREFIX)?;
    let (node, changed) = if let Some(node) = node.strip_suffix(CONNECTED) {
        (node, nodes.insert(node.to_string()))
    } else if let Some(node) = node.strip_suffix(DISCONNECTED) {
        (node, nodes.remove(node))
    } else {
        return None;
    };
    if !changed {
        return None;
    }
    let count = nodes.len();
    Some(json!({
        "state": if count > 0 { "ready" } else { "unavailable" },
        "detail": if count > 0 {
            format!("已从 VCPLog 观察到 {count} 个已连接 DistributedServer capability node（最近：{node}）")
        } else {
            "VCPLog 报告 DistributedServer capability node 已断开".to_string()
        },
        "observedNodes": count
    }))
}

fn session_command(kind: &str, session_id: &str) -> WireMessage {
    let mut message = WireMessage::new(kind).with_request_id(next_id("request"));
    message.session_id = Some(session_id.to_string());
    message
}
fn interaction_command(
    kind: &str,
    session_id: &str,
    interaction_id: String,
    prompt: String,
) -> WireMessage {
    let mut message = session_command(kind, session_id);
    message
        .payload
        .insert("interactionId".into(), Value::String(interaction_id));
    message
        .payload
        .insert("prompt".into(), Value::String(prompt));
    message
}

async fn run_model_request(
    toolbox: DirectToolboxHost,
    request: WireMessage,
    commands: mpsc::UnboundedSender<HostCommand>,
    events: mpsc::UnboundedSender<HostEvent>,
    secret: String,
) {
    let request_id = request.request_id.clone().unwrap_or_default();
    let session_id = request.session_id.clone().unwrap_or_default();
    let body = request.value("body").cloned().unwrap_or(Value::Null);
    let mut usage = None;
    let mut redactor = StreamingSecretRedactor::new(secret.clone());
    let result = toolbox
        .stream_chat(&body, |event| match event {
            ToolboxSseEvent::Json(chunk) => {
                if let Some(value) = chunk.get("usage") {
                    usage = Some(value.clone());
                }
                if let Some(delta) = chunk.pointer("/choices/0/delta").cloned() {
                    let delta = redactor.redact_model_delta(delta);
                    let mut inbound = WireMessage::new("model-delta")
                        .with_request_id(request_id.clone())
                        .put("delta", delta);
                    inbound.session_id = Some(session_id.clone());
                    inbound.turn_id = request.turn_id.clone();
                    let _ = commands.send(HostCommand::Core(inbound));
                }
            }
            ToolboxSseEvent::Done => {}
        })
        .await;
    // The last few bytes of a regular response can be held while we determine
    // whether they start the configured API key. They must reach the Core
    // before `model-done`, otherwise normal text or a final tool-call fragment
    // would be lost.
    if let Some(delta) = redactor.flush_model_delta() {
        let mut inbound = WireMessage::new("model-delta")
            .with_request_id(request_id.clone())
            .put("delta", delta);
        inbound.session_id = Some(session_id.clone());
        inbound.turn_id = request.turn_id.clone();
        let _ = commands.send(HostCommand::Core(inbound));
    }
    let mut done = WireMessage::new(if result.is_ok() {
        "model-done"
    } else {
        "model-error"
    })
    .with_request_id(request_id);
    done.session_id = Some(session_id);
    done.turn_id = request.turn_id.clone();
    if let Err(error) = result {
        done.payload
            .insert("error".into(), Value::String(error.to_string()));
        let _ = events.send(HostEvent::Warning("VCPToolBox model stream failed".into()));
    } else {
        done.payload
            .insert("usage".into(), usage.unwrap_or(Value::Null));
    }
    let _ = commands.send(HostCommand::Core(done));
}

async fn run_tool_request(
    toolbox: DirectToolboxHost,
    request: WireMessage,
    commands: mpsc::UnboundedSender<HostCommand>,
    events: mpsc::UnboundedSender<HostEvent>,
    workspace: PathBuf,
    secret: String,
) {
    let tool_name = request
        .value("arguments")
        .and_then(|value| value.get("toolName"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut arguments = request
        .value("arguments")
        .and_then(|value| value.get("arguments"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    absolutize_workspace_paths(&mut arguments, &workspace);
    let mut inbound = WireMessage::new("tool-result");
    inbound.session_id = request.session_id.clone();
    inbound.turn_id = request.turn_id.clone();
    inbound.tool_call_id = request.tool_call_id.clone();
    let mut invocation = toolbox.invoke_legacy_tool(tool_name, &arguments).await;
    if tool_name.eq_ignore_ascii_case("FileOperator")
        && invocation.as_ref().is_ok_and(|result| {
            !result.ok
                && result.error.as_deref().is_some_and(|error| {
                    error.contains("FileOperator") && error.contains("not found")
                })
        })
    {
        invocation = toolbox
            .invoke_legacy_tool("ServerFileOperator", &arguments)
            .await;
    }
    match invocation {
        Ok(result) => {
            let status = if result.ok {
                "tool.completed"
            } else {
                "tool.failed"
            };
            let detail = result
                .error
                .clone()
                .unwrap_or_else(|| result.output.clone());
            let detail = redact_string(&detail, &secret);
            let output = redact_string(&result.output, &secret);
            let _ = events.send(tool_event(
                status,
                &request,
                json!({"toolName": tool_name, "detail": truncate(&detail, 2_000)}),
            ));
            inbound.payload.insert("ok".into(), Value::Bool(result.ok));
            inbound
                .payload
                .insert("output".into(), Value::String(output));
            if let Some(error) = result.error {
                inbound.payload.insert(
                    "error".into(),
                    Value::String(redact_string(&error, &secret)),
                );
            }
        }
        Err(error) => {
            inbound.payload.insert("ok".into(), Value::Bool(false));
            inbound
                .payload
                .insert("error".into(), Value::String(error.to_string()));
            let _ = events.send(HostEvent::Warning("VCPToolBox tool request failed".into()));
        }
    }
    let _ = commands.send(HostCommand::Core(inbound));
}

fn tool_event(event_type: &str, request: &WireMessage, payload: Value) -> HostEvent {
    let mut event =
        WireMessage::new("event").put("event", json!({ "type": event_type, "payload": payload }));
    event.session_id = request.session_id.clone();
    event.turn_id = request.turn_id.clone();
    event.tool_call_id = request.tool_call_id.clone();
    HostEvent::Wire(event)
}

fn session_event(session_id: &str, turn_id: &str, event_type: &str, payload: Value) -> HostEvent {
    let mut event =
        WireMessage::new("event").put("event", json!({ "type": event_type, "payload": payload }));
    event.session_id = Some(session_id.to_string());
    event.turn_id = Some(turn_id.to_string());
    HostEvent::Wire(event)
}

fn session_notice_event(session_id: &str, event_type: &str, payload: Value) -> HostEvent {
    let mut event =
        WireMessage::new("event").put("event", json!({ "type": event_type, "payload": payload }));
    event.session_id = Some(session_id.to_string());
    HostEvent::Wire(event)
}

fn turn_rejected_event(session_id: &str, turn_id: &str, error: &str) -> HostEvent {
    session_event(
        session_id,
        turn_id,
        "turn.failed",
        json!({ "error": error }),
    )
}

fn compaction_failed_event(session_id: &str, turn_id: &str, error: impl Into<String>) -> HostEvent {
    session_event(
        session_id,
        turn_id,
        "context.compaction.failed",
        json!({ "error": error.into() }),
    )
}

fn approval_from_wire(message: &WireMessage, secret: &str) -> Option<ApprovalRequest> {
    let arguments = message.value("arguments")?;
    let tool_name = arguments
        .get("toolName")
        .and_then(Value::as_str)?
        .to_string();
    let bytes = serde_json::to_vec(arguments).ok()?;
    let arguments_hash = format!("{:x}", Sha256::digest(bytes));
    let (risk, reason) = classify_tool_risk(&tool_name, arguments.get("arguments"));
    Some(ApprovalRequest {
        approval_id: next_id("approval"),
        session_id: message.session_id.clone()?,
        turn_id: message.turn_id.clone()?,
        tool_call_id: message.tool_call_id.clone()?,
        arguments_hash,
        tool_name,
        risk,
        reason,
        argument_summary: redact_known_secret(redact(arguments), secret).to_string(),
        expires_at_ms: now_millis().saturating_add(LOCAL_APPROVAL_TIMEOUT.as_millis() as u64),
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn deny_approval(
    core: &mut CoreRuntime,
    events: &mpsc::UnboundedSender<HostEvent>,
    request: ApprovalRequest,
    reason: &str,
) {
    let mut result = WireMessage::new("tool-result")
        .put("ok", false)
        .put("error", reason);
    result.session_id = Some(request.session_id);
    result.turn_id = Some(request.turn_id);
    result.tool_call_id = Some(request.tool_call_id);
    let denial_event = tool_event(
        "approval.resolved",
        &result,
        json!({
            "approvalId": request.approval_id,
            "decision": "deny",
            "reason": reason,
        }),
    );
    let _ = core.handle(result).await;
    let _ = events.send(denial_event);
}

fn classify_tool_risk(tool: &str, arguments: Option<&Value>) -> (String, String) {
    let arguments = arguments.unwrap_or(&Value::Null);
    let command = arguments
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| {
            key.eq_ignore_ascii_case("action") || key.to_lowercase().starts_with("command")
        })
        .filter_map(|(_, value)| value.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let read_only = (tool.eq_ignore_ascii_case("FileOperator")
        || tool.eq_ignore_ascii_case("ServerFileOperator"))
        && matches!(
            command.to_lowercase().as_str(),
            "readfile"
                | "readmultiplefiles"
                | "listdirectory"
                | "listfiles"
                | "fileinfo"
                | "searchfiles"
                | "getdirectorytree"
        );
    if read_only {
        return (
            "low".into(),
            format!("workspace-scoped FileOperator read command: {command}"),
        );
    }
    let value = format!("{tool} {command}").to_lowercase();
    let high = [
        "shell",
        "powershell",
        "bash",
        "terminal",
        "exec",
        "write",
        "edit",
        "append",
        "create",
        "copy",
        "delete",
        "remove",
        "move",
        "rename",
        "git",
        "browser",
        "chrome",
        "network",
        "download",
        "upload",
        "install",
        "credential",
        "secret",
        "token",
        "everything",
        "format",
        "kill",
        "shutdown",
    ]
    .iter()
    .any(|needle| value.contains(needle))
        || contains_suspicious_path(arguments);
    if high {
        (
            "high".into(),
            "ToolBox target, command or path requires explicit review".into(),
        )
    } else {
        (
            "medium".into(),
            "VCPToolBox operation has no public per-tool schema; local confirmation required"
                .into(),
        )
    }
}

fn contains_suspicious_path(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let path_key = key.to_lowercase().contains("path")
                || matches!(key.to_lowercase().as_str(), "source" | "destination");
            (path_key
                && value.as_str().is_some_and(|path| {
                    path.contains("..")
                        || path.starts_with('/')
                        || path.starts_with('\\')
                        || (path.len() > 2 && path.as_bytes()[1] == b':')
                }))
                || contains_suspicious_path(value)
        }),
        Value::Array(values) => values.iter().any(contains_suspicious_path),
        _ => false,
    }
}

fn workspace_violation(message: &WireMessage, workspace: &Path) -> Option<String> {
    let arguments = message.value("arguments")?.get("arguments")?;
    let mut paths = Vec::new();
    collect_path_arguments(arguments, &mut paths);
    for value in paths {
        let candidate = PathBuf::from(value);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            workspace.join(candidate)
        };
        let normalized = normalize_lexical(&resolved);
        if !normalized.starts_with(workspace) {
            return Some(format!(
                "tool path escapes workspace: {}",
                resolved.display()
            ));
        }
        if let Ok(canonical) = fs::canonicalize(&normalized)
            && !canonical.starts_with(workspace)
        {
            return Some(format!(
                "tool path resolves outside workspace: {}",
                canonical.display()
            ));
        }
    }
    None
}

fn collect_path_arguments<'a>(value: &'a Value, output: &mut Vec<&'a str>) {
    match value {
        Value::Object(object) => {
            for (key, value) in object {
                let lower = key.to_lowercase();
                if (lower.contains("path") || matches!(lower.as_str(), "source" | "destination"))
                    && let Some(path) = value.as_str()
                {
                    output.push(path);
                }
                collect_path_arguments(value, output);
            }
        }
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_path_arguments(value, output)),
        _ => {}
    }
}

fn absolutize_workspace_paths(arguments: &mut Map<String, Value>, workspace: &Path) {
    for (key, value) in arguments {
        let lower = key.to_lowercase();
        let path_key = lower.contains("path") || matches!(lower.as_str(), "source" | "destination");
        if path_key && let Value::String(path) = value {
            let candidate = PathBuf::from(path.as_str());
            if !candidate.is_absolute() {
                *path = normalize_lexical(&workspace.join(candidate))
                    .display()
                    .to_string();
            }
        } else if let Value::Object(nested) = value {
            absolutize_workspace_paths(nested, workspace);
        } else if let Value::Array(values) = value {
            for nested in values {
                if let Value::Object(object) = nested {
                    absolutize_workspace_paths(object, workspace);
                }
            }
        }
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

fn truncate(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &value[..end])
}

fn redact(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let hidden = ["key", "token", "secret", "password", "authorization"]
                        .iter()
                        .any(|needle| key.to_lowercase().contains(needle));
                    (
                        key.clone(),
                        if hidden {
                            Value::String("[REDACTED]".into())
                        } else {
                            redact(value)
                        },
                    )
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(redact).collect()),
        other => other.clone(),
    }
}

fn redact_known_secret(value: Value, secret: &str) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, redact_known_secret(value, secret)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_known_secret(value, secret))
                .collect(),
        ),
        Value::String(value) => Value::String(redact_string(&value, secret)),
        other => other,
    }
}

fn redact_string(value: &str, secret: &str) -> String {
    if secret.is_empty() {
        value.to_string()
    } else {
        value.replace(secret, "[REDACTED]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::{Duration, timeout};

    #[test]
    fn redaction_and_nova_fallback_never_expose_credentials() {
        let value = json!({ "apiKey": "secret", "nested": { "token": "also-secret" } });
        assert_eq!(redact(&value)["apiKey"], "[REDACTED]");
        assert_eq!(redact(&value)["nested"]["token"], "[REDACTED]");
        assert_eq!(
            redact_known_secret(json!({"url":"http://localhost/pw=123456/x"}), "123456")["url"],
            "http://localhost/pw=[REDACTED]/x"
        );
        let agent = load_agent(Path::new("this-directory-does-not-exist"), "Nova").unwrap();
        assert_eq!(agent.name, "Nova");
        assert_eq!(agent.system_prompt, "{{Nova}}");
    }

    #[test]
    fn shared_agent_output_limits_are_loaded_without_creating_a_second_profile() {
        let root = env::temp_dir().join(format!("vcp-host-agent-limit-test-{}", next_id("case")));
        let agents = root.join("Agents");
        let nova_dir = agents.join("Nova");
        fs::create_dir_all(&nova_dir).unwrap();
        fs::write(
            nova_dir.join("config.json"),
            r#"{"name":"Nova","model":"gpt-5.6-terra","systemPrompt":"{{Nova}}","contextTokenLimit":128000,"maxOutputTokens":4096}"#,
        )
        .unwrap();

        let agent = load_agent(&agents, "nova").unwrap();
        assert_eq!(agent.name, "Nova");
        assert_eq!(agent.system_prompt, "{{Nova}}");
        assert_eq!(agent.context_window, 128000);
        assert_eq!(agent.max_output, 4096);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn streaming_redaction_never_leaks_secret_across_sse_deltas() {
        let mut redactor = StreamingSecretRedactor::new("123456".into());
        let first = redactor.redact_model_delta(json!({
            "content": "密钥片段：123",
            "reasoning_content": "检查到 12"
        }));
        let second = redactor.redact_model_delta(json!({
            "content": "456，回答继续。",
            "reasoning_content": "3456，已隐藏。"
        }));
        let final_delta = redactor.flush_model_delta().unwrap_or_else(|| json!({}));
        let visible = format!("{first}{second}{final_delta}");

        assert!(!visible.contains("123456"));
        assert!(visible.contains("[REDACTED]"));
        assert!(visible.contains("回答继续。"));
        assert!(visible.contains("已隐藏。"));
    }

    #[test]
    fn streaming_redaction_flushes_incomplete_non_secret_text() {
        let mut redactor = StreamingSecretRedactor::new("123456".into());
        let first = redactor.redact_model_delta(json!({ "content": "末尾是 12" }));
        let final_delta = redactor.flush_model_delta().unwrap();
        assert_eq!(first["content"], "末尾是 ");
        assert_eq!(final_delta["content"], "12");
    }

    #[test]
    fn settings_catalog_and_approval_binding_are_fail_closed() {
        let root = env::temp_dir().join(format!("vcp-host-settings-test-{}", next_id("case")));
        fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        fs::write(&settings, r#"{"unknown":{"keep":true},"vcpApiKey":"old"}"#).unwrap();
        update_shared_settings(
            &settings,
            &TuiSettingsUpdate {
                default_model: Some("gpt-5.6-terra".into()),
                theme: Some("TokyoNight".into()),
                ..TuiSettingsUpdate::default()
            },
        )
        .unwrap();
        let value: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(value["unknown"]["keep"], true);
        assert_eq!(value["vcpApiKey"], "old");
        assert_eq!(
            value["agentRuntime"]["tui"]["defaultModel"],
            "gpt-5.6-terra"
        );
        assert!(settings.with_extension("bak").exists());

        let models = parse_models(
            &json!({"data":[{"id":"b"},{"id":"a","context_window":128000,"max_output_tokens":8192}]}),
        );
        assert_eq!(models[0].id, "a");
        assert_eq!(models[0].context_window, Some(128000));

        let request = ApprovalRequest {
            approval_id: "a".into(),
            session_id: "s".into(),
            turn_id: "t".into(),
            tool_call_id: "c".into(),
            arguments_hash: "h".into(),
            tool_name: "tool".into(),
            risk: "high".into(),
            reason: String::new(),
            argument_summary: String::new(),
            expires_at_ms: now_millis().saturating_add(60_000),
        };
        assert!(!approval_binding_matches(&request, None));
        assert!(!approval_binding_matches(
            &request,
            Some(&("s".into(), "t".into(), "c".into(), "wrong".into()))
        ));
        assert!(approval_binding_matches(
            &request,
            Some(&("s".into(), "t".into(), "c".into(), "h".into()))
        ));
        let (risk, _) = classify_tool_risk(
            "FileOperator",
            Some(&json!({"command":"ReadFile","path":"C:\\workspace\\package.json"})),
        );
        assert_eq!(risk, "low");
        let workspace = env::current_dir().unwrap();
        let mut paths = serde_json::from_value::<Map<String, Value>>(json!({
            "filePath": "package.json",
            "nested": {"searchPath":"src"},
            "url": "https://example.com/file"
        }))
        .unwrap();
        absolutize_workspace_paths(&mut paths, &workspace);
        assert_eq!(
            PathBuf::from(paths["filePath"].as_str().unwrap()),
            workspace.join("package.json")
        );
        assert_eq!(
            PathBuf::from(paths["nested"]["searchPath"].as_str().unwrap()),
            workspace.join("src")
        );
        assert_eq!(paths["url"], "https://example.com/file");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn distributed_node_readiness_uses_log_lifecycle_without_registering_a_node() {
        let mut nodes = HashSet::new();
        let connected = capability_readiness_from_log(
            "Distributed Server dist-real authenticated and connected.",
            &mut nodes,
        )
        .expect("connect lifecycle");
        assert_eq!(
            connected.get("state").and_then(Value::as_str),
            Some("ready")
        );
        assert_eq!(
            connected.get("observedNodes").and_then(Value::as_u64),
            Some(1)
        );
        assert!(
            capability_readiness_from_log(
                "Distributed Server dist-real authenticated and connected.",
                &mut nodes,
            )
            .is_none()
        );
        let disconnected =
            capability_readiness_from_log("Distributed Server dist-real disconnected.", &mut nodes)
                .expect("disconnect lifecycle");
        assert_eq!(
            disconnected.get("state").and_then(Value::as_str),
            Some("unavailable")
        );
        assert_eq!(
            disconnected.get("observedNodes").and_then(Value::as_u64),
            Some(0)
        );
    }

    #[test]
    fn interaction_queue_item_updates_are_id_bound_and_fail_closed() {
        let queue = vec![
            json!({"interactionId":"one","kind":"steer","prompt":"first"}),
            json!({"interactionId":"two","kind":"follow-up","prompt":"second","consumed":true}),
        ];

        let replaced = replace_interaction_item(&queue, "two", "updated".into()).unwrap();
        assert_eq!(replaced.len(), 2);
        assert_eq!(replaced[1]["prompt"], "updated");
        assert_eq!(replaced[1]["consumed"], false);
        assert_eq!(queue[1]["prompt"], "second");

        let removed = remove_interaction_item(&replaced, "one").unwrap();
        assert_eq!(
            removed,
            vec![json!({
                "interactionId":"two",
                "kind":"follow-up",
                "prompt":"updated",
                "consumed":false
            })]
        );

        assert!(remove_interaction_item(&queue, "missing").is_err());
        assert!(replace_interaction_item(&queue, "missing", "x".into()).is_err());
        assert!(replace_interaction_item(&queue, "one", "  ".into()).is_err());
    }

    #[test]
    fn local_approval_deadline_is_created_by_the_host() {
        let before = now_millis();
        let mut message = WireMessage::new("tool-request");
        message.session_id = Some("session-1".into());
        message.turn_id = Some("turn-1".into());
        message.tool_call_id = Some("tool-1".into());
        message.payload.insert(
            "arguments".into(),
            json!({"toolName":"PowerShellExecutor","arguments":{"command":"Get-Location"}}),
        );
        let request = approval_from_wire(&message, "secret").expect("approval request");
        let after = now_millis();
        assert!(request.expires_at_ms >= before + 59_000);
        assert!(request.expires_at_ms <= after + 61_000);
    }

    #[tokio::test]
    async fn direct_host_streams_sse_into_the_rust_core() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut request = [0_u8; 8192];
                    let _ = socket.read(&mut request).await;
                    let body = concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"，Rust Host\"}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7}}\n\n",
                        "data: [DONE]\n\n"
                    );
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        let config = HostConfig {
            settings_path: PathBuf::from("settings.json"),
            agents_dir: PathBuf::from("Agents"),
            server_url: format!("http://{address}"),
            api_key: "test-key".into(),
            model: "test-model".into(),
            agent: nova(),
            workspace: env::current_dir().unwrap(),
            permission_mode: PermissionMode::AlwaysApprove,
            context_window: 0,
            max_output: 0,
            data_root: env::temp_dir().join(format!("vcp-agent-host-test-{}", std::process::id())),
            topic_id: "topic-test".into(),
            initial_messages: Vec::new(),
            budget: BudgetLimits::default(),
            theme: "Auto".into(),
        };
        let mut host = start(config).unwrap();
        host.commands
            .send(HostCommand::StartTurn {
                prompt: "介绍一下自己".into(),
                turn_id: None,
            })
            .unwrap();
        let observed = timeout(Duration::from_secs(3), async {
            let mut text = String::new();
            let mut started_prompt = None;
            while let Some(event) = host.events.recv().await {
                if let HostEvent::Wire(message) = event
                    && message.kind == "event"
                {
                    let event_type = message
                        .value("event")
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str);
                    if event_type == Some("turn.started") {
                        started_prompt = message
                            .value("event")
                            .and_then(|event| event.pointer("/payload/prompt"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                    } else if event_type == Some("assistant.delta") {
                        text.push_str(
                            message
                                .value("event")
                                .and_then(|event| event.pointer("/payload/text"))
                                .and_then(Value::as_str)
                                .unwrap_or(""),
                        );
                        if text.contains("Rust Host") {
                            return (text, started_prompt);
                        }
                    }
                }
            }
            (text, started_prompt)
        })
        .await
        .unwrap();
        assert_eq!(observed.0, "你好，Rust Host");
        assert_eq!(observed.1.as_deref(), Some("介绍一下自己"));
        let _ = host.commands.send(HostCommand::Shutdown);
    }
}
