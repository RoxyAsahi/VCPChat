//! Pure token-estimation primitives imported from Grok Build revision 02d9359.
//!
//! These values are estimates. They must never be presented as provider
//! billing usage.

pub const BYTES_PER_TOKEN: u64 = 4;

#[inline]
pub fn estimate_tokens(text: &str) -> u64 {
    (text.len() as u64) / BYTES_PER_TOKEN
}

#[inline]
pub fn estimate_chars(tokens: u64) -> u64 {
    tokens.saturating_mul(BYTES_PER_TOKEN)
}

#[inline]
pub fn usage_percentage(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((used as f64) / (total as f64) * 100.0).min(100.0)
    }
}

#[inline]
pub fn usage_percentage_truncated_u8(used: u64, total: u64) -> u8 {
    if total == 0 {
        0
    } else {
        ((used.saturating_mul(100) / total).min(100)) as u8
    }
}

#[inline]
pub fn free_tokens(total: u64, used: u64) -> u64 {
    total.saturating_sub(used)
}

#[inline]
pub fn exceeds_threshold(used: u64, context_window: u64, threshold_percent: u8) -> bool {
    context_window > 0
        && used.saturating_mul(100) >= context_window.saturating_mul(threshold_percent as u64)
}

#[inline]
pub fn exceeds_threshold_with_headroom(
    used: u64,
    context_window: u64,
    threshold_percent: u8,
    headroom: u64,
) -> bool {
    context_window > 0
        && used.saturating_mul(100)
            >= context_window
                .saturating_mul(threshold_percent as u64)
                .saturating_sub(headroom.saturating_mul(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_bytes_over_four() {
        assert_eq!(estimate_tokens("abc"), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_chars(1000), 4000);
    }

    #[test]
    fn percentage_and_free_tokens_saturate() {
        assert_eq!(usage_percentage_truncated_u8(85, 200), 42);
        assert_eq!(usage_percentage(150, 100), 100.0);
        assert_eq!(free_tokens(100, 150), 0);
    }

    #[test]
    fn threshold_uses_inclusive_boundary_and_headroom() {
        assert!(exceeds_threshold(850, 1000, 85));
        assert!(!exceeds_threshold(849, 1000, 85));
        assert!(exceeds_threshold_with_headroom(810, 1000, 85, 40));
    }
}
