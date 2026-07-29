use ratatui::style::Color;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeId {
    Auto,
    VcpNight,
    VcpDay,
    TokyoNight,
    RosePineMoon,
    OscuraMidnight,
    Terminal,
}

impl ThemeId {
    pub const ALL: [Self; 7] = [
        Self::Auto,
        Self::VcpNight,
        Self::VcpDay,
        Self::TokyoNight,
        Self::RosePineMoon,
        Self::OscuraMidnight,
        Self::Terminal,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::VcpNight => "VCPNight",
            Self::VcpDay => "VCPDay",
            Self::TokyoNight => "TokyoNight",
            Self::RosePineMoon => "Rose Pine Moon",
            Self::OscuraMidnight => "Oscura Midnight",
            Self::Terminal => "Terminal Default",
        }
    }

    pub fn next(self) -> Self {
        let index = Self::ALL.iter().position(|item| *item == self).unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }

    pub fn from_name(value: &str) -> Self {
        let normalized = value.to_lowercase().replace([' ', '-'], "");
        Self::ALL
            .iter()
            .copied()
            .find(|theme| theme.name().to_lowercase().replace([' ', '-'], "") == normalized)
            .unwrap_or(Self::Auto)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub background: Color,
    pub surface: Color,
    pub surface_strong: Color,
    pub foreground: Color,
    pub muted: Color,
    pub subtle: Color,
    pub accent: Color,
    pub accent_alt: Color,
    pub success: Color,
    pub warning: Color,
    pub error: Color,
    pub selection: Color,
    pub prompt_border: Color,
}

impl Theme {
    pub fn resolve(id: ThemeId) -> Self {
        match id {
            ThemeId::Auto | ThemeId::VcpNight => Self::night(),
            ThemeId::VcpDay => Self {
                background: Color::Rgb(238, 238, 238),
                surface: Color::Rgb(222, 222, 222),
                surface_strong: Color::Rgb(228, 228, 228),
                foreground: Color::Rgb(38, 38, 38),
                muted: Color::Rgb(118, 118, 118),
                subtle: Color::Rgb(165, 165, 165),
                accent: Color::Rgb(47, 100, 210),
                accent_alt: Color::Rgb(125, 75, 198),
                success: Color::Rgb(55, 142, 35),
                warning: Color::Rgb(162, 118, 18),
                error: Color::Rgb(205, 48, 72),
                selection: Color::Rgb(198, 198, 198),
                prompt_border: Color::Rgb(165, 165, 175),
            },
            ThemeId::TokyoNight => Self {
                background: Color::Rgb(26, 27, 38),
                surface: Color::Rgb(36, 40, 59),
                surface_strong: Color::Rgb(41, 46, 66),
                foreground: Color::Rgb(192, 202, 245),
                muted: Color::Rgb(86, 95, 137),
                subtle: Color::Rgb(59, 66, 97),
                accent: Color::Rgb(122, 162, 247),
                accent_alt: Color::Rgb(187, 154, 247),
                success: Color::Rgb(158, 206, 106),
                warning: Color::Rgb(224, 175, 104),
                error: Color::Rgb(247, 118, 142),
                selection: Color::Rgb(40, 52, 87),
                prompt_border: Color::Rgb(75, 92, 140),
            },
            ThemeId::RosePineMoon => Self {
                background: Color::Rgb(35, 33, 54),
                surface: Color::Rgb(42, 39, 63),
                surface_strong: Color::Rgb(57, 53, 82),
                foreground: Color::Rgb(224, 222, 244),
                muted: Color::Rgb(144, 140, 170),
                subtle: Color::Rgb(86, 82, 110),
                accent: Color::Rgb(196, 167, 231),
                accent_alt: Color::Rgb(235, 188, 186),
                success: Color::Rgb(156, 207, 216),
                warning: Color::Rgb(246, 193, 119),
                error: Color::Rgb(235, 111, 146),
                selection: Color::Rgb(86, 82, 110),
                prompt_border: Color::Rgb(86, 82, 110),
            },
            ThemeId::OscuraMidnight => Self {
                background: Color::Rgb(3, 3, 4),
                surface: Color::Rgb(15, 18, 22),
                surface_strong: Color::Rgb(4, 5, 7),
                foreground: Color::Rgb(228, 228, 228),
                muted: Color::Rgb(129, 134, 143),
                subtle: Color::Rgb(94, 100, 108),
                accent: Color::Rgb(196, 167, 231),
                accent_alt: Color::Rgb(155, 126, 206),
                success: Color::Rgb(80, 180, 140),
                warning: Color::Rgb(235, 217, 110),
                error: Color::Rgb(220, 90, 100),
                selection: Color::Rgb(52, 48, 72),
                prompt_border: Color::Rgb(52, 48, 72),
            },
            ThemeId::Terminal => Self {
                background: Color::Reset,
                surface: Color::Reset,
                surface_strong: Color::Reset,
                foreground: Color::Reset,
                muted: Color::DarkGray,
                subtle: Color::Black,
                accent: Color::Blue,
                accent_alt: Color::Magenta,
                success: Color::Green,
                warning: Color::Yellow,
                error: Color::Red,
                selection: Color::Blue,
                prompt_border: Color::DarkGray,
            },
        }
    }

    fn night() -> Self {
        Self {
            background: Color::Rgb(20, 20, 20),
            surface: Color::Rgb(36, 36, 36),
            surface_strong: Color::Rgb(28, 28, 28),
            foreground: Color::Rgb(225, 225, 225),
            muted: Color::Rgb(108, 108, 108),
            subtle: Color::Rgb(88, 88, 88),
            accent: Color::Rgb(122, 162, 247),
            accent_alt: Color::Rgb(187, 154, 247),
            success: Color::Rgb(158, 206, 106),
            warning: Color::Rgb(224, 175, 104),
            error: Color::Rgb(247, 118, 142),
            selection: Color::Rgb(54, 54, 54),
            prompt_border: Color::Rgb(80, 80, 88),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_themes_have_a_stable_cycle() {
        assert_eq!(ThemeId::Terminal.next(), ThemeId::Auto);
        assert_eq!(ThemeId::VcpNight.next(), ThemeId::VcpDay);
    }
}
