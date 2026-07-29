use std::{
    collections::BTreeMap,
    time::{SystemTime, UNIX_EPOCH},
};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, StatefulWidgetRef, Wrap},
};
use unicode_width::UnicodeWidthStr;
use xai_ratatui_textarea::{TextArea, TextAreaState};

use crate::{
    protocol::{ApprovalBinding, PermissionMode, RuntimeState, ToolBoxState, ToolStatus, VcpEvent},
    theme::{Theme, ThemeId},
};

const VCPCLI_LOGO: [&str; 6] = [
    "██╗   ██╗  ██████╗  ██████╗      ██████╗  ██╗      ██╗",
    "██║   ██║ ██╔════╝  ██╔══██╗    ██╔════╝  ██║      ██║",
    "██║   ██║ ██║       ██████╔╝    ██║       ██║      ██║",
    "╚██╗ ██╔╝ ██║       ██╔═══╝     ██║       ██║      ██║",
    " ╚████╔╝  ╚██████╗  ██║         ╚██████╗  ███████╗ ██║",
    "  ╚═══╝    ╚═════╝  ╚═╝          ╚═════╝  ╚══════╝ ╚═╝",
];

// Kept in sync with VChat's PowerShellExecutor launch animation.
const VCPCLI_LOGO_COLORS: [Color; 6] = [
    Color::Rgb(245, 194, 231), // pink
    Color::Rgb(203, 166, 247), // mauve
    Color::Rgb(137, 180, 250), // blue
    Color::Rgb(116, 199, 236), // sapphire
    Color::Rgb(137, 220, 235), // sky
    Color::Rgb(148, 226, 213), // teal
];

