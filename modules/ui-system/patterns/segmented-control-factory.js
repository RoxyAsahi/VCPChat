// VCP-owned mutually-exclusive choice pattern. Shared controller/state
// primitives are injected by the facade; the pattern owns only DOM semantics
// and keyboard behavior.
export function createSegmentedControlFactory({ makeController, normalize, normalizeSelectableValue, icon, emit }) {
    return function segmentedControlFactory(options = {}) {
        const element = document.createElement('div');
        element.className = 'vcp-ui-segmented';
        element.setAttribute('role', 'radiogroup');
        const state = { items: [], value: '', size: 'md', label: '选项', ...options };
        let controller;
        controller = makeController(element, state, current => {
            element.dataset.size = normalize(current.size, ['sm', 'md'], 'md', 'size');
            element.setAttribute('aria-label', current.label);
            current.value = normalizeSelectableValue(current.items, current.value);
            element.replaceChildren();
            current.items.forEach((item, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('role', 'radio');
                button.dataset.value = item.value;
                button.dataset.index = String(index);
                button.disabled = Boolean(item.disabled);
                button.setAttribute('aria-checked', String(item.value === current.value));
                button.tabIndex = item.value === current.value ? 0 : -1;
                if (item.icon) button.append(icon(item.icon));
                const label = document.createElement('span');
                label.textContent = item.label;
                button.append(label);
                element.append(button);
            });
        });
        controller._listen(element, 'click', event => {
            const button = event.target?.closest?.('[role="radio"]');
            if (!button || button.disabled || !element.contains(button)) return;
            state.value = button.dataset.value || '';
            controller.update();
            emit(element, 'change');
        });
        controller._listen(element, 'keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            const items = [...element.querySelectorAll('[role="radio"]:not(:disabled)')];
            const current = items.indexOf(document.activeElement);
            if (current < 0 || !items.length) return;
            event.preventDefault();
            const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
            items[next].click();
            items[next].focus();
        });
        return controller;
    };
}
