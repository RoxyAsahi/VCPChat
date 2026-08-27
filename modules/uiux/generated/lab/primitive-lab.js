import { mountButton } from '../primitives/button.js';
import { mountField } from '../primitives/field.js';
import { mountInput } from '../primitives/input.js';
import { mountMenu } from '../primitives/menu.js';
import { mountSelect } from '../primitives/select.js';
const STYLE_ID = 'vcp-harness-primitive-lab';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-primitive-lab{display:grid;gap:20px}.vcp-harness-lab-group{display:grid;gap:10px}.vcp-harness-lab-group>h4{margin:0;font-size:13px;line-height:20px;font-weight:600}.vcp-harness-lab-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.vcp-harness-lab-field{width:min(360px,100%)}.vcp-harness-lab-input-host{display:inline-flex}.vcp-harness-lab-provenance{margin:0;color:var(--dsw-alias-label-tertiary,var(--vcp-color-text-muted,#737780));font-size:12px;line-height:18px}`;
    (document.head || document.documentElement).append(style);
}
function group(root, title, provenance) {
    const host = document.createElement('section');
    host.className = 'vcp-harness-lab-group';
    const heading = document.createElement('h4');
    heading.textContent = title;
    const source = document.createElement('p');
    source.className = 'vcp-harness-lab-provenance';
    source.textContent = provenance;
    const row = document.createElement('div');
    row.className = 'vcp-harness-lab-row';
    host.append(heading, source, row);
    root.append(host);
    return row;
}
/** Candidate-only fixture host. It owns presentation state and no business state. */
export function mountPrimitiveLab(root, scope) {
    if (!root || !scope)
        throw new TypeError('Primitive lab requires root and scope.');
    ensureStyles();
    const labScope = scope.child('harness-primitive-lab');
    const originalNodes = Array.from(root.childNodes);
    const lab = document.createElement('div');
    lab.className = 'vcp-harness-primitive-lab';
    lab.dataset.maturity = 'candidate';
    root.replaceChildren(lab);
    const buttonRow = group(lab, 'Button', 'deepseek-harness/packages/client/ui-primitives/src/Button.tsx');
    const variants = [
        ['Primary', { variant: 'primary' }],
        ['Ghost', { variant: 'ghost' }],
        ['Outline', { variant: 'outline' }],
        ['Toolbar', { variant: 'toolbar' }],
        ['Compact', { variant: 'ghost', size: 'sm' }],
        ['Disabled', { variant: 'primary', disabled: true }],
    ];
    variants.forEach(([label, props]) => {
        const button = document.createElement('button');
        button.textContent = label;
        buttonRow.append(button);
        mountButton(button, props, labScope);
    });
    const inputRow = group(lab, 'Input', 'deepseek-harness/packages/client/ui-primitives/src/Input.tsx');
    const inputHost = document.createElement('span');
    inputHost.className = 'vcp-harness-lab-input-host';
    const input = document.createElement('input');
    input.placeholder = 'Search';
    inputHost.append(input);
    inputRow.append(inputHost);
    const searchIcon = document.createElement('span');
    searchIcon.className = 'vcp-ui-icon';
    searchIcon.textContent = 'search';
    mountInput(input, { icon: searchIcon }, labScope);
    const fieldRow = group(lab, 'Field', 'deepseek-harness/packages/client/ui-settings-plugins ValueField production contract');
    const field = document.createElement('div');
    field.className = 'vcp-harness-lab-field';
    const fieldInput = document.createElement('input');
    field.append(fieldInput);
    fieldRow.append(field);
    mountField(field, { label: 'Workspace name', description: 'Shown in the workspace switcher.', control: fieldInput }, labScope);
    const selectRow = group(lab, 'Select / Menu', 'deepseek-harness AgentPresetSeat + ui-primitives/Menu production contracts');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Agent preset');
    ['Standard mode', 'Minimal mode', 'Planning mode'].forEach(label => {
        const option = document.createElement('option');
        option.value = label;
        option.textContent = label;
        select.append(option);
    });
    selectRow.append(select);
    mountSelect(select, { label: 'Agent preset', portal: true }, labScope);
    const menuRow = group(lab, 'Menu atom', 'deepseek-harness/packages/client/ui-primitives/src/Menu.tsx + WorkspaceBrowser production consumer');
    const menuTrigger = document.createElement('button');
    menuTrigger.type = 'button';
    menuTrigger.textContent = 'View options';
    menuRow.append(menuTrigger);
    const menu = mountMenu(menuTrigger, {
        portal: true,
        dense: true,
        selectedIds: ['workspace', 'updated'],
        items: [
            { type: 'label', id: 'group-label', text: 'Group by' },
            { id: 'workspace', label: 'Workspace' },
            { id: 'flat', label: 'Flat list' },
            { type: 'separator', id: 'order-separator' },
            { type: 'label', id: 'order-label', text: 'Order by' },
            { id: 'manual', label: 'Manual' },
            { id: 'updated', label: 'Recently updated' },
            { id: 'disabled', label: 'Unavailable', disabled: true },
            { id: 'danger', label: 'Remove view', danger: true },
            { id: 'layout', label: 'Layout', submenu: [{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }] },
        ],
        footer: [{ id: 'settings', label: 'View settings' }],
        onSelect: id => {
            menuTrigger.dataset.selected = id;
            menu.setOpen(false);
        },
    }, labScope);
    labScope.listen(menuTrigger, 'click', () => menu.setOpen(!menu.open));
    return scope.own(async () => {
        await labScope.dispose('primitive-lab-unmounted');
        root.replaceChildren(...originalNodes);
    }, 'harness-primitive-lab', 'ui-surface');
}
