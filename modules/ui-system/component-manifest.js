// `status` describes the VCP component API. `harnessMaturity` is a separate
// evidence gate: a stable VCP API is not automatically Harness-equivalent.
const stable = (name, category, aliases = [], options = {}) => Object.freeze({
    name, category, aliases, status: 'stable', since: '1.0.0',
    harnessMaturity: options.harnessMaturity || 'legacy-compatibility',
    productionEligible: options.productionEligible === true,
    ...options
});
const candidate = (name, category, aliases = [], options = {}) => Object.freeze({
    name, category, aliases, status: 'candidate', since: '1.1.0',
    harnessMaturity: options.harnessMaturity || 'candidate-lab',
    productionEligible: false,
    ...options
});

export const COMPONENT_MANIFEST = Object.freeze([
    stable('Button', 'actions'),
    candidate('IconButton', 'actions'),
    stable('Input', 'forms'),
    stable('Textarea', 'forms'),
    stable('Select', 'forms'),
    stable('Range', 'forms'),
    stable('SettingsSection', 'forms'),
    stable('SettingsActionBar', 'forms'),
    candidate('Checkbox', 'forms'),
    stable('Switch', 'forms'),
    stable('Field', 'forms'),
    candidate('Badge', 'foundation'),
    candidate('Alert', 'foundation'),
    candidate('Card', 'foundation'),
    candidate('Tabs', 'navigation'),
    candidate('Toolbar', 'actions'),
    // Demoted from stable (2026-08-27): the production consumer was removed by
    // 10e0adb0 and no next-architecture surface mounts List anymore; its stale
    // consumer-evidence record pointed at deleted markers. Re-promote only
    // together with a real production consumer + Electron evidence record.
    candidate('List', 'navigation', ['ListItem']),
    candidate('TableFrame', 'data'),
    candidate('EmptyState', 'foundation'),
    stable('Modal', 'feedback'),
    stable('Toast', 'feedback'),
    candidate('ConfirmDialog', 'feedback'),
    candidate('InputDialog', 'feedback'),
    candidate('Divider', 'foundation'),
    candidate('Tooltip', 'feedback'),
    candidate('Skeleton', 'foundation'),
    stable('SegmentedControl', 'actions'),
    candidate('Pagination', 'data'),
    candidate('ScrollArea', 'data'),
    candidate('AppPageShell', 'application'),
    candidate('WindowControls', 'application'),
    candidate('AsyncBoundary', 'feedback')
]);
