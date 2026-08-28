import assert from 'node:assert/strict';
import fs from 'node:fs';

const files = [
    'styles/base.css',
    'styles/components.css',
    'styles/layout.css',
    'styles/ui-next.css',
    'styles/ui-system/components.css',
    'styles/ui-system/tokens.css',
    'styles/ui-system/motion.css',
    'styles/setting/settings-agent-identity.css',
    'styles/setting/settings-model-select.css',
    ...fs.readdirSync('styles/themes').filter(file => file.endsWith('.css')).map(file => `styles/themes/${file}`),
    'styles/ui-system/appearance-studio.css',
    'styles/ui-system/ask-nova.css',
];
const source = files.map(file => fs.readFileSync(file, 'utf8'));
const tokens = fs.readFileSync('styles/ui-system/tokens.css', 'utf8');
for (const token of [
    '--vcp-motion-duration-instant',
    '--vcp-motion-duration-fast',
    '--vcp-motion-duration-standard',
    '--vcp-motion-duration-normal',
    '--vcp-motion-duration-slow',
    '--vcp-motion-duration-spinner',
    '--vcp-motion-duration-ambient',
    '--vcp-motion-duration-flow',
    '--vcp-motion-duration-reveal',
    '--vcp-motion-delay-reveal',
    '--vcp-motion-ease-standard',
    '--vcp-motion-ease-emphasized',
    '--vcp-motion-ease-linear',
]) {
    assert.ok(tokens.includes(`${token}:`), `missing motion token: ${token}`);
}
assert.ok(source.some(css => css.includes('@media (prefers-reduced-motion: reduce)')),
    'at least one UI stylesheet must define reduced-motion behavior');
const requiredSelectors = [
    ['styles/ui-next.css', '.next-ui-launchpad'],
    ['styles/ui-system/sidebar.css', '.next-ui-account-menu'],
    ['styles/ui-system/notifications.css', '.next-ui-notification-menu'],
    ['styles/ui-system/components.css', '.vcp-ui-modal-overlay'],
];
for (const selector of requiredSelectors) {
    const [file, value] = selector;
    assert.ok(fs.readFileSync(file, 'utf8').includes(value), `missing motion surface selector: ${value}`);
}
for (const css of source) {
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?(?=\n\s*@media|\n\s*\/\*|$)/g) || [];
    assert.ok(reduced.every(block => !/animation-duration:\s*(?:[2-9]\d*|\d{2,})ms\b/.test(block)),
        'reduced-motion blocks may only use zero or the conventional 1ms terminal duration');
}
for (const file of [
    'styles/base.css',
    'styles/components.css',
    'styles/notifications.css',
    'styles/ui-system/motion.css',
    'styles/setting/settings-agent-identity.css',
    'styles/setting/settings-model-select.css',
    ...fs.readdirSync('styles/themes').filter(file => file.endsWith('.css')).map(file => `styles/themes/${file}`),
]) {
    const css = fs.readFileSync(file, 'utf8');
    assert.ok(!/transition:\s*all\b/.test(css), `${file} must not use transition: all`);
}
const toastSource = fs.readFileSync('modules/uiux/primitives/toast.ts', 'utf8');
const tooltipSource = fs.readFileSync('modules/uiux/primitives/tooltip.ts', 'utf8');
const modalSource = fs.readFileSync('modules/uiux/primitives/modal.ts', 'utf8');
assert.match(toastSource, /root\.dataset\.motion\s*=\s*['"]enter['"]/, 'Toast must publish enter state');
assert.match(tooltipSource, /bubble\.dataset\.motion\s*=\s*['"]enter['"]/, 'Tooltip must publish enter state');
assert.match(modalSource, /root\.dataset\.motion\s*=\s*['"]enter['"]/, 'Modal must publish enter state');
assert.match(toastSource, /TOAST_HOLD_MS\s*\+\s*TOAST_FADE_MS/, 'Toast owner lifetime must cover hold + fade');
assert.match(toastSource, /vcp-motion-toast-hold/, 'Toast CSS must use shared hold token');
assert.match(toastSource, /vcp-motion-toast-fade/, 'Toast CSS must use shared fade token');
console.log(`UI motion contract passed: ${files.length} stylesheets inspected`);