const SLASH_COMMANDS: [(&str, &str); 19] = [
    ("/model", "选择模型"),
    ("/agent", "选择 Agent"),
    ("/theme", "选择主题"),
    ("/settings", "设置"),
    ("/permissions", "本地工具权限"),
    ("/new", "新建会话"),
    ("/topics", "管理 Agent Topic"),
    ("/resume", "恢复 Agent Topic"),
    ("/steer", "插入当前任务指导"),
    ("/queue", "查看主动交互队列"),
    ("/clear-queue", "清空主动交互队列"),
    ("/compact", "压缩当前上下文"),
    ("/reasoning", "展开或折叠 Thinking"),
    ("/usage", "查看 token 用量"),
    ("/budget", "查看预算状态"),
    ("/status", "运行状态"),
    ("/clear", "清屏"),
    ("/hotkeys", "快捷键"),
    ("/quit", "退出"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    User,
    Assistant,
    Reasoning,
    Notice,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageBlock {
    pub kind: MessageKind,
    pub title: String,
    pub body: String,
    pub expanded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChoiceItem {
    pub id: String,
    pub label: String,
    pub detail: String,
}

#[derive(Debug, Clone)]
struct ChoicePicker {
    kind: String,
    title: String,
    items: Vec<ChoiceItem>,
    query: String,
    index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputAction {
    None,
    Submit(String),
    Cancel,
    Quit,
    Clear,
    ThemeChanged(ThemeId),
    OpenSettings,
    Approval {
        approval_id: String,
        allowed: bool,
        binding: Option<ApprovalBinding>,
    },
    Command(String),
    Demo,
}

#[derive(Debug, Clone)]
struct ToolBlock {
    tool_name: String,
    status: ToolStatus,
    detail: String,
}

#[derive(Debug, Clone)]
struct ApprovalCard {
    id: String,
    tool_name: String,
    risk: String,
    reason: String,
    arguments: String,
    expires_at_ms: Option<u64>,
    allow_selected: bool,
    binding: Option<ApprovalBinding>,
}

/// The VCP-specific TUI projection. It intentionally owns no model credentials,
/// filesystem, shell, ToolBox execution, or approval policy. The Rust Agent Core
/// will stream [`VcpEvent`] into it and consume [`InputAction`] values.
pub struct App {
    pub agent: String,
    pub model: String,
    pub workspace: String,
    pub messages: Vec<MessageBlock>,
    pub status: String,
    pub input: TextArea,
    pub input_state: TextAreaState,
    pub theme_id: ThemeId,
    theme: Theme,
    tools: BTreeMap<String, ToolBlock>,
    approval: Option<ApprovalCard>,
    theme_picker: bool,
    theme_picker_index: usize,
    theme_picker_area: Rect,
    choice_picker: Option<ChoicePicker>,
    transcript_scroll: u16,
    input_area: Rect,
    transcript_area: Rect,
    welcome_cursor_visible: bool,
    usage: (u64, u64, u64, Option<u64>),
    runtime_state: RuntimeState,
    toolbox_state: ToolBoxState,
    permission_mode: PermissionMode,
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        let theme_id = ThemeId::Auto;
        let theme = Theme::resolve(theme_id);
        let mut input = TextArea::new();
        input.selection_style = Style::default().bg(theme.selection).fg(theme.foreground);
        input.scrollbar_track_style = Style::default().bg(theme.surface_strong);
        input.scrollbar_thumb_style = Style::default().bg(theme.surface);
        Self {
            agent: "Nova".into(),
            model: "gpt-5.6-terra".into(),
            workspace: ".".into(),
            messages: Vec::new(),
            status: "就绪".into(),
            input,
            input_state: TextAreaState::default(),
            theme_id,
            theme,
            tools: BTreeMap::new(),
            approval: None,
            theme_picker: false,
            theme_picker_index: 0,
            theme_picker_area: Rect::default(),
            choice_picker: None,
            transcript_scroll: 0,
            input_area: Rect::default(),
            transcript_area: Rect::default(),
            welcome_cursor_visible: true,
            usage: (0, 0, 0, None),
            runtime_state: RuntimeState::Starting,
            toolbox_state: ToolBoxState::Unknown,
            permission_mode: PermissionMode::Ask,
        }
    }

    pub fn apply_event(&mut self, event: VcpEvent) {
        match event {
            VcpEvent::SessionStarted {
                agent,
                model,
                workspace,
            } => {
                self.agent = agent;
                self.model = model;
                if !workspace.is_empty() {
                    self.workspace = workspace;
                }
                self.messages.clear();
                self.tools.clear();
                self.approval = None;
                self.usage = (0, 0, 0, None);
                self.transcript_scroll = 0;
                self.status = "会话已就绪".into();
            }
            VcpEvent::RuntimeStatus {
                runtime,
                toolbox,
                permission_mode,
            } => {
                self.runtime_state = runtime;
                self.toolbox_state = toolbox;
                self.permission_mode = permission_mode;
                self.status = format!(
                    "{} · {}",
                    runtime_state_label(runtime),
                    toolbox_state_label(toolbox)
                );
            }
            VcpEvent::AssistantDelta { text } => {
                let agent = self.agent.clone();
                self.append(MessageKind::Assistant, &agent, &text, true)
            }
            VcpEvent::AssistantCompleted => self.status = "回复完成".into(),
            VcpEvent::ReasoningDelta { text } => {
                self.append(MessageKind::Reasoning, "Thinking", &text, false)
            }
            VcpEvent::ReasoningCompleted => self.status = "Thinking 完成（Ctrl+R 展开）".into(),
            VcpEvent::ToolRequested { call_id, tool_name } => {
                self.tools.insert(
                    call_id,
                    ToolBlock {
                        tool_name,
                        status: ToolStatus::AwaitingApproval,
                        detail: "正在准备 VCPToolBox 请求".into(),
                    },
                );
            }
            VcpEvent::ToolStatus {
                call_id,
                tool_name,
                status,
                detail,
            } => {
                self.tools.insert(
                    call_id,
                    ToolBlock {
                        tool_name,
                        status,
                        detail,
                    },
                );
            }
            VcpEvent::ApprovalRequested {
                approval_id,
                tool_name,
                risk,
                reason,
                argument_summary,
                expires_at_ms,
                binding,
            } => {
                self.approval = Some(ApprovalCard {
                    id: approval_id,
                    tool_name,
                    risk,
                    reason,
                    arguments: argument_summary,
                    expires_at_ms,
                    allow_selected: false,
                    binding,
                });
                self.status = "等待审批（默认拒绝）".into();
            }
            VcpEvent::Usage {
                input_tokens,
                output_tokens,
                total_tokens,
                context_window,
            } => self.usage = (input_tokens, output_tokens, total_tokens, context_window),
            VcpEvent::TurnCompleted => self.status = "本轮完成".into(),
            VcpEvent::Notice { title, message } => {
                self.append(MessageKind::Notice, &title, &message, true)
            }
            VcpEvent::RuntimeWarning { message } => {
                self.append(MessageKind::Warning, "运行告警", &message, true)
            }
        }
    }

    /// Advance local visual state. An expired approval is denied locally even
    /// if the host is delayed; ToolBox must still enforce the same expiry.
    pub fn handle_tick(&mut self) -> Option<InputAction> {
        self.welcome_cursor_visible = !self.welcome_cursor_visible;
        let expired = self
            .approval
            .as_ref()
            .and_then(|card| card.expires_at_ms)
            .is_some_and(|deadline| deadline <= now_millis());
        expired.then(|| self.finish_approval(false))
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> InputAction {
        if self.approval.is_some() {
            return self.handle_approval_key(key);
        }
        if self.theme_picker {
            return self.handle_theme_key(key);
        }
        if self.choice_picker.is_some() {
            return self.handle_choice_key(key);
        }
        if (key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')))
            || matches!(key.code, KeyCode::Esc)
        {
            if matches!(
                self.runtime_state,
                RuntimeState::Working | RuntimeState::Cancelling
            ) {
                self.status = "正在取消当前任务…".into();
                return InputAction::Cancel;
            }
            return InputAction::Quit;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('l')) {
            self.clear_transcript();
            return InputAction::Clear;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('r')) {
            self.toggle_reasoning();
            return InputAction::None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('t')) {
            self.open_theme_picker();
            return InputAction::None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('d')) {
            return InputAction::Demo;
        }
        if matches!(key.code, KeyCode::PageUp) {
            self.scroll_by(8);
            return InputAction::None;
        }
        if matches!(key.code, KeyCode::PageDown) {
            self.scroll_by(-8);
            return InputAction::None;
        }
        if matches!(key.code, KeyCode::Tab) && self.input.text().starts_with('/') {
            self.complete_slash();
            return InputAction::None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Enter) {
            return self.submit_input();
        }
        // The editor is multiline, so Enter ordinarily inserts a newline. A
        // slash command is an explicit single-line action, however; accepting
        // plain Enter here makes `/theme` and the other command entries behave
        // like conventional terminal command palettes.
        if matches!(key.code, KeyCode::Enter) && self.input.text().trim_start().starts_with('/') {
            return self.submit_input();
        }
        self.input.input(key);
        InputAction::None
    }

    pub fn handle_mouse(&mut self, mouse: MouseEvent) {
        if self.theme_picker {
            if let MouseEventKind::Down(MouseButton::Left) = mouse.kind {
                let inner_y = self.theme_picker_area.y.saturating_add(1);
                let index = mouse.row.saturating_sub(inner_y) as usize;
                let inside_rows = mouse.column >= self.theme_picker_area.x.saturating_add(1)
                    && mouse.column < self.theme_picker_area.right().saturating_sub(1)
                    && mouse.row >= inner_y
                    && index < ThemeId::ALL.len();
                if inside_rows {
                    self.set_theme(ThemeId::ALL[index]);
                    self.theme_picker = false;
                }
            }
            return;
        }
        if self.choice_picker.is_some() {
            return;
        }
        match mouse.kind {
            MouseEventKind::ScrollUp if mouse.row < self.input_area.y => self.scroll_by(3),
            MouseEventKind::ScrollDown if mouse.row < self.input_area.y => self.scroll_by(-3),
            _ => {
                let _ = self
                    .input
                    .handle_mouse(mouse, self.input_area, self.input_state);
            }
        }
    }

    pub fn handle_paste(&mut self, text: &str) {
        self.input.insert_str(text);
    }

    pub fn load_demo(&mut self) {
        self.apply_event(VcpEvent::AssistantDelta {
            text: "这里是 VCPAgent 的 Rust TUI。真实操作仍会经由 VCPToolBox。".into(),
        });
        self.apply_event(VcpEvent::ReasoningDelta {
            text: "我会先确认工具请求和审批状态，再继续执行。".into(),
        });
        self.apply_event(VcpEvent::ReasoningCompleted);
        self.apply_event(VcpEvent::ToolRequested {
            call_id: "demo-tool".into(),
            tool_name: "vcp_invoke".into(),
        });
        self.apply_event(VcpEvent::ToolStatus {
            call_id: "demo-tool".into(),
            tool_name: "vcp_invoke".into(),
            status: ToolStatus::Completed,
            detail: "演示结果：没有发送真实 ToolBox 请求".into(),
        });
        self.apply_event(VcpEvent::Usage {
            input_tokens: 824,
            output_tokens: 156,
            total_tokens: 980,
            context_window: Some(128_000),
        });
    }

    pub fn draw(&mut self, frame: &mut Frame<'_>) {
        let area = frame.area();
        frame.render_widget(
            Paragraph::new("").style(Style::default().bg(self.theme.background)),
            area,
        );
        let welcome = self.messages.is_empty() && self.tools.is_empty();
        if welcome {
            let [header, transcript, prompt, footer] = Layout::vertical([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(5),
                Constraint::Length(1),
            ])
            .areas(area);
            self.draw_header(frame, header);
            self.draw_transcript(frame, transcript);
            self.draw_prompt(frame, prompt);
            self.draw_footer(frame, footer);
        } else {
            let [header, transcript, tools, prompt, footer] = Layout::vertical([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(6),
                Constraint::Length(5),
                Constraint::Length(1),
            ])
            .areas(area);
            self.draw_header(frame, header);
            self.draw_transcript(frame, transcript);
            self.draw_tools(frame, tools);
            self.draw_prompt(frame, prompt);
            self.draw_footer(frame, footer);
        }
        if self.approval.is_some() {
            self.draw_approval(frame);
        }
        if self.theme_picker {
            self.draw_theme_picker(frame);
        }
        if self.choice_picker.is_some() {
            self.draw_choice_picker(frame);
        }
        if self.approval.is_none()
            && !self.theme_picker
            && self.choice_picker.is_none()
            && let Some((x, y)) = self
                .input
                .cursor_pos_with_state(self.input_area, self.input_state)
        {
            frame.set_cursor_position((x, y));
        }
    }

    fn submit_input(&mut self) -> InputAction {
        let prompt = self.input.text().trim().to_owned();
        if prompt.is_empty() {
            return InputAction::None;
        }
        let (command, argument) = split_command(&prompt);
        match command {
            "/theme" if argument.is_empty() => {
                self.input.set_text("");
                self.open_theme_picker();
                InputAction::None
            }
            "/clear" if argument.is_empty() => {
                self.input.set_text("");
                self.clear_transcript();
                InputAction::Clear
            }
            "/hotkeys" if argument.is_empty() => {
                self.input.set_text("");
                self.append(MessageKind::Notice, "快捷键", "Ctrl+Enter 发送 · 忙碌时输入会成为 follow-up · /steer 插入指导 · Esc/Ctrl+C 取消 · Ctrl+R 展开 Thinking · Ctrl+T 主题", true);
                InputAction::None
            }
            "/settings" if argument.is_empty() => {
                self.input.set_text("");
                InputAction::OpenSettings
            }
            "/quit" if argument.is_empty() => InputAction::Quit,
            "/status" | "/new" | "/model" | "/agent" | "/settings" | "/permissions" | "/steer"
            | "/follow-up" | "/topics" | "/resume" | "/queue" | "/clear-queue" | "/compact"
            | "/reasoning" | "/usage" | "/budget" => {
                self.input.set_text("");
                InputAction::Command(prompt)
            }
            _ => {
                self.input.set_text("");
                self.append(MessageKind::User, "You", &prompt, true);
                self.status = "已交给 Agent Core".into();
                self.transcript_scroll = 0;
                InputAction::Submit(prompt)
            }
        }
    }

    fn handle_approval_key(&mut self, key: KeyEvent) -> InputAction {
        if matches!(key.code, KeyCode::Left | KeyCode::Right | KeyCode::Tab) {
            let card = self.approval.as_mut().expect("checked above");
            card.allow_selected = !card.allow_selected;
            return InputAction::None;
        }
        let allow_selected = self
            .approval
            .as_ref()
            .is_some_and(|card| card.allow_selected);
        match key.code {
            KeyCode::Esc | KeyCode::Char('n') | KeyCode::Char('N') => self.finish_approval(false),
            KeyCode::Char('y') | KeyCode::Char('Y') => self.finish_approval(true),
            KeyCode::Enter => self.finish_approval(allow_selected),
            _ => InputAction::None,
        }
    }

    fn finish_approval(&mut self, allowed: bool) -> InputAction {
        let card = self.approval.take().expect("approval exists");
        self.status = if allowed {
            "已允许一次".into()
        } else {
            "已拒绝".into()
        };
        InputAction::Approval {
            approval_id: card.id,
            allowed,
            binding: card.binding,
        }
    }

    fn handle_theme_key(&mut self, key: KeyEvent) -> InputAction {
        match key.code {
            KeyCode::Esc => {
                self.theme_picker = false;
                InputAction::None
            }
            KeyCode::Up => {
                self.theme_picker_index = self.theme_picker_index.saturating_sub(1);
                InputAction::None
            }
            KeyCode::Down => {
                self.theme_picker_index = (self.theme_picker_index + 1).min(ThemeId::ALL.len() - 1);
                InputAction::None
            }
            KeyCode::Enter => {
                let id = ThemeId::ALL[self.theme_picker_index];
                self.set_theme(id);
                self.theme_picker = false;
                InputAction::ThemeChanged(id)
            }
            _ => InputAction::None,
        }
    }

    fn set_theme(&mut self, id: ThemeId) {
        self.theme_id = id;
        self.theme = Theme::resolve(id);
        self.input.selection_style = Style::default()
            .bg(self.theme.selection)
            .fg(self.theme.foreground);
        self.input.scrollbar_track_style = Style::default().bg(self.theme.surface_strong);
        self.input.scrollbar_thumb_style = Style::default().bg(self.theme.surface);
        self.status = format!("Theme: {}", id.name());
    }

    pub fn apply_theme_name(&mut self, name: &str) {
        self.set_theme(ThemeId::from_name(name));
    }

    fn open_theme_picker(&mut self) {
        self.theme_picker = true;
        self.theme_picker_index = ThemeId::ALL
            .iter()
            .position(|item| *item == self.theme_id)
            .unwrap_or(0);
    }

    pub fn open_choice_picker(&mut self, kind: &str, title: &str, items: Vec<ChoiceItem>) {
        self.choice_picker = Some(ChoicePicker {
            kind: kind.to_string(),
            title: title.to_string(),
            items,
            query: String::new(),
            index: 0,
        });
        self.status = format!("选择 {title} · 输入可搜索");
    }

    fn handle_choice_key(&mut self, key: KeyEvent) -> InputAction {
        let picker = self.choice_picker.as_mut().expect("checked above");
        match key.code {
            KeyCode::Esc => {
                self.choice_picker = None;
                InputAction::None
            }
            KeyCode::Up => {
                picker.index = picker.index.saturating_sub(1);
                InputAction::None
            }
            KeyCode::Down => {
                let count = filtered_choice_indices(picker).len();
                picker.index = (picker.index + 1).min(count.saturating_sub(1));
                InputAction::None
            }
            KeyCode::Backspace => {
                picker.query.pop();
                picker.index = 0;
                InputAction::None
            }
            KeyCode::Char(value) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                picker.query.push(value);
                picker.index = 0;
                InputAction::None
            }
            KeyCode::Enter => {
                let selected = filtered_choice_indices(picker)
                    .get(picker.index)
                    .and_then(|index| picker.items.get(*index))
                    .cloned();
                let kind = picker.kind.clone();
                self.choice_picker = None;
                selected.map_or(InputAction::None, |item| {
                    let command = match kind.as_str() {
                        "model" => format!("/model {}", item.id),
                        "agent" => format!("/agent {}", item.id),
                        "topic" => format!("/resume {}", item.id),
                        _ => return InputAction::None,
                    };
                    InputAction::Command(command)
                })
            }
            _ => InputAction::None,
        }
    }
    fn clear_transcript(&mut self) {
        self.messages.clear();
        self.tools.clear();
        self.transcript_scroll = 0;
        self.status = "已清屏".into();
    }
    fn scroll_by(&mut self, delta: i16) {
        self.transcript_scroll = if delta >= 0 {
            self.transcript_scroll.saturating_add(delta as u16)
        } else {
            self.transcript_scroll.saturating_sub((-delta) as u16)
        };
    }
    fn toggle_reasoning(&mut self) {
        for entry in &mut self.messages {
            if entry.kind == MessageKind::Reasoning {
                entry.expanded = !entry.expanded;
            }
        }
        self.status = "Thinking 展开状态已切换".into();
    }

    pub fn toggle_reasoning_command(&mut self) {
        self.toggle_reasoning();
    }
    fn complete_slash(&mut self) {
        let current = self.input.text().to_owned();
        if let Some((command, _)) = SLASH_COMMANDS
            .iter()
            .find(|(command, _)| command.starts_with(&current))
        {
            self.input.set_text(command);
        }
    }
    fn append(&mut self, kind: MessageKind, title: &str, text: &str, expanded: bool) {
        if let Some(last) = self.messages.last_mut()
            && last.kind == kind
            && last.title == title
            && last.expanded == expanded
        {
            last.body.push_str(text);
        } else {
            self.messages.push(MessageBlock {
                kind,
                title: title.into(),
                body: text.into(),
                expanded,
            });
        }
        self.transcript_scroll = 0;
    }

    fn draw_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let toolbox = toolbox_state_label(self.toolbox_state);
        let runtime = runtime_state_label(self.runtime_state);
        let approval = if self.permission_mode == PermissionMode::AlwaysApprove {
            " · YOLO"
        } else {
            ""
        };
        let line = Line::from(vec![
            Span::styled(
                " VCPCLI ",
                Style::default()
                    .fg(self.theme.accent)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("Rust TUI", Style::default().fg(self.theme.foreground)),
            Span::styled(
                format!("  ·  {toolbox} · {runtime}{approval}"),
                Style::default().fg(self.theme.muted),
            ),
        ]);
        let info = if area.width < 72 {
            format!(" {} · {}", self.agent, self.model)
        } else {
            format!(" {}  ·  {}  ·  {}", self.agent, self.model, self.workspace)
        };
        frame.render_widget(
            Paragraph::new(Text::from(vec![
                line,
                Line::styled(info, Style::default().fg(self.theme.muted)),
            ]))
            .block(self.block("")),
            area,
        );
    }

    fn draw_transcript(&mut self, frame: &mut Frame<'_>, area: Rect) {
        self.transcript_area = area;
        if self.messages.is_empty() && self.tools.is_empty() {
            self.draw_welcome(frame, area);
            return;
        }
        let lines = self.transcript_lines();
        let block = self.block(" Conversation ");
        let inner = block.inner(area);
        let total = lines.len() as u16;
        self.transcript_scroll = self
            .transcript_scroll
            .min(total.saturating_sub(inner.height));
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: false })
                .scroll((self.transcript_scroll, 0))
                .block(block),
            area,
        );
        if total > inner.height && inner.width > 0 {
            let track_height = inner.height.max(1);
            let thumb =
                ((track_height as f32 * track_height as f32 / total as f32).ceil() as u16).max(1);
            let max_scroll = total.saturating_sub(track_height).max(1);
            let top = ((track_height.saturating_sub(thumb)) as f32 * self.transcript_scroll as f32
                / max_scroll as f32)
                .round() as u16;
            for row in 0..track_height {
                let ch = if row >= top && row < top + thumb {
                    "█"
                } else {
                    "│"
                };
                frame.buffer_mut().set_string(
                    inner.right().saturating_sub(1),
                    inner.y + row,
                    ch,
                    Style::default().fg(if ch == "█" {
                        self.theme.subtle
                    } else {
                        self.theme.surface_strong
                    }),
                );
            }
        }
    }

    fn draw_welcome(&self, frame: &mut Frame<'_>, area: Rect) {
        let inner = Rect {
            x: area.x.saturating_add(1),
            y: area.y,
            width: area.width.saturating_sub(2),
            height: area.height,
        };
        let compact = inner.width < 74 || inner.height < 12;
        let mut lines: Vec<Line<'static>> = Vec::new();
        if compact {
            lines.push(Line::styled(
                "VCPCLI  /  VCP AGENT",
                Style::default()
                    .fg(self.theme.accent)
                    .add_modifier(Modifier::BOLD),
            ));
        } else {
            lines.extend(VCPCLI_LOGO.iter().enumerate().map(|(index, line)| {
                Line::styled(
                    (*line).to_string(),
                    Style::default()
                        .fg(VCPCLI_LOGO_COLORS[index])
                        .add_modifier(Modifier::BOLD),
                )
            }));
            lines.push(Line::styled(
                "────────────────────────────────────────────────────────────────────",
                Style::default().fg(self.theme.subtle),
            ));
        }
        lines.push(Line::styled(
            "VCPAgent · VCPToolBox Bridge · Interactive Agent Terminal",
            Style::default().fg(self.theme.muted),
        ));
        let cursor = if self.welcome_cursor_visible {
            "▍"
        } else {
            " "
        };
        lines.push(Line::from(vec![
            Span::styled("› ", Style::default().fg(self.theme.accent)),
            Span::styled(
                format!("Start typing to begin {cursor}"),
                Style::default().fg(self.theme.foreground),
            ),
        ]));
        if !compact {
            lines.push(Line::styled(
                format!(
                    "Agent {}  ·  {}  ·  {}",
                    self.agent,
                    self.model,
                    toolbox_state_label(self.toolbox_state)
                ),
                Style::default().fg(self.theme.muted),
            ));
        }
        lines.push(Line::styled(
            "Start typing  ·  / for commands  ·  Ctrl+T to personalize",
            Style::default().fg(self.theme.muted),
        ));
        let content_height = lines.len() as u16;
        let y = inner.y + inner.height.saturating_sub(content_height) / 2;
        let width = lines
            .iter()
            .map(|line| line.width() as u16)
            .max()
            .unwrap_or(0);
        let x = inner.x + inner.width.saturating_sub(width) / 2;
        frame.render_widget(
            Paragraph::new(lines),
            Rect {
                x,
                y,
                width: inner.width.saturating_sub(x - inner.x),
                height: content_height,
            },
        );
    }

    fn draw_tools(&self, frame: &mut Frame<'_>, area: Rect) {
        let mut lines = Vec::new();
        if self.tools.is_empty() {
            lines.push(Line::styled(
                format!(
                    "{} · No active VCPToolBox calls",
                    toolbox_state_label(self.toolbox_state)
                ),
                Style::default().fg(self.theme.muted),
            ));
        }
        for tool in self.tools.values() {
            let (label, color, icon) = match tool.status {
                ToolStatus::AwaitingApproval => ("等待审批", self.theme.warning, "!"),
                ToolStatus::Running => ("执行中", self.theme.accent, "◆"),
                ToolStatus::Completed => ("完成", self.theme.success, "✓"),
                ToolStatus::Failed => ("失败", self.theme.error, "✗"),
                ToolStatus::Cancelled => ("已取消", self.theme.muted, "○"),
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!(" {icon} {} ", tool.tool_name),
                    Style::default()
                        .fg(self.theme.accent_alt)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(label, Style::default().fg(color)),
                Span::styled(
                    format!("  {}", tool.detail),
                    Style::default().fg(self.theme.muted),
                ),
            ]));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .wrap(Wrap { trim: true })
                .block(self.block(" VCPToolBox ")),
            area,
        );
    }

    fn draw_prompt(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let block = self.block(" Prompt ");
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if inner.width < 3 || inner.height == 0 {
            self.input_area = Rect::default();
            return;
        }
        let [marker, input] =
            Layout::horizontal([Constraint::Length(2), Constraint::Min(1)]).areas(inner);
        frame.render_widget(
            Paragraph::new(Span::styled(
                "❯ ",
                Style::default()
                    .fg(self.theme.accent_alt)
                    .add_modifier(Modifier::BOLD),
            )),
            marker,
        );
        StatefulWidgetRef::render_ref(
            &(&self.input),
            input,
            frame.buffer_mut(),
            &mut self.input_state,
        );
        self.input_area = input;
        if self.input.text().starts_with('/') {
            self.draw_slash_hints(frame, area);
        }
    }

    fn draw_slash_hints(&self, frame: &mut Frame<'_>, prompt_area: Rect) {
        let prefix = self.input.text();
        let matching: Vec<_> = SLASH_COMMANDS
            .iter()
            .filter(|(command, _)| command.starts_with(prefix))
            .take(4)
            .collect();
        if matching.is_empty() || prompt_area.y < matching.len() as u16 + 1 {
            return;
        }
        let height = matching.len() as u16 + 1;
        let area = Rect {
            x: prompt_area.x + 2,
            y: prompt_area.y.saturating_sub(height),
            width: prompt_area.width.saturating_sub(4),
            height,
        };
        let lines = matching
            .iter()
            .map(|(command, description)| {
                Line::from(vec![
                    Span::styled(
                        format!(" {command:<12}"),
                        Style::default().fg(self.theme.accent),
                    ),
                    Span::styled(*description, Style::default().fg(self.theme.muted)),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(
            Paragraph::new(lines).block(
                Block::default().borders(Borders::ALL).style(
                    Style::default()
                        .bg(self.theme.surface)
                        .fg(self.theme.foreground),
                ),
            ),
            area,
        );
    }

    fn draw_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let (_, _, total, window) = self.usage;
        let usage = if total == 0 {
            "tokens —".into()
        } else if let Some(window) = window {
            format!(
                "{total} tokens · ctx {}%",
                total.saturating_mul(100) / window.max(1)
            )
        } else {
            format!("{total} tokens")
        };
        let right = if area.width < 74 {
            usage
        } else {
            format!("Ctrl+R thinking · Ctrl+T theme · {usage}")
        };
        let left = &self.status;
        let gap = (area.width as usize)
            .saturating_sub(
                UnicodeWidthStr::width(left.as_str()) + UnicodeWidthStr::width(right.as_str()),
            )
            .max(1);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(left, Style::default().fg(self.theme.muted)),
                Span::raw(" ".repeat(gap)),
                Span::styled(right, Style::default().fg(self.theme.muted)),
            ])),
            area,
        );
    }

    fn draw_approval(&self, frame: &mut Frame<'_>) {
        let Some(card) = &self.approval else {
            return;
        };
        let area = centered_rect(76, 15, frame.area());
        frame.render_widget(Clear, area);
        let block = Block::default()
            .title(" VCPToolBox 审批 ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.warning))
            .style(Style::default().bg(self.theme.surface));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let decision = if card.allow_selected {
            "[ 允许一次 ]    拒绝"
        } else {
            " 允许一次     [ 拒绝 ]"
        };
        let lines = vec![
            Line::styled(
                format!("{}  风险 {}", card.tool_name, card.risk),
                Style::default()
                    .fg(self.theme.error)
                    .add_modifier(Modifier::BOLD),
            ),
            Line::default(),
            Line::styled(
                format!("原因: {}", card.reason),
                Style::default().fg(self.theme.foreground),
            ),
            Line::styled(
                format!("参数: {}", truncate(&card.arguments, 180)),
                Style::default().fg(self.theme.muted),
            ),
            Line::default(),
            Line::styled(
                decision,
                Style::default()
                    .fg(if card.allow_selected {
                        self.theme.success
                    } else {
                        self.theme.warning
                    })
                    .add_modifier(Modifier::BOLD),
            ),
            Line::styled(
                approval_hint(card.expires_at_ms),
                Style::default().fg(self.theme.muted),
            ),
        ];
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), inner);
    }

    fn draw_theme_picker(&mut self, frame: &mut Frame<'_>) {
        let area = centered_rect(44, 13, frame.area());
        self.theme_picker_area = area;
        frame.render_widget(Clear, area);
        let block = Block::default()
            .title(" Theme ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.accent))
            .style(Style::default().bg(self.theme.surface));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let lines = ThemeId::ALL
            .iter()
            .enumerate()
            .map(|(index, id)| {
                let selected = index == self.theme_picker_index;
                Line::styled(
                    format!(" {} {}", if selected { "›" } else { " " }, id.name()),
                    Style::default()
                        .fg(if selected {
                            self.theme.accent
                        } else {
                            self.theme.foreground
                        })
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), inner);
    }

    fn draw_choice_picker(&self, frame: &mut Frame<'_>) {
        let Some(picker) = &self.choice_picker else {
            return;
        };
        let area = centered_rect(72, 17, frame.area());
        frame.render_widget(Clear, area);
        let block = Block::default()
            .title(format!(" {} · 搜索: {} ", picker.title, picker.query))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.accent))
            .style(Style::default().bg(self.theme.surface));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let filtered = filtered_choice_indices(picker);
        let lines = filtered
            .iter()
            .take(inner.height as usize)
            .enumerate()
            .filter_map(|(visible, index)| picker.items.get(*index).map(|item| (visible, item)))
            .map(|(visible, item)| {
                let selected = visible == picker.index;
                Line::styled(
                    format!(
                        " {} {}  {}",
                        if selected { "›" } else { " " },
                        item.label,
                        item.detail
                    ),
                    Style::default()
                        .fg(if selected {
                            self.theme.accent
                        } else {
                            self.theme.foreground
                        })
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                )
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), inner);
    }

    fn transcript_lines(&self) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        for block in &self.messages {
            let (color, prefix) = match block.kind {
                MessageKind::User => (self.theme.accent_alt, "You"),
                MessageKind::Assistant => (self.theme.accent, "Nova"),
                MessageKind::Reasoning => (self.theme.muted, "Thinking"),
                MessageKind::Notice => (self.theme.accent, "Info"),
                MessageKind::Warning => (self.theme.error, "Warning"),
            };
            if block.kind == MessageKind::Reasoning && !block.expanded {
                lines.push(Line::from(vec![
                    Span::styled(" ▸ ", Style::default().fg(color)),
                    Span::styled(
                        format!(
                            "{prefix}  {} chars  (Ctrl+R 展开)",
                            block.body.chars().count()
                        ),
                        Style::default().fg(color),
                    ),
                ]));
            } else {
                lines.push(Line::styled(
                    format!(" {prefix}"),
                    Style::default().fg(color).add_modifier(Modifier::BOLD),
                ));
                lines.extend(Text::from(block.body.clone()).lines);
            }
            lines.push(Line::default());
        }
        lines
    }

    fn block(&self, title: &str) -> Block<'static> {
        Block::default()
            .title(title.to_string())
            .borders(Borders::ALL)
            .border_style(Style::default().fg(self.theme.prompt_border))
            .style(
                Style::default()
                    .bg(self.theme.background)
                    .fg(self.theme.foreground),
            )
    }
}

