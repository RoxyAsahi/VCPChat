//! Watchdog policy for the exclusive (WASAPI) output loop: a device that
//! stops taking audio is restarted once, then given up so the player can
//! reopen the output in shared mode.

/// What the exclusive output loop should do when the device has not taken
/// any audio this time round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallAction {
    /// Still within the grace period.
    Wait,
    /// Stalled once: stop and restart the stream, which unsticks most drivers.
    ResetStream,
    /// Still stalled after a restart: give the output up.
    GiveUp,
}

/// Watchdog for the exclusive output loop. Time is passed in (milliseconds
/// on any monotonic clock) so the policy is testable without a device.
#[derive(Debug, Clone)]
pub struct StallWatch {
    last_progress_ms: u64,
    resets: u32,
}

impl StallWatch {
    /// How long the device may go without taking audio before it counts as stalled.
    pub const STALL_MS: u64 = 3000;
    /// Stream restarts tried before giving up.
    pub const MAX_RESETS: u32 = 1;

    pub fn new(now_ms: u64) -> Self {
        Self { last_progress_ms: now_ms, resets: 0 }
    }

    /// The device took audio, or the stream was (re)started on purpose.
    pub fn progressed(&mut self, now_ms: u64) {
        self.last_progress_ms = now_ms;
        self.resets = 0;
    }

    /// The device did not take audio this round.
    pub fn idle(&mut self, now_ms: u64) -> StallAction {
        if now_ms.saturating_sub(self.last_progress_ms) < Self::STALL_MS {
            return StallAction::Wait;
        }
        if self.resets < Self::MAX_RESETS {
            self.resets += 1;
            // A restart gets a fresh grace period.
            self.last_progress_ms = now_ms;
            return StallAction::ResetStream;
        }
        StallAction::GiveUp
    }
}

#[cfg(test)]
mod stall_watch_tests {
    use super::*;

    #[test]
    fn a_device_that_keeps_taking_audio_never_trips() {
        let mut w = StallWatch::new(0);
        for t in (0..60_000).step_by(10) {
            assert_eq!(w.idle(t), StallAction::Wait);
            w.progressed(t);
        }
    }

    #[test]
    fn a_stuck_device_is_restarted_once_then_given_up() {
        let mut w = StallWatch::new(0);
        assert_eq!(w.idle(2_999), StallAction::Wait);
        assert_eq!(w.idle(3_000), StallAction::ResetStream);
        assert_eq!(w.idle(5_000), StallAction::Wait);
        assert_eq!(w.idle(6_000), StallAction::GiveUp);
    }

    #[test]
    fn recovering_after_a_restart_earns_another_restart_later() {
        let mut w = StallWatch::new(0);
        assert_eq!(w.idle(3_000), StallAction::ResetStream);
        w.progressed(3_100);
        assert_eq!(w.idle(6_200), StallAction::ResetStream);
    }
}
