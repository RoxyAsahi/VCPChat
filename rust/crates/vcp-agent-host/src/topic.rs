//! Bounded, crash-safe Agent Topic storage shared by standalone and daemon.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use vcp_shadow_index::ShadowDocument;

const MAX_HISTORY_ENTRIES: usize = 400;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 8 * 1024 * 1024;
const LEASE: Duration = Duration::from_secs(60);
const LEGACY_MIGRATION_VERSION: u32 = 1;
const LEGACY_MIGRATION_MARKER: &str = ".agent-runtime-migration-v1.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopicMetadata {
    pub id: String,
    pub title: String,
    pub agent_id: String,
    pub model: String,
    pub workspace_ref: String,
    pub updated_at: u64,
    pub read_only: bool,
    pub in_use: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_from: Option<String>,
}

#[derive(Clone)]
pub struct TopicStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lock {
    owner_id: String,
    pid: u32,
    acquired_at_ms: u64,
    heartbeat_at_ms: u64,
}

/// Windows is the release-blocking platform.  A lease whose owner process is
/// definitely gone is safe to reclaim immediately; waiting a full lease after
/// a daemon crash would make the explicit GUI reconnect action misleading.
/// Access-denied and unknown platform cases deliberately remain live until the
/// heartbeat expires so a failed liveness probe can never create two writers.
#[cfg(windows)]
fn pid_is_definitely_dead(pid: u32) -> bool {
    use std::ffi::c_void;

    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x0000_1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, exit_code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    if pid == 0 {
        return true;
    }
    let handle = unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // ERROR_ACCESS_DENIED is intentionally treated as alive/unknown.
        return unsafe { GetLastError() } == ERROR_INVALID_PARAMETER;
    }
    let mut exit_code = STILL_ACTIVE;
    let read_exit_code = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    let _ = unsafe { CloseHandle(handle) };
    read_exit_code && exit_code != STILL_ACTIVE
}

#[cfg(not(windows))]
fn pid_is_definitely_dead(_pid: u32) -> bool {
    // Other platforms retain the conservative heartbeat-only fallback until
    // they receive an equally reliable native liveness implementation.
    false
}