fn split_command(prompt: &str) -> (&str, &str) {
    let trimmed = prompt.trim();
    let Some((command, argument)) = trimmed.split_once(char::is_whitespace) else {
        return (trimmed, "");
    };
    (command, argument.trim())
}

fn filtered_choice_indices(picker: &ChoicePicker) -> Vec<usize> {
    let query = picker.query.to_lowercase();
    picker
        .items
        .iter()
        .enumerate()
        .filter(|(_, item)| {
            query.is_empty()
                || item.id.to_lowercase().contains(&query)
                || item.label.to_lowercase().contains(&query)
                || item.detail.to_lowercase().contains(&query)
        })
        .map(|(index, _)| index)
        .collect()
}

fn runtime_state_label(state: RuntimeState) -> &'static str {
    match state {
        RuntimeState::Starting => "Runtime starting",
        RuntimeState::Ready => "Runtime ready",
        RuntimeState::Working => "Runtime working",
        RuntimeState::Cancelling => "Runtime cancelling",
        RuntimeState::Failed => "Runtime failed",
    }
}

fn toolbox_state_label(state: ToolBoxState) -> &'static str {
    match state {
        ToolBoxState::Unknown => "ToolBox unknown",
        ToolBoxState::Connecting => "ToolBox connecting",
        ToolBoxState::Connected => "ToolBox connected",
        ToolBoxState::Degraded => "ToolBox degraded",
        ToolBoxState::Offline => "ToolBox offline",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn approval_hint(expires_at_ms: Option<u64>) -> String {
    let remaining = expires_at_ms.map(|deadline| deadline.saturating_sub(now_millis()) / 1_000);
    match remaining {
        Some(seconds) => format!("←/→ 选择 · Enter 确认 · Esc 拒绝 · {seconds}s 后拒绝"),
        None => "←/→ 选择 · Enter 确认 · Esc 拒绝".into(),
    }
}

fn centered_rect(percent_x: u16, height: u16, area: Rect) -> Rect {
    let width = area.width.saturating_mul(percent_x) / 100;
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height.min(area.height)) / 2,
        width,
        height: height.min(area.height),
    }
}
fn truncate(text: &str, limit: usize) -> String {
    let mut out = text.chars().take(limit).collect::<String>();
    if text.chars().count() > limit {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    fn render(app: &mut App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| app.draw(frame)).expect("draw");
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect()
    }

    #[test]
    fn events_coalesce_streaming_assistant_text() {
        let mut app = App::new();
        app.apply_event(VcpEvent::AssistantDelta { text: "你".into() });
        app.apply_event(VcpEvent::AssistantDelta { text: "好".into() });
        assert_eq!(app.messages[0].body, "你好");
    }
    #[test]
    fn reasoning_is_collapsed_until_toggled() {
        let mut app = App::new();
        app.apply_event(VcpEvent::ReasoningDelta {
            text: "secret thought".into(),
        });
        assert!(!app.messages[0].expanded);
        app.toggle_reasoning();
        assert!(app.messages[0].expanded);
    }
    #[test]
    fn bracketed_paste_preserves_multiline_cjk_text() {
        let mut app = App::new();
        app.handle_paste("你好\nVCP");
        assert_eq!(app.input.text(), "你好\nVCP");
    }
    #[test]
    fn approval_defaults_to_deny() {
        let mut app = App::new();
        app.apply_event(VcpEvent::ApprovalRequested {
            approval_id: "a1".into(),
            tool_name: "vcp_invoke".into(),
            risk: "high".into(),
            reason: "write".into(),
            argument_summary: "{}".into(),
            expires_at_ms: None,
            binding: None,
        });
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            InputAction::Approval {
                approval_id: "a1".into(),
                allowed: false,
                binding: None,
            }
        );
    }
    #[test]
    fn slash_tab_completes_vcp_command() {
        let mut app = App::new();
        app.input.set_text("/the");
        let _ = app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.input.text(), "/theme");
    }
    #[test]
    fn slash_command_enter_opens_theme_picker_without_requiring_ctrl_enter() {
        let mut app = App::new();
        app.input.set_text("/theme");
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            InputAction::None
        );
        assert!(app.theme_picker);
        assert!(app.input.text().is_empty());
    }
    #[test]
    fn theme_picker_accepts_a_mouse_click() {
        let mut app = App::new();
        app.open_theme_picker();
        app.theme_picker_area = Rect::new(20, 10, 44, 13);
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 22,
            // outer border + fourth item (TokyoNight)
            row: 14,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.theme_id, ThemeId::TokyoNight);
        assert!(!app.theme_picker);
    }
    #[test]
    fn welcome_screen_contains_vcpcli_prompt_and_cursor() {
        let mut app = App::new();
        let screen = render(&mut app, 100, 40);
        assert!(screen.contains("VCPCLI"));
        assert!(screen.contains("██╗"));
        assert!(screen.contains("Start typing to begin"));
        assert!(screen.contains('▍'));
    }
    #[test]
    fn compact_welcome_keeps_brand_and_input_hint_at_60_columns() {
        let mut app = App::new();
        let screen = render(&mut app, 60, 24);
        assert!(screen.contains("VCPCLI"));
        assert!(screen.contains("Start typing to begin"));
        assert!(!screen.contains("██╗"));
    }
    #[test]
    fn approval_overlay_keeps_reject_visible_on_narrow_terminal() {
        let mut app = App::new();
        app.apply_event(VcpEvent::ApprovalRequested {
            approval_id: "a1".into(),
            tool_name: "vcp_invoke".into(),
            risk: "high".into(),
            reason: "write".into(),
            argument_summary: "{}".into(),
            expires_at_ms: None,
            binding: None,
        });
        let screen = render(&mut app, 44, 18);
        // The test backend stores the trailing half of a wide CJK cell as a
        // blank cell. Remove those cell placeholders before asserting text.
        let compact = screen.replace(' ', "");
        assert!(compact.contains("审批"));
        assert!(compact.contains("拒绝"));
    }
    #[test]
    fn host_commands_are_returned_without_becoming_chat_messages() {
        let mut app = App::new();
        app.input.set_text("/model gpt-5.6-terra");
        assert_eq!(
            app.submit_input(),
            InputAction::Command("/model gpt-5.6-terra".into())
        );
        app.input.set_text("/steer 先检查测试");
        assert_eq!(
            app.submit_input(),
            InputAction::Command("/steer 先检查测试".into())
        );
        assert!(app.messages.is_empty());
    }
    #[test]
    fn host_notices_are_visible_without_becoming_warnings() {
        let mut app = App::new();
        app.apply_event(VcpEvent::Notice {
            title: "主动交互已排队".into(),
            message: "Steering #1：先检查测试".into(),
        });
        assert_eq!(app.messages[0].kind, MessageKind::Notice);
        assert!(app.messages[0].body.contains("Steering"));
    }
    #[test]
    fn searchable_catalog_picker_returns_a_session_switch_command() {
        let mut app = App::new();
        app.open_choice_picker(
            "agent",
            "Agent",
            vec![
                ChoiceItem {
                    id: "coding".into(),
                    label: "编码助手".into(),
                    detail: String::new(),
                },
                ChoiceItem {
                    id: "nova".into(),
                    label: "Nova".into(),
                    detail: "{{Nova}}".into(),
                },
            ],
        );
        app.handle_key(KeyEvent::new(KeyCode::Char('n'), KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::NONE));
        assert_eq!(
            app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            InputAction::Command("/agent nova".into())
        );
    }
    #[test]
    fn runtime_status_is_projected_without_claiming_toolbox_connection() {
        let mut app = App::new();
        app.apply_event(VcpEvent::RuntimeStatus {
            runtime: RuntimeState::Ready,
            toolbox: ToolBoxState::Offline,
            permission_mode: PermissionMode::Ask,
        });
        let screen = render(&mut app, 100, 40);
        assert!(screen.contains("ToolBox offline"));
    }
    #[test]
    fn expired_approval_is_rejected_on_tick() {
        let mut app = App::new();
        app.apply_event(VcpEvent::ApprovalRequested {
            approval_id: "expired".into(),
            tool_name: "vcp_invoke".into(),
            risk: "high".into(),
            reason: "write".into(),
            argument_summary: "{}".into(),
            expires_at_ms: Some(0),
            binding: None,
        });
        assert_eq!(
            app.handle_tick(),
            Some(InputAction::Approval {
                approval_id: "expired".into(),
                allowed: false,
                binding: None,
            })
        );
    }
    #[test]
    fn cjk_transcript_is_safe_across_supported_terminal_widths() {
        let mut app = App::new();
        app.apply_event(VcpEvent::AssistantDelta {
            text: "你好，VCPAgent 会通过 VCPToolBox 执行操作。".into(),
        });
        app.apply_event(VcpEvent::ToolRequested {
            call_id: "tool-1".into(),
            tool_name: "vcp_invoke".into(),
        });
        app.apply_event(VcpEvent::ToolStatus {
            call_id: "tool-1".into(),
            tool_name: "vcp_invoke".into(),
            status: ToolStatus::Completed,
            detail: "ToolBox 返回成功".into(),
        });
        for width in [60, 80, 120] {
            let screen = render(&mut app, width, 32);
            assert!(screen.contains("VCPCLI"));
            assert!(screen.contains('✓'));
        }
    }
}
