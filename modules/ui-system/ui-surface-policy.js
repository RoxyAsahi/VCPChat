// Product allowlist for child business pages that are ready to use the
// next-UI presentation. Excluded pages remain byte-identical to upstream and
// therefore always use their proven Classic presentation.

// The first upstream design-system PR intentionally keeps every child
// business page on its upstream Classic presentation. Child-page migrations
// can be proposed independently after the shared shell has landed. The
// scripts/test-page-runtime.mjs gate asserts this allowlist stays empty and
// that no registered child page loads a Next-UI runtime.
const ACTIVE_NEXT_UI_SURFACES = Object.freeze([]);

export {
    ACTIVE_NEXT_UI_SURFACES,
};
