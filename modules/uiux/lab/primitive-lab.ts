import type { UiDisposer, UiScope } from '../contracts.js';
import { mountButton, type ButtonProps } from '../primitives/button.js';
import { mountField } from '../primitives/field.js';
import { mountInput } from '../primitives/input.js';
import { mountMenu } from '../primitives/menu.js';
import { mountModal } from '../primitives/modal.js';
import { mountTooltip } from '../primitives/tooltip.js';
import { mountHoverCard } from '../primitives/hover-card.js';
import { mountDisclosureRow, type DisclosureRowController } from '../primitives/disclosure-row.js';
import { mountStateDot, type StateDotState } from '../primitives/state-dot.js';
import { mountSelect } from '../primitives/select.js';

const STYLE_ID = 'vcp-harness-primitive-lab';

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-primitive-lab{display:grid;gap:20px}.vcp-harness-lab-group{display:grid;gap:10px}.vcp-harness-lab-group>h4{margin:0;font-size:13px;line-height:20px;font-weight:600}.vcp-harness-lab-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}.vcp-harness-lab-field{width:min(360px,100%)}.vcp-harness-lab-input-host{display:inline-flex}.vcp-harness-lab-provenance{margin:0;color:var(--dsw-alias-label-tertiary,var(--vcp-color-text-muted,#737780));font-size:12px;line-height:18px}`;
    (document.head || document.documentElement).append(style);
}

function group(root: HTMLElement, title: string, provenance: string) {
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
export function mountPrimitiveLab(root: HTMLElement, scope: UiScope): UiDisposer {
    if (!root || !scope) throw new TypeError('Primitive lab requires root and scope.');
    ensureStyles();
    const labScope = scope.child('harness-primitive-lab');
    const originalNodes = Array.from(root.childNodes);
    const lab = document.createElement('div');
    lab.className = 'vcp-harness-primitive-lab';
    lab.dataset.maturity = 'candidate';
    root.replaceChildren(lab);

    const buttonRow = group(lab, 'Button', 'deepseek-harness/packages/client/ui-primitives/src/Button.tsx');
    const variants: ReadonlyArray<[string, ButtonProps]> = [
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

    const modalRow = group(lab, 'Modal', 'deepseek-harness/packages/client/ui-primitives/src/Modal.tsx + Workspace/Settings production consumers');
    const modalTrigger = document.createElement('button');
    modalTrigger.type = 'button';
    modalTrigger.textContent = 'Open modal';
    modalRow.append(modalTrigger);
    mountButton(modalTrigger, { variant: 'outline', size: 'sm' }, labScope);
    const modalBody = document.createElement('div');
    modalBody.textContent = 'Create a workspace without leaving the current page.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'Create';
    mountButton(cancel, { variant: 'outline', size: 'sm' }, labScope);
    mountButton(create, { variant: 'primary', size: 'sm' }, labScope);
    const modal = mountModal({
        title: 'Create workspace',
        closeLabel: 'Close dialog',
        description: 'Choose a name and location for the workspace.',
        body: modalBody,
        footer: [cancel, create],
        onClose: () => modal.setOpen(false),
    }, labScope);
    labScope.listen(modalTrigger, 'click', () => modal.setOpen(true));
    labScope.listen(cancel, 'click', () => modal.setOpen(false));
    labScope.listen(create, 'click', () => { modalTrigger.dataset.result = 'create'; modal.setOpen(false); });

    const headlessTrigger = document.createElement('button');
    headlessTrigger.type = 'button';
    headlessTrigger.textContent = 'Open headless';
    modalRow.append(headlessTrigger);
    mountButton(headlessTrigger, { variant: 'ghost', size: 'sm' }, labScope);
    const headlessBody = document.createElement('div');
    headlessBody.className = 'vcp-harness-lab-headless-modal';
    const headlessTitle = document.createElement('h2');
    headlessTitle.textContent = 'Custom modal frame';
    const headlessClose = document.createElement('button');
    headlessClose.type = 'button';
    headlessClose.textContent = 'Close';
    mountButton(headlessClose, { variant: 'outline', size: 'sm' }, labScope);
    headlessBody.append(headlessTitle, headlessClose);
    const headless = mountModal({ title: 'Custom modal frame', body: headlessBody, headless: true, onClose: () => headless.setOpen(false) }, labScope);
    labScope.listen(headlessTrigger, 'click', () => headless.setOpen(true));
    labScope.listen(headlessClose, 'click', () => headless.setOpen(false));

    const tooltipRow = group(lab, 'Tooltip / HoverCard', 'deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx + HoverCard.tsx; Goal/Sidebar/Workspace consumers');
    const tooltipButton = document.createElement('button');
    tooltipButton.type = 'button';
    tooltipButton.textContent = 'Hover for details';
    tooltipRow.append(tooltipButton);
    mountButton(tooltipButton, { variant: 'toolbar', size: 'sm' }, labScope);
    mountTooltip(tooltipButton, { label: 'Open workspace details', side: 'bottom', delayMs: 120 }, labScope);

    const hoverAnchor = document.createElement('div');
    hoverAnchor.className = 'vcp-harness-lab-hover-anchor';
    hoverAnchor.textContent = 'Workspace path';
    tooltipRow.append(hoverAnchor);
    const hoverContent = document.createElement('div');
    hoverContent.className = 'vcp-harness-lab-hover-content';
    hoverContent.textContent = '/Users/asahi/Documents/Codex/VCPChat-newarchitecture';
    mountHoverCard(hoverAnchor, {
        content: hoverContent,
        openDelayMs: 120,
        copyText: '/Users/asahi/Documents/Codex/VCPChat-newarchitecture',
        copyLabel: 'Copy path',
        copiedLabel: 'Copied',
    }, labScope);

    const disclosureRow = group(lab, 'DisclosureRow', 'deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.tsx + ToolRow/WorkflowRun production consumers');
    const disclosureHost = document.createElement('div');
    disclosureHost.className = 'vcp-harness-lab-disclosure-host';
    disclosureRow.append(disclosureHost);
    const disclosureIcon = document.createElement('span');
    disclosureIcon.className = 'vcp-ui-icon';
    disclosureIcon.textContent = 'terminal';
    const disclosureSummary = document.createElement('span');
    disclosureSummary.className = 'vcp-harness-lab-disclosure-summary';
    disclosureSummary.textContent = ' · npm run check:uiux';
    const disclosureBody = document.createElement('div');
    disclosureBody.className = 'vcp-harness-lab-disclosure-body';
    disclosureBody.textContent = 'UIUX contract verification completed successfully.';
    let disclosure: DisclosureRowController;
    disclosure = mountDisclosureRow(disclosureHost, {
        icon: disclosureIcon,
        title: 'Terminal',
        open: false,
        expandable: true,
        expandOnRowClick: true,
        keepContentWhenOpen: true,
        collapsedContent: disclosureSummary,
        children: disclosureBody,
        onToggle: () => disclosure.setOpen(!disclosure.open),
    }, labScope);

    const stateDotRow = group(lab, 'StateDot', 'deepseek-harness/packages/client/ui-primitives/src/StateDot.tsx + Jobs/Workflow/Workspace production consumers');
    (['done', 'warning', 'ongoing', 'error'] as const satisfies readonly StateDotState[]).forEach(state => {
        const fixture = document.createElement('span');
        fixture.className = 'vcp-harness-lab-state-dot-fixture';
        fixture.dataset.state = state;
        const dotHost = document.createElement('span');
        const label = document.createElement('span');
        label.textContent = state;
        fixture.append(dotHost, label);
        stateDotRow.append(fixture);
        mountStateDot(dotHost, { state }, labScope);
    });

    return scope.own(async () => {
        await labScope.dispose('primitive-lab-unmounted');
        root.replaceChildren(...originalNodes);
    }, 'harness-primitive-lab', 'ui-surface');
}
