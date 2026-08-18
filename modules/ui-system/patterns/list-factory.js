// VCP-owned List pattern. The facade injects its shared controller and icon
// primitives so this module owns only list presentation/interaction, not a
// second state or lifecycle system.
export function createListFactory({ makeController, icon }) {
    return function listFactory(options = {}) {
        const element = document.createElement('div');
        element.className = 'vcp-ui-list';
        const state = {
            items: [],
            role: 'list',
            ariaLabel: '',
            keyboardNavigation: false,
            ...options,
        };
        element.setAttribute('role', state.role);
        if (state.ariaLabel) element.setAttribute('aria-label', state.ariaLabel);
        let controller;
        controller = makeController(element, state, current => {
            element.setAttribute('role', current.role || 'list');
            if (current.ariaLabel) element.setAttribute('aria-label', current.ariaLabel);
            else element.removeAttribute('aria-label');
            element.replaceChildren();
            current.items.forEach((item, index) => {
                const row = document.createElement(item.interactive === false ? 'div' : 'button');
                if (row instanceof HTMLButtonElement) row.type = 'button';
                row.className = 'vcp-ui-list-item';
                // A button cannot also have role=listitem. Keep static rows as
                // listitems, while navigation lists use native button semantics.
                if (row.tagName === 'DIV') row.setAttribute('role', 'listitem');
                row.dataset.index = String(index);
                const identity = item.id ?? item.value;
                if (identity !== undefined && identity !== null) row.dataset.itemKey = String(identity);
                row.disabled = Boolean(item.disabled);
                row.dataset.state = item.selected ? 'selected' : 'default';
                if (item.current) row.setAttribute('aria-current', item.current === true ? 'page' : String(item.current));
                else row.removeAttribute('aria-current');
                if (item.icon) row.append(icon(item.icon));
                const copy = document.createElement('span');
                copy.className = 'vcp-ui-list-copy';
                const primary = document.createElement('strong');
                primary.textContent = item.label;
                copy.append(primary);
                if (item.description) {
                    const secondary = document.createElement('span');
                    secondary.textContent = item.description;
                    copy.append(secondary);
                }
                row.append(copy);
                if (item.trailing) {
                    const trailing = document.createElement('span');
                    trailing.className = 'vcp-ui-list-trailing';
                    trailing.textContent = item.trailing;
                    row.append(trailing);
                }
                element.append(row);
            });
        });
        // One owner-managed delegated listener replaces one listener per row.
        // Re-rendering items therefore cannot retain closures for old rows.
        controller._listen(element, 'click', event => {
            const row = event.target?.closest?.('.vcp-ui-list-item');
            if (!row || !element.contains(row)) return;
            const item = row.dataset.itemKey !== undefined
                ? state.items.find(candidate => String(candidate.id ?? candidate.value) === row.dataset.itemKey)
                : state.items[Number(row.dataset.index)];
            if (typeof item?.onClick === 'function') item.onClick.call(row, event);
        });
        controller._listen(element, 'keydown', event => {
            if (!state.keyboardNavigation || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            const rows = [...element.querySelectorAll('button.vcp-ui-list-item:not(:disabled)')];
            const current = rows.indexOf(document.activeElement);
            if (current < 0 || rows.length === 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[next].focus();
        });
        return controller;
    };
}
