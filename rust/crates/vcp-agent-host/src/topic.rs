//! Bounded, crash-safe Agent Topic storage shared by standalone and daemon.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_HISTORY_ENTRIES: usize = 400;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 8 * 1024 * 1024;
const LEASE: Duration = Duration::from_secs(60);

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

impl TopicStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn directory(&self, agent_id: &str, topic_id: &str) -> Result<PathBuf> {
        Ok(self
            .root
            .join(safe(agent_id, "agent id")?)
            .join("topics")
            .join(safe(topic_id, "topic id")?))
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
    messages.into_iter().map(redact).collect()
}
fn snapshot_to_history(messages: &[Value]) -> Vec<Value> {
    messages.iter().filter_map(|message| { let role = message.get("role").and_then(Value::as_str)?; if !matches!(role, "user" | "assistant") { return None; } let content = message.get("content").and_then(Value::as_array).and_then(|parts| parts.iter().find_map(|part| part.get("text").and_then(Value::as_str))).or_else(|| message.get("content").and_then(Value::as_str)).unwrap_or(""); Some(json!({"id":format!("history-{}", now()),"role":role,"content":truncate(content, 32*1024),"timestamp":now()})) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
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
