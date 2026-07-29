use std::sync::OnceLock;

use anstyle::{Ansi256Color, AnsiColor, Color as AnsiStyleColor, Style as AnsiStyle};
use ratatui::{style::Color, text::Line};
use vcp_grok_markdown::{MarkdownStyle, StreamingMarkdownRenderer, Syntect};

use crate::theme::Theme;

pub struct MarkdownBlockRenderer {
    renderer: StreamingMarkdownRenderer,
    width: Option<usize>,
}

impl MarkdownBlockRenderer {
    pub fn new(theme: Theme) -> Self {
        Self {
            renderer: StreamingMarkdownRenderer::new(markdown_style(theme), true),
            width: None,
        }
    }

    pub fn push(&mut self, chunk: &str) {
        self.renderer
            .push_and_render(chunk, Some(syntax_highlighter()));
    }

    pub fn finish(&mut self) {
        self.renderer.finish(Some(syntax_highlighter()));
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.renderer.set_style(markdown_style(theme));
        self.renderer.render(Some(syntax_highlighter()));
    }

    pub fn lines(&mut self, width: usize) -> Vec<Line<'static>> {
        let width = Some(width.max(1));
        if self.width != width {
            self.width = width;
            self.renderer.set_max_table_width(width);
            self.renderer.render(Some(syntax_highlighter()));
        }
        self.renderer.view().lines.to_vec()
    }
}

fn syntax_highlighter() -> &'static Syntect {
    static SYNTECT: OnceLock<Syntect> = OnceLock::new();
    SYNTECT.get_or_init(|| {
        Syntect::new(include_bytes!(
            "../../../../rust/crates/vcp-grok-markdown/assets/tokyo-night.tmTheme"
        ))
    })
}

fn markdown_style(theme: Theme) -> MarkdownStyle {
    let heading_colors = [
        theme.accent,
        theme.accent_alt,
        theme.success,
        theme.warning,
        theme.accent,
        theme.accent_alt,
    ];
    MarkdownStyle {
        heading_inner: heading_colors.map(|color| foreground(color).bold()),
        heading_outer: heading_colors.map(|color| foreground(color).dimmed().hidden()),
        strong_inner: foreground(theme.foreground).bold(),
        strong_outer: AnsiStyle::new().dimmed().hidden(),
        emphasis_inner: foreground(theme.foreground).italic(),
        emphasis_outer: AnsiStyle::new().dimmed().hidden(),
        strikethrough_inner: foreground(theme.foreground).strikethrough(),
        strikethrough_outer: AnsiStyle::new().dimmed().hidden(),
        inline_code_inner: foreground(theme.warning).bold(),
        inline_code_outer: foreground(theme.warning).dimmed().hidden(),
        blockquote_outer: foreground(theme.muted).dimmed(),
        task_checked: foreground(theme.success),
        task_unchecked: foreground(theme.muted).dimmed(),
        list_item: foreground(theme.accent),
        rule: foreground(theme.subtle),
        link_outer: foreground(theme.muted),
        link_text: foreground(theme.accent).underline(),
        link_url: foreground(theme.muted),
        link_title: foreground(theme.success),
        code_outer: foreground(theme.warning).dimmed().hidden(),
        code_language: foreground(theme.accent_alt).hidden(),
        code_untagged: foreground(theme.foreground),
        code_background: background(theme.surface_strong),
        table_outer: foreground(theme.accent).hidden(),
        text: foreground(theme.foreground),
        math: foreground(theme.foreground).italic(),
    }
}

fn foreground(color: Color) -> AnsiStyle {
    AnsiStyle::new().fg_color(to_anstyle(color))
}

fn background(color: Color) -> AnsiStyle {
    AnsiStyle::new().bg_color(to_anstyle(color))
}

fn to_anstyle(color: Color) -> Option<AnsiStyleColor> {
    Some(match color {
        Color::Reset => return None,
        Color::Rgb(red, green, blue) => AnsiStyleColor::Rgb(anstyle::RgbColor(red, green, blue)),
        Color::Indexed(index) => AnsiStyleColor::Ansi256(Ansi256Color(index)),
        Color::Black => AnsiStyleColor::Ansi(AnsiColor::Black),
        Color::Red => AnsiStyleColor::Ansi(AnsiColor::Red),
        Color::Green => AnsiStyleColor::Ansi(AnsiColor::Green),
        Color::Yellow => AnsiStyleColor::Ansi(AnsiColor::Yellow),
        Color::Blue => AnsiStyleColor::Ansi(AnsiColor::Blue),
        Color::Magenta => AnsiStyleColor::Ansi(AnsiColor::Magenta),
        Color::Cyan => AnsiStyleColor::Ansi(AnsiColor::Cyan),
        Color::Gray => AnsiStyleColor::Ansi(AnsiColor::White),
        Color::DarkGray => AnsiStyleColor::Ansi(AnsiColor::BrightBlack),
        Color::LightRed => AnsiStyleColor::Ansi(AnsiColor::BrightRed),
        Color::LightGreen => AnsiStyleColor::Ansi(AnsiColor::BrightGreen),
        Color::LightYellow => AnsiStyleColor::Ansi(AnsiColor::BrightYellow),
        Color::LightBlue => AnsiStyleColor::Ansi(AnsiColor::BrightBlue),
        Color::LightMagenta => AnsiStyleColor::Ansi(AnsiColor::BrightMagenta),
        Color::LightCyan => AnsiStyleColor::Ansi(AnsiColor::BrightCyan),
        Color::White => AnsiStyleColor::Ansi(AnsiColor::BrightWhite),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vcp_grok_markdown::render_markdown_ratatui_full;

    fn text(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn streaming_and_full_render_match_for_cjk_table_code_and_link() {
        let theme = Theme::resolve(crate::theme::ThemeId::TokyoNight);
        let source = "# 标题\n\n| 项目 | 状态 |\n| --- | --- |\n| 编译 | **通过** |\n\n```rust\nfn main() {}\n```\n\n[文档](https://example.com)";
        let mut streaming = MarkdownBlockRenderer::new(theme);
        for chunk in [
            "# 标",
            "题\n\n| 项目",
            " | 状态 |\n| --- |",
            " --- |\n| 编译 | **通",
            "过** |\n\n```rust\nfn main() {}",
            "\n```\n\n[文档](https://example.com)",
        ] {
            streaming.push(chunk);
        }
        streaming.finish();
        let streamed = streaming.lines(72);
        let (full, _) = render_markdown_ratatui_full(
            source,
            markdown_style(theme),
            true,
            Some(syntax_highlighter()),
        );
        assert_eq!(text(&streamed), text(&full.lines));
        assert!(text(&streamed).contains("标题"));
        assert!(text(&streamed).contains("编译"));
    }

    #[test]
    fn reset_theme_keeps_terminal_default_colors_unset() {
        assert_eq!(to_anstyle(Color::Reset), None);
        let theme = Theme::resolve(crate::theme::ThemeId::Terminal);
        assert_eq!(markdown_style(theme).text.get_fg_color(), None);
    }
}