fn lock_is_stale(lock: &Lock) -> bool {
    now().saturating_sub(lock.heartbeat_at_ms) > LEASE.as_millis() as u64
        || pid_is_definitely_dead(lock.pid)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TakeoverRequest {
    requested_by: String,
    requested_at_ms: u64,
    owner_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMigrationMarker {
    version: u32,
    completed_at: u64,
    source_root: String,
    migrated_count: usize,
}

impl TopicStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Move Topic directories created by the pre-CDS layout out of
    /// `AppData/UserData`. Only directories carrying the Agent checkpoint
    /// marker are eligible, so ordinary VChat Topics are never touched.
    pub fn migrate_legacy_from(&self, legacy_root: &Path) -> Result<usize> {
        if legacy_root == self.root {
            return Ok(0);
        }

        let marker_path = self.root.join(LEGACY_MIGRATION_MARKER);
        if marker_path.is_file() {
            let marker: LegacyMigrationMarker =
                serde_json::from_str(&fs::read_to_string(&marker_path)?)
                    .context("invalid Agent Runtime migration marker")?;
            if marker.version != LEGACY_MIGRATION_VERSION {
                return Err(anyhow!(
                    "unsupported Agent Runtime migration marker version"
                ));
            }
            return Ok(0);
        }

        fs::create_dir_all(&self.root)?;

        let mut migrated = 0;
        let owners = match fs::read_dir(legacy_root) {
            Ok(owners) => Some(owners),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        for owner in owners
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_dir())
        {
            let owner_id = owner.file_name().to_string_lossy().to_string();
            let legacy_topics = owner.path().join("topics");
            let topics = match fs::read_dir(&legacy_topics) {
                Ok(topics) => topics,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };

            for topic in topics.flatten().filter(|entry| entry.path().is_dir()) {
                let source = topic.path();
                if !has_checkpoint(&source) {
                    continue;
                }
                if live_lock(&source.join(".vcp-agent.topic-lock.json")) {
                    return Err(anyhow!(
                        "legacy Agent Topic is in use and cannot be migrated: {}",
                        source.display()
                    ));
                }

                let topic_id = topic.file_name().to_string_lossy().to_string();
                let destination = self.directory(&owner_id, &topic_id)?;
                if destination.exists() {
                    return Err(anyhow!(
                        "Agent Topic migration destination already exists: {}",
                        destination.display()
                    ));
                }
                let parent = destination
                    .parent()
                    .context("Agent Topic migration destination has no parent")?;
                fs::create_dir_all(parent)?;
                fs::rename(&source, &destination).with_context(|| {
                    format!(
                        "failed to migrate Agent Topic {} to {}",
                        source.display(),
                        destination.display()
                    )
                })?;
                migrated += 1;
            }

            remove_if_empty(&legacy_topics);
            remove_if_empty(&owner.path());
        }
        atomic_json(
            &marker_path,
            &LegacyMigrationMarker {
                version: LEGACY_MIGRATION_VERSION,
                completed_at: now(),
                source_root: legacy_root.display().to_string(),
                migrated_count: migrated,
            },
        )?;
        Ok(migrated)
    }

    pub fn directory(&self, agent_id: &str, topic_id: &str) -> Result<PathBuf> {
        Ok(self
            .root
            .join(safe(agent_id, "agent id")?)
            .join("topics")
            .join(safe(topic_id, "topic id")?))
    }

    pub fn attachments_directory(&self, agent_id: &str, topic_id: &str) -> Result<PathBuf> {
        Ok(self.directory(agent_id, topic_id)?.join("attachments"))
    }
    pub fn acquire(&self, agent_id: &str, topic_id: &str, owner_id: &str) -> Result<()> {
        let directory = self.directory(agent_id, topic_id)?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(".vcp-agent.topic-lock.json");
        let lock = Lock {
            owner_id: safe(owner_id, "owner id")?,
            pid: std::process::id(),
            acquired_at_ms: now(),
            heartbeat_at_ms: now(),
        };
        match write_new(&path, &lock) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let stale = fs::read_to_string(&path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Lock>(&raw).ok())
                    .map(|existing| lock_is_stale(&existing))
                    .unwrap_or(true);
                if !stale {
                    return Err(anyhow!("TOPIC_IN_USE: {topic_id}"));
                }
                fs::remove_file(&path).ok();
                write_new(&path, &lock)
                    .with_context(|| format!("could not reclaim topic {topic_id}"))
            }
            Err(error) => Err(error.into()),
        }
    }
    pub fn heartbeat(&self, agent_id: &str, topic_id: &str, owner_id: &str) -> Result<()> {
        let path = self
            .directory(agent_id, topic_id)?
            .join(".vcp-agent.topic-lock.json");
        let mut lock: Lock =
            serde_json::from_str(&fs::read_to_string(&path)?).context("invalid topic lock")?;
        if lock.owner_id != owner_id {
            return Err(anyhow!("TOPIC_NOT_OWNER"));
        }
        lock.heartbeat_at_ms = now();
        atomic_json(&path, &lock)
    }
    pub fn request_takeover(
        &self,
        agent_id: &str,
        topic_id: &str,
        requested_by: &str,
    ) -> Result<()> {
        let directory = self.directory(agent_id, topic_id)?;
        let lock_path = directory.join(".vcp-agent.topic-lock.json");
        let lock: Lock =
            serde_json::from_str(&fs::read_to_string(&lock_path)?).context("invalid topic lock")?;
        if lock_is_stale(&lock) {
            return Err(anyhow!("TOPIC_LEASE_EXPIRED: retry resume"));
        }
        let requested_by = safe(requested_by, "requester id")?;
        if lock.owner_id == requested_by {
            return Err(anyhow!("TOPIC_ALREADY_OWNED"));
        }
        atomic_json(
            &directory.join(".vcp-agent.takeover.json"),
            &TakeoverRequest {
                requested_by,
                requested_at_ms: now(),
                owner_id: lock.owner_id,
            },
        )
    }
    pub fn take_takeover_request(
        &self,
        agent_id: &str,
        topic_id: &str,
        owner_id: &str,
    ) -> Result<Option<String>> {
        let path = self
            .directory(agent_id, topic_id)?
            .join(".vcp-agent.takeover.json");
        let request: TakeoverRequest = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).context("invalid takeover request")?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if request.owner_id != owner_id {
            return Ok(None);
        }
        fs::remove_file(path)?;
        Ok(Some(request.requested_by))
    }
    pub fn release(&self, agent_id: &str, topic_id: &str, owner_id: &str) {
        let Ok(path) = self
            .directory(agent_id, topic_id)
            .map(|directory| directory.join(".vcp-agent.topic-lock.json"))
        else {
            return;
        };
        let owned = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Lock>(&raw).ok())
            .is_some_and(|lock| lock.owner_id == owner_id);
        if owned {
            let _ = fs::remove_file(path);
            if let Ok(directory) = self.directory(agent_id, topic_id) {
                let _ = fs::remove_file(directory.join(".vcp-agent.takeover.json"));
                // Catalog-only daemon processes acquire a Topic lease before
                // a user creates a Session. Once released, an empty directory
                // is neither resumable nor a real user conversation.
                remove_if_empty(&directory);
            }
        }
    }
    pub fn load_snapshot(&self, agent_id: &str, topic_id: &str) -> Result<Vec<Value>> {
        let path = self.directory(agent_id, topic_id)?.join("agent-state.json");
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let state: Value = serde_json::from_str(&raw).context("invalid agent-state.json")?;
        Ok(state
            .pointer("/snapshot/messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }
    pub fn load_read_only(&self, agent_id: &str, topic_id: &str) -> Result<Value> {
        let directory = self.directory(agent_id, topic_id)?;
        let state = fs::read_to_string(directory.join("agent-state.json"))
            .context("Agent Topic has no checkpoint")?;
        let state: Value = serde_json::from_str(&state).context("invalid agent-state.json")?;
        let history = fs::read_to_string(directory.join("history.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_else(|| json!([]));
        Ok(json!({
            "readOnly": true,
            "topicId": topic_id,
            "agentId": agent_id,
            "state": redact(state),
            "history": redact(history)
        }))
    }
    pub fn latest_topic(&self, agent_id: &str) -> Result<Option<String>> {
        let root = self.root.join(safe(agent_id, "agent id")?).join("topics");
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut newest = None;
        // Control-plane transports can create a short-lived empty Topic. Only
        // checkpoints are user conversations eligible for `/resume latest`.
        for entry in entries
            .flatten()
            .filter(|entry| entry.path().is_dir() && has_checkpoint(&entry.path()))
        {
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if newest
                .as_ref()
                .is_none_or(|(time, _): &(SystemTime, String)| modified > *time)
            {
                newest = Some((modified, entry.file_name().to_string_lossy().to_string()));
            }
        }
        Ok(newest.map(|(_, id)| id))
    }

    pub fn list(&self, agent_id: &str) -> Result<Vec<TopicMetadata>> {
        let root = self.root.join(safe(agent_id, "agent id")?).join("topics");
        let entries = match fs::read_dir(root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut topics = Vec::new();
        // The active Session is projected separately. Persisted Topic rows
        // must be recoverable checkpoints, never empty control placeholders.
        for entry in entries
            .flatten()
            .filter(|entry| entry.path().is_dir() && has_checkpoint(&entry.path()))
        {
            let id = entry.file_name().to_string_lossy().to_string();
            let state = fs::read_to_string(entry.path().join("agent-state.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .unwrap_or_else(|| json!({}));
            let lock = live_lock(&entry.path().join(".vcp-agent.topic-lock.json"));
            topics.push(TopicMetadata {
                id: id.clone(),
                title: state
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                agent_id: agent_id.to_string(),
                model: state
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                workspace_ref: state
                    .get("workspaceRef")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: state
                    .get("updatedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                read_only: lock,
                in_use: lock,
                continuation_from: state
                    .get("continuationFrom")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            });
        }
        topics.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(topics)
    }

    pub fn rename(&self, agent_id: &str, topic_id: &str, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err(anyhow!("invalid topic title"));
        }
        let directory = self.directory(agent_id, topic_id)?;
        ensure_not_live(&directory)?;
        let path = directory.join("agent-state.json");
        let mut state: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
        state["title"] = Value::String(title.to_string());
        state["updatedAt"] = Value::from(now());
        atomic_json(&path, &state)
    }

    pub fn delete(&self, agent_id: &str, topic_id: &str) -> Result<()> {
        let directory = self.directory(agent_id, topic_id)?;
        ensure_not_live(&directory)?;
        if directory.exists() {
            fs::remove_dir_all(directory)?;
        }
        Ok(())
    }

    /// Project the bounded, redacted UI history into disposable search
    /// documents. Recovery never calls this path: `agent-state.json` remains
    /// the sole checkpoint source.
    pub fn search_documents_for_topic(
        &self,
        agent_id: &str,
        topic_id: &str,
    ) -> Result<Vec<ShadowDocument>> {
        let directory = self.directory(agent_id, topic_id)?;
        let state: Value =
            serde_json::from_str(&fs::read_to_string(directory.join("agent-state.json"))?)?;
        let history_path = directory.join("history.json");
        let history: Vec<Value> = match fs::read_to_string(&history_path) {
            Ok(raw) => serde_json::from_str(&raw)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => snapshot_to_history(
                state
                    .pointer("/snapshot/messages")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            ),
            Err(error) => return Err(error.into()),
        };
        let title = state
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("新会话")
            .to_string();
        let documents = history
            .into_iter()
            .enumerate()
            .filter_map(|(ordinal, message)| {
                let role = message.get("role")?.as_str()?.to_string();
                let content = message.get("content")?.as_str()?.to_string();
                let message_id = message
                    .get("messageId")
                    .or_else(|| message.get("id"))?
                    .as_str()?
                    .to_string();
                let turn_id = message
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let timestamp = message
                    .get("timestamp")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                Some(ShadowDocument {
                    owner_id: agent_id.to_string(),
                    topic_id: topic_id.to_string(),
                    topic_title: title.clone(),
                    message_id,
                    turn_id,
                    ordinal: u64::try_from(ordinal).unwrap_or(u64::MAX),
                    timestamp,
                    role,
                    content,
                })
            })
            .collect();
        Ok(documents)
    }

    pub fn all_search_documents(&self) -> Result<Vec<ShadowDocument>> {
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }
        let mut documents = Vec::new();
        for owner in fs::read_dir(&self.root)?.flatten().filter(|entry| {
            entry.path().is_dir() && entry.file_name().to_string_lossy() != ".index"
        }) {
            let agent_id = owner.file_name().to_string_lossy().to_string();
            for topic in self.list(&agent_id)? {
                documents.extend(self.search_documents_for_topic(&agent_id, &topic.id)?);
            }
        }
        Ok(documents)
    }
    pub fn save(
        &self,
        agent_id: &str,
        topic_id: &str,
        snapshot: Value,
        usage: Value,
        workspace: &Path,
        model: &str,
    ) -> Result<()> {
        let directory = self.directory(agent_id, topic_id)?;
        fs::create_dir_all(&directory)?;
        let messages = snapshot
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let title = default_title(&messages);
        let checkpoint = json!({"version":1,"title":title,"snapshot":{"version":1,"messages":sanitize_snapshot(messages)},"usage":redact(usage),"workspaceRef":workspace.display().to_string(),"model":model,"updatedAt":now()});
        let checkpoint_bytes = serde_json::to_vec(&checkpoint)?;
        if checkpoint_bytes.len() > MAX_CHECKPOINT_BYTES {
            return Err(anyhow!("checkpoint exceeds 8 MiB safety limit"));
        }
        atomic_json(&directory.join("agent-state.json"), &checkpoint)?;
        let mut history = snapshot_to_history(
            checkpoint
                .pointer("/snapshot/messages")
                .and_then(Value::as_array)
                .unwrap_or(&Vec::new()),
        );
        let mut overflow = Vec::new();
        while history.len() > MAX_HISTORY_ENTRIES
            || serde_json::to_vec(&history)?.len() > MAX_HISTORY_BYTES
        {
            overflow.push(history.remove(0));
        }
        if !overflow.is_empty() {
            let continuation_id = format!("{topic_id}-continuation-{}", now());
            let continuation_dir = self.directory(agent_id, &continuation_id)?;
            fs::create_dir_all(&continuation_dir)?;
            let continuation = json!({
                "version": 1,
                "title": format!("{}（早期记录）", title),
                "snapshot": {"version": 1, "messages": []},
                "usage": Value::Null,
                "workspaceRef": workspace.display().to_string(),
                "model": model,
                "updatedAt": now(),
                "continuationFrom": topic_id
            });
            atomic_json(&continuation_dir.join("agent-state.json"), &continuation)?;
            atomic_json(&continuation_dir.join("history.json"), &overflow)?;
        }
        atomic_json(&directory.join("history.json"), &history)
    }

    /// Create a durable, lease-free Topic before it is attached to an Agent
    /// runtime. This is deliberately separate from `acquire`: a user may
    /// prepare and browse several Topics while one attachment is streaming.
    pub fn create_empty(
        &self,
        agent_id: &str,
        topic_id: &str,
        title: &str,
        workspace: &Path,
        model: &str,
    ) -> Result<()> {
        let agent_id = safe(agent_id, "agent id")?;
        let topic_id = safe(topic_id, "topic id")?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err(anyhow!("invalid topic title"));
        }
        let directory = self.directory(&agent_id, &topic_id)?;
        let parent = directory
            .parent()
            .ok_or_else(|| anyhow!("invalid topic directory"))?;
        fs::create_dir_all(parent)?;
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(anyhow!("Topic already exists: {topic_id}"));
            }
            Err(error) => return Err(error.into()),
        }
        let checkpoint = json!({
            "version": 1,
            "title": title,
            "snapshot": {"version": 1, "messages": []},
            "usage": Value::Null,
            "workspaceRef": workspace.display().to_string(),
            "model": model,
            "updatedAt": now()
        });
        if let Err(error) = atomic_json(&directory.join("agent-state.json"), &checkpoint)
            .and_then(|_| atomic_json(&directory.join("history.json"), &Vec::<Value>::new()))
        {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        Ok(())
    }
}

fn live_lock(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Lock>(&raw).ok())
        .is_some_and(|lock| !lock_is_stale(&lock))
}

fn has_checkpoint(directory: &Path) -> bool {
    directory.join("agent-state.json").is_file()
}

fn remove_if_empty(directory: &Path) {
    let Ok(mut entries) = fs::read_dir(directory) else {
        return;
    };
    if entries.next().is_none() {
        let _ = fs::remove_dir(directory);
    }
}

fn ensure_not_live(directory: &Path) -> Result<()> {
    if live_lock(&directory.join(".vcp-agent.topic-lock.json")) {
        return Err(anyhow!("TOPIC_IN_USE"));
    }
    Ok(())
}

fn default_title(messages: &[Value]) -> String {
    messages
        .iter()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(message_text)
        .map(|content| content.chars().take(48).collect())
        .filter(|title: &String| !title.trim().is_empty())
        .unwrap_or_else(|| "新会话".to_string())
}

fn message_text(message: &Value) -> Option<&str> {
    message.get("content").and_then(Value::as_str).or_else(|| {
        message
            .get("content")
            .and_then(Value::as_array)
            .and_then(|parts| {
                parts
                    .iter()
                    .find_map(|part| part.get("text").and_then(Value::as_str))
            })
    })
}

fn safe(value: &str, name: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(anyhow!("invalid {name}"));
    }
    Ok(value.to_string())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn write_new<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(path)?;
    use std::io::Write;
    file.write_all(serde_json::to_string(value).unwrap_or_default().as_bytes())?;
    file.sync_all()
}
fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let backup = path.with_extension("bak");
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = fs::File::create(&temporary)?;
    use std::io::Write;
    file.write_all(&bytes)?;
    file.sync_all()?;
    if path.exists() {
        let _ = fs::copy(path, &backup);
    }
    fs::rename(&temporary, path).or_else(|_| {
        fs::copy(&temporary, path)
            .map(|_| ())
            .and_then(|_| fs::remove_file(&temporary))
    })?;
    if let Some(parent) = path.parent() {
        let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
    }
    Ok(())
}
fn redact(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let sensitive = ["key", "token", "secret", "password", "authorization"]
                        .iter()
                        .any(|needle| key.to_lowercase().contains(needle));
                    (
                        key,
                        if sensitive {
                            Value::String("[REDACTED]".into())
                        } else {
                            redact(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(redact).collect()),
        Value::String(value) => Value::String(truncate(&value, 32 * 1024)),
        other => other,
    }
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
fn sanitize_snapshot(messages: Vec<Value>) -> Vec<Value> {
    messages
        .into_iter()
        .map(redact)
        .map(sanitize_marker_message)
        .collect()
}

fn sanitize_marker_message(mut message: Value) -> Value {
    if let Some(content) = message.get_mut("content") {
        match content {
            Value::String(text) => *text = sanitize_marker_text(text),
            Value::Array(parts) => {
                for part in parts {
                    if part
                        .pointer("/image_url/url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| url.starts_with("data:"))
                    {
                        *part = json!({
                            "type": "text",
                            "text": "[attachment omitted from Topic; durable descriptor required]"
                        });
                        continue;
                    }
                    if let Some(text) = part.get("text").and_then(Value::as_str).map(str::to_string)
                    {
                        part["text"] = Value::String(sanitize_marker_text(&text));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(audit) = message.get("vcpAudit").cloned() {
        message["vcpAudit"] = sanitize_tool_audit(audit);
    }
    message
}

/// Checkpoints can also arrive from an older daemon or an external repair
/// tool. Re-apply the artifact boundary at persistence time so an otherwise
/// valid `toolResult` can never smuggle a local path or data URI into Topic.
fn sanitize_tool_audit(value: Value) -> Value {
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    let mut output = Map::new();
    if let Some(name) = object.get("toolName").and_then(Value::as_str) {
        let name = name.trim();
        if !name.is_empty() {
            output.insert("toolName".into(), Value::String(truncate(name, 256)));
        }
    }
    for key in ["resources", "warnings"] {
        let values = object
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(32)
            .map(|item| sanitize_tool_audit_value(item, 0))
            .collect::<Vec<_>>();
        if !values.is_empty() {
            output.insert(key.into(), Value::Array(values));
        }
    }
    if let Some(task) = object.get("task").filter(|task| !task.is_null()) {
        output.insert("task".into(), sanitize_tool_audit_value(task, 0));
    }
    Value::Object(output)
}

fn sanitize_tool_audit_value(value: &Value, depth: usize) -> Value {
    if depth >= 4 {
        return Value::String("[nested ToolBox metadata omitted]".into());
    }
    match value {
        Value::String(text) if text.trim_start().starts_with("data:") => {
            Value::String("[data URI omitted]".into())
        }
        Value::String(text) => Value::String(truncate(text, 8 * 1024)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(32)
                .map(|item| sanitize_tool_audit_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(values) => {
            let mut output = Map::new();
            for (key, item) in values.iter().take(32) {
                let normalized = key.to_ascii_lowercase();
                if matches!(
                    normalized.as_str(),
                    "path" | "localpath" | "internalpath" | "base64" | "bytes" | "buffer"
                ) || (normalized == "url"
                    && item
                        .as_str()
                        .is_some_and(|url| url.trim_start().starts_with("file:")))
                {
                    continue;
                }
                output.insert(key.clone(), sanitize_tool_audit_value(item, depth + 1));
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

fn sanitize_marker_text(text: &str) -> String {
    let text = replace_marker_blocks(
        text,
        "<<<[TOOL_REQUEST]>>>",
        "<<<[END_TOOL_REQUEST]>>>",
        "[VCP protocol warning: raw TOOL_REQUEST removed and not executed]",
    );
    let text = summarize_marker_blocks(
        &text,
        "<<<[VCP_DYNAMIC_FOLD]>>>",
        "<<<[END_VCP_DYNAMIC_FOLD]>>>",
        "VCP dynamic context",
    );
    summarize_marker_blocks(
        &text,
        "<<<[VCPINFO]>>>",
        "<<<[END_VCPINFO]>>>",
        "VCP notification",
    )
}

fn replace_marker_blocks(input: &str, start: &str, end: &str, replacement: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = input[cursor..].find(start) {
        let block_start = cursor + relative_start;
        let content_start = block_start + start.len();
        let Some(relative_end) = input[content_start..].find(end) else {
            output.push_str(&input[cursor..]);
            return output;
        };
        let block_end = content_start + relative_end + end.len();
        output.push_str(&input[cursor..block_start]);
        output.push_str(replacement);
        cursor = block_end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn summarize_marker_blocks(input: &str, start: &str, end: &str, label: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while let Some(relative_start) = input[cursor..].find(start) {
        let block_start = cursor + relative_start;
        let content_start = block_start + start.len();
        let Some(relative_end) = input[content_start..].find(end) else {
            output.push_str(&input[cursor..]);
            return output;
        };
        let content_end = content_start + relative_end;
        let summary = input[content_start..content_end]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        output.push_str(&input[cursor..block_start]);
        output.push_str(&format!("[{label}: {}]", truncate(&summary, 240)));
        cursor = content_end + end.len();
    }
    output.push_str(&input[cursor..]);
    output
}
fn snapshot_to_history(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let role = message.get("role").and_then(Value::as_str)?;
            if role == "toolResult" {
                return history_tool_result(message, index);
            }
            if !matches!(role, "user" | "assistant") {
                return None;
            }
            let content = message_text(message).unwrap_or("");
            let message_id = message
                .get("messageId")
                .or_else(|| message.get("id"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| deterministic_history_id(message, index, role, content));
            let timestamp = message
                .get("timestamp")
                .or_else(|| message.get("createdAt"))
                .cloned()
                .unwrap_or_else(|| Value::from(0));
            let mut projected = json!({
                "id": message_id.clone(),
                "messageId": message_id,
                "role": role,
                "content": truncate(content, 32 * 1024),
                "timestamp": timestamp,
                "snapshotOrdinal": index,
            });
            if let Some(turn_id) = message.get("turnId").and_then(Value::as_str) {
                projected["turnId"] = Value::String(turn_id.to_string());
            }
            Some(projected)
        })
        .collect()
}

/// A restored Workbench needs the bounded ToolBox artifact projection to be
/// in the same durable Topic as messages. This is display metadata only: the
/// model transcript remains the Core's normal `toolResult.content` text.
fn history_tool_result(message: &Value, index: usize) -> Option<Value> {
    let tool_call_id = message.get("toolCallId")?.as_str()?.trim();
    if tool_call_id.is_empty() {
        return None;
    }
    let audit = message.get("vcpAudit").cloned().unwrap_or(Value::Null);
    let tool_name = audit
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("vcp_invoke");
    let content = truncate(message_text(message).unwrap_or(""), 32 * 1024);
    let timestamp = message
        .get("timestamp")
        .or_else(|| message.get("createdAt"))
        .cloned()
        .unwrap_or_else(|| Value::from(0));
    let mut projected = json!({
        "id": format!("tool-{tool_call_id}"),
        "role": "tool",
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "state": if message.get("isError").and_then(Value::as_bool).unwrap_or(false) { "failed" } else { "completed" },
        "payload": {
            "toolName": tool_name,
            "result": content,
            "resources": audit.get("resources").cloned().unwrap_or_else(|| json!([])),
            "warnings": audit.get("warnings").cloned().unwrap_or_else(|| json!([])),
            "task": audit.get("task").cloned().unwrap_or(Value::Null),
        },
        "timestamp": timestamp,
        "snapshotOrdinal": index,
    });
    if let Some(turn_id) = message.get("turnId").and_then(Value::as_str) {
        projected["turnId"] = Value::String(turn_id.to_string());
    }
    Some(projected)
}

fn deterministic_history_id(message: &Value, index: usize, role: &str, content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vcp-agent-history-v1\0");
    hasher.update(index.to_le_bytes());
    hasher.update(role.as_bytes());
    hasher.update(b"\0");
    hasher.update(content.as_bytes());
    if let Some(turn_id) = message.get("turnId").and_then(Value::as_str) {
        hasher.update(b"\0");
        hasher.update(turn_id.as_bytes());
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("history-{}", &digest[..24])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_sanitizer_never_persists_image_audio_or_video_data_uris() {
        let sanitized = sanitize_snapshot(vec![json!({
            "role": "user",
            "content": [
                {"type":"text","text":"看图"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},
                {"type":"image_url","image_url":{"url":"data:audio/mpeg;base64,BBBB"}},
                {"type":"image_url","image_url":{"url":"data:video/mp4;base64,CCCC"}}
            ]
        })]);
        let serialized = serde_json::to_string(&sanitized).expect("sanitized json");
        assert!(!serialized.contains("base64"));
        assert_eq!(serialized.matches("durable descriptor required").count(), 3);
    }

    #[test]
    fn topic_persists_safe_tool_artifacts_as_a_durable_timeline_entry() {
        let messages = sanitize_snapshot(vec![json!({
            "role": "toolResult",
            "toolCallId": "call-1",
            "content": [{"type":"text","text":"package.json"}],
            "vcpAudit": {
                "toolName": "FileOperator",
                "resources": [{
                    "name": "package.json",
                    "url": "file-ref:package.json",
                    "path": "C:\\Users\\person\\project\\package.json",
                    "preview": "data:image/png;base64,AAAA"
                }],
                "warnings": ["只读预览"],
                "task": {"id":"task-1", "status":"completed"}
            }
        })]);
        let history = snapshot_to_history(&messages);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "tool");
        assert_eq!(history[0]["toolCallId"], "call-1");
        assert_eq!(history[0]["toolName"], "FileOperator");
        assert_eq!(
            history[0]["payload"]["resources"][0]["name"],
            "package.json"
        );
        let serialized = serde_json::to_string(&history).expect("history json");
        assert!(!serialized.contains("C:\\Users"));
        assert!(!serialized.contains("data:image"));
        assert!(serialized.contains("[data URI omitted]"));
    }

    #[test]
    fn checkpoint_is_bounded_and_resumable() {
        let root = std::env::temp_dir().join(format!("vcp-topic-test-{}", std::process::id()));
        let store = TopicStore::new(root.clone());
        store.acquire("nova", "topic-1", "owner-1").unwrap();
        store
            .save(
                "nova",
                "topic-1",
                json!({"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}),
                json!({"token":"nope"}),
                Path::new("."),
                "model",
            )
            .unwrap();
        assert_eq!(store.load_snapshot("nova", "topic-1").unwrap().len(), 1);
        assert!(
            !fs::read_to_string(root.join("nova/topics/topic-1/agent-state.json"))
                .unwrap()
                .contains("nope")
        );
        store.release("nova", "topic-1", "owner-1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn history_projection_preserves_identity_and_has_a_stable_legacy_fallback() {
        let messages = vec![
            json!({
                "messageId":"msg-turn-1-user",
                "turnId":"turn-1",
                "timestamp":42,
                "role":"user",
                "content":[{"type":"text","text":"重复内容"}]
            }),
            json!({"role":"assistant","content":"重复内容"}),
            json!({"role":"assistant","content":"重复内容"}),
        ];
        let first = snapshot_to_history(&messages);
        let second = snapshot_to_history(&messages);

        assert_eq!(first, second, "re-saving a snapshot must not churn IDs");
        assert_eq!(first[0]["id"], "msg-turn-1-user");
        assert_eq!(first[0]["messageId"], "msg-turn-1-user");
        assert_eq!(first[0]["turnId"], "turn-1");
        assert_eq!(first[0]["timestamp"], 42);
        assert_ne!(first[1]["id"], first[2]["id"]);
        assert_eq!(first[1]["timestamp"], 0);
    }

    #[test]
    fn checkpoint_removes_raw_tool_markers_and_compacts_display_only_markers() {
        let messages = sanitize_snapshot(vec![json!({
            "role": "assistant",
            "content": [{"type":"text","text": concat!(
                "before\n<<<[TOOL_REQUEST]>>>danger<<<[END_TOOL_REQUEST]>>>\n",
                "<<<[VCP_DYNAMIC_FOLD]>>>large private context<<<[END_VCP_DYNAMIC_FOLD]>>>\n",
                "<<<[VCPINFO]>>>retrieval details<<<[END_VCPINFO]>>>\nafter"
            )}]
        })]);
        let text = messages[0]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("danger"));
        assert!(!text.contains("<<<[TOOL_REQUEST]>>>"));
        assert!(text.contains("raw TOOL_REQUEST removed and not executed"));
        assert!(text.contains("VCP dynamic context: large private context"));
        assert!(text.contains("VCP notification: retrieval details"));
    }

    #[test]
    fn legacy_agent_topics_move_out_of_vchat_user_data() {
        let root = std::env::temp_dir().join(format!("vcp-topic-migration-test-{}", now()));
        let legacy_root = root.join("UserData");
        let runtime_root = root.join("AgentRuntimeData");
        let legacy_store = TopicStore::new(legacy_root.clone());
        legacy_store
            .acquire("Nova", "topic-1", "legacy-owner")
            .unwrap();
        legacy_store
            .save(
                "Nova",
                "topic-1",
                json!({"messages":[{"role":"user","content":"迁移测试"}]}),
                Value::Null,
                Path::new("."),
                "model",
            )
            .unwrap();
        legacy_store.release("Nova", "topic-1", "legacy-owner");

        let runtime_store = TopicStore::new(runtime_root.clone());
        assert_eq!(runtime_store.migrate_legacy_from(&legacy_root).unwrap(), 1);
        assert!(
            runtime_root
                .join("Nova/topics/topic-1/agent-state.json")
                .is_file()
        );
        assert!(!legacy_root.join("Nova/topics/topic-1").exists());
        assert_eq!(
            runtime_store.load_snapshot("Nova", "topic-1").unwrap()[0]["content"],
            "迁移测试"
        );
        let marker_path = runtime_root.join(LEGACY_MIGRATION_MARKER);
        let marker: LegacyMigrationMarker =
            serde_json::from_str(&fs::read_to_string(marker_path).unwrap()).unwrap();
        assert_eq!(marker.version, LEGACY_MIGRATION_VERSION);
        assert_eq!(marker.migrated_count, 1);
        assert_eq!(runtime_store.migrate_legacy_from(&legacy_root).unwrap(), 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_agent_topic_migration_refuses_a_live_writer() {
        let root = std::env::temp_dir().join(format!("vcp-topic-live-migration-test-{}", now()));
        let legacy_root = root.join("UserData");
        let runtime_root = root.join("AgentRuntimeData");
        let legacy_store = TopicStore::new(legacy_root.clone());
        legacy_store
            .acquire("nova", "topic-1", "live-owner")
            .unwrap();
        atomic_json(
            &legacy_store
                .directory("nova", "topic-1")
                .unwrap()
                .join("agent-state.json"),
            &json!({"version":1,"snapshot":{"messages":[]}}),
        )
        .unwrap();

        let runtime_store = TopicStore::new(runtime_root.clone());
        let error = runtime_store
            .migrate_legacy_from(&legacy_root)
            .unwrap_err()
            .to_string();
        assert!(error.contains("is in use"));
        assert!(legacy_root.join("nova/topics/topic-1").is_dir());
        assert!(!runtime_root.join("nova/topics/topic-1").exists());
        assert!(!runtime_root.join(LEGACY_MIGRATION_MARKER).exists());

        legacy_store.release("nova", "topic-1", "live-owner");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_legacy_scan_is_marked_complete() {
        let root = std::env::temp_dir().join(format!("vcp-topic-empty-migration-test-{}", now()));
        let legacy_root = root.join("UserData");
        let runtime_root = root.join("AgentRuntimeData");
        let runtime_store = TopicStore::new(runtime_root.clone());

        assert_eq!(runtime_store.migrate_legacy_from(&legacy_root).unwrap(), 0);
        assert!(runtime_root.join(LEGACY_MIGRATION_MARKER).is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn catalog_ignores_and_release_removes_an_unclaimed_control_topic() {
        let root = std::env::temp_dir().join(format!("vcp-topic-control-test-{}", now()));
        let store = TopicStore::new(root.clone());
        store
            .acquire("nova", "topic-control", "owner-control")
            .unwrap();
        assert!(store.list("nova").unwrap().is_empty());
        assert_eq!(store.latest_topic("nova").unwrap(), None);
        store.release("nova", "topic-control", "owner-control");
        assert!(!store.directory("nova", "topic-control").unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prepared_topic_is_durable_without_claiming_a_writer_lease() {
        let root = std::env::temp_dir().join(format!("vcp-topic-prepared-test-{}", now()));
        let store = TopicStore::new(root.clone());
        store
            .create_empty(
                "nova",
                "topic-prepared",
                "后台任务期间的新 Topic",
                Path::new("."),
                "gpt-5.6-terra",
            )
            .unwrap();

        let topic = store
            .list("nova")
            .unwrap()
            .into_iter()
            .find(|topic| topic.id == "topic-prepared")
            .expect("prepared Topic must appear in the catalog");
        assert!(
            !topic.in_use,
            "creating a Topic must not claim its writer lease"
        );
        assert_eq!(topic.title, "后台任务期间的新 Topic");
        let view = store.load_read_only("nova", "topic-prepared").unwrap();
        assert_eq!(view["agentId"], "nova");
        assert_eq!(view["history"], json!([]));
        assert!(store.acquire("nova", "topic-prepared", "owner-1").is_ok());
        store.release("nova", "topic-prepared", "owner-1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn topic_catalog_preserves_overflow_and_rejects_mutating_a_live_topic() {
        let root = std::env::temp_dir().join(format!("vcp-topic-catalog-test-{}", now()));
        let store = TopicStore::new(root.clone());
        store.acquire("nova", "topic-1", "owner-1").unwrap();
        let messages: Vec<Value> = (0..410)
            .map(|index| json!({"role":"user","content":[{"type":"text","text":format!("消息 {index}")}]}))
            .collect();
        store
            .save(
                "nova",
                "topic-1",
                json!({"messages":messages}),
                Value::Null,
                Path::new("."),
                "model",
            )
            .unwrap();
        assert!(store.rename("nova", "topic-1", "新标题").is_err());
        let topics = store.list("nova").unwrap();
        assert!(
            topics
                .iter()
                .any(|topic| topic.id == "topic-1" && topic.in_use)
        );
        assert!(
            topics
                .iter()
                .any(|topic| topic.continuation_from.as_deref() == Some("topic-1"))
        );
        store.release("nova", "topic-1", "owner-1");
        store.rename("nova", "topic-1", "新标题").unwrap();
        assert_eq!(
            store
                .list("nova")
                .unwrap()
                .iter()
                .find(|topic| topic.id == "topic-1")
                .unwrap()
                .title,
            "新标题"
        );
        store.delete("nova", "topic-1").unwrap();
        assert!(!store.directory("nova", "topic-1").unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn active_topic_can_be_viewed_read_only_and_requests_cooperative_takeover() {
        let root = std::env::temp_dir().join(format!("vcp-topic-takeover-test-{}", now()));
        let store = TopicStore::new(root.clone());
        store.acquire("nova", "topic-1", "owner-1").unwrap();
        store
            .save(
                "nova",
                "topic-1",
                json!({"messages":[{"role":"user","content":[{"type":"text","text":"只读内容"}]}]}),
                Value::Null,
                Path::new("."),
                "model",
            )
            .unwrap();
        let view = store.load_read_only("nova", "topic-1").unwrap();
        assert_eq!(view["readOnly"], true);
        assert!(
            view["history"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        );
        store
            .request_takeover("nova", "topic-1", "owner-2")
            .unwrap();
        assert_eq!(
            store
                .take_takeover_request("nova", "topic-1", "owner-1")
                .unwrap()
                .as_deref(),
            Some("owner-2")
        );
        store.release("nova", "topic-1", "owner-1");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn immediately_reclaims_a_lock_owned_by_a_dead_windows_process() {
        let root = std::env::temp_dir().join(format!("vcp-topic-dead-owner-test-{}", now()));
        let store = TopicStore::new(root.clone());
        let directory = store.directory("nova", "topic-1").unwrap();
        fs::create_dir_all(&directory).unwrap();
        let stale = Lock {
            owner_id: "owner-dead".into(),
            pid: u32::MAX,
            acquired_at_ms: now(),
            heartbeat_at_ms: now(),
        };
        write_new(&directory.join(".vcp-agent.topic-lock.json"), &stale).unwrap();

        store.acquire("nova", "topic-1", "owner-live").unwrap();
        let reclaimed: Lock = serde_json::from_str(
            &fs::read_to_string(directory.join(".vcp-agent.topic-lock.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(reclaimed.owner_id, "owner-live");
        store.release("nova", "topic-1", "owner-live");
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn detects_a_real_terminated_windows_child_process() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(pid_is_definitely_dead(pid));
    }
}
