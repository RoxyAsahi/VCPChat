// canonical-rows — one canonical row system for the unified settings surface.
// The upstream form row is retained as the business anchor; geometry, spacing
// and typography belong to the canonical wrapper.
import { sectionKeyForRow, sectionKeyForTitle } from './section-ownership.js';
function removeLegacySubsectionHeadings(form) {
    form.querySelectorAll('.vcp-harness-editor-section-heading').forEach(heading => {
        const section = heading.closest('.settings-section');
        // The section h3 is the single canonical heading.  Subsection cards
        // must not introduce a second title/description stack.
        if (section?.querySelector(':scope > .settings-section-title')) heading.remove();
    });
}

function mountCanonicalSettingsRows(form) {
    if (!form) return;
    form.querySelectorAll(':scope > .settings-section').forEach(section => {
        const title = section.querySelector(':scope > .settings-section-title')?.textContent;
        const key = sectionKeyForTitle(title);
        if (key) section.dataset.settingsSectionKey = key;
    });
    const candidates = form.querySelectorAll(
        ':scope [data-vcp-settings-row], :scope [data-vcp-settings-control-row], :scope .vcp-settings-row, :scope .vcp-settings-control-row, :scope .settings-form-group, :scope .form-group-inline, :scope > .form-group, :scope .form-group'
    );
    candidates.forEach(row => {
        if (!(row instanceof HTMLElement) || row.closest('.vcp-harness-general-item')) return;
        if (!row.querySelector('input, select, textarea, button, [role="switch"]')) return;
        const keyNode = row.querySelector('[name], [id]');
        const key = keyNode?.getAttribute('name') || keyNode?.id || '';
        const item = document.createElement(row.tagName.toLowerCase());
        const preservedClasses = [...row.classList].filter(className => ![
            'settings-form-group', 'form-group-inline', 'vcp-settings-row', 'vcp-settings-control-row',
            'form-group'
        ].includes(className));
        item.className = ['vcp-harness-general-item', 'vcp-harness-general-row', ...preservedClasses].join(' ');
        for (const attribute of row.attributes) {
            if (attribute.name === 'class' || attribute.name === 'style') continue;
            item.setAttribute(attribute.name, attribute.value);
        }
        item.dataset.settingPrimitive = 'general-item';
        const sectionKey = sectionKeyForRow(row);
        if (sectionKey) item.dataset.settingsSectionKey = sectionKey;
        const appearanceOwner = row.closest('.appearance-settings-section, .appearance-sidebar-geometry-section, .appearance-home-tagline-setting');
        if (appearanceOwner) {
            item.dataset.settingPrimitive = 'appearance-row';
            item.classList.add('vcp-harness-appearance-row');
        }
        if (key) item.dataset.settingKey = key;
        item.dataset.canonicalRow = 'true';
        row.replaceWith(item);
        item.append(...[...row.childNodes]);
        row.remove();
        composeCanonicalRowSlots(item);
    });
    form.dataset.vcpCanonicalRowsMounted = 'true';
}

function composeCanonicalRowSlots(row) {
    if (!row || row.matches('label, fieldset') || row.querySelector(':scope > .vcp-harness-row-copy')) return;
    const children = [...row.children];
    const controls = children.filter(node => node.matches('input, select, textarea, button, .switch, .model-input-container, .vcp-harness-select, .vcp-uiux-input-wrap'));
    const titles = children.filter(node => node.matches('label, span, strong, h4, h5'));
    const helpers = children.filter(node => node.matches('small, p'));
    if (!controls.length || !titles.length) return;
    const copy = document.createElement('div');
    copy.className = 'vcp-harness-row-copy';
    copy.dataset.settingPrimitive = 'row-copy';
    [...titles, ...helpers].forEach(node => copy.append(node));
    const remaining = children.filter(node => !copy.contains(node) && !controls.includes(node));
    row.replaceChildren(copy, ...remaining, ...controls);
}

export { mountCanonicalSettingsRows, removeLegacySubsectionHeadings };
