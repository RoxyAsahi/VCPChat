// Pure VCP-owned presentation factories. They receive the shared controller
// primitives from vcp-ui.js and intentionally have no provider, async, or
// business-DOM dependencies.
export function createDividerFactory({ makeController, normalize }) {
    return function dividerFactory(options = {}) {
        const element = document.createElement('div');
        element.className = 'vcp-ui-divider';
        element.setAttribute('role', 'separator');
        const state = { label: '', orientation: 'horizontal', ...options };
        return makeController(element, state, current => {
            element.dataset.orientation = normalize(current.orientation, ['horizontal', 'vertical'], 'horizontal', 'orientation');
            element.setAttribute('aria-orientation', element.dataset.orientation);
            element.replaceChildren();
            if (current.label) {
                const label = document.createElement('span');
                label.textContent = current.label;
                element.append(label);
            }
        });
    };
}

export function createSkeletonFactory({ makeController, normalize }) {
    return function skeletonFactory(options = {}) {
        const element = document.createElement('div');
        element.className = 'vcp-ui-skeleton';
        element.setAttribute('aria-hidden', 'true');
        const state = { variant: 'text', lines: 1, size: 'md', ...options };
        return makeController(element, state, current => {
            element.dataset.variant = normalize(current.variant, ['text', 'rect', 'circle'], 'text', 'variant');
            element.dataset.size = normalize(current.size, ['sm', 'md', 'lg'], 'md', 'size');
            element.replaceChildren();
            const count = element.dataset.variant === 'text'
                ? Math.max(1, Math.min(6, Number(current.lines) || 1))
                : 1;
            for (let index = 0; index < count; index += 1) {
                element.append(document.createElement('span'));
                element.lastChild.className = 'vcp-ui-skeleton-line';
            }
        });
    };
}

export function createCardFactory({ makeController, normalize, appendContent, waControl }) {
    return function cardFactory(options = {}) {
        const wa = waControl?.('card', {});
        if (wa) {
            wa.className = 'vcp-ui-card vcp-ui-wa-card';
            if (options.interactive) {
                wa.setAttribute('role', 'button');
                wa.tabIndex = 0;
            }
            const state = { title: '', description: '', variant: options.interactive ? 'interactive' : 'default', ...options };
            return makeController(wa, state, current => {
                wa.dataset.variant = normalize(current.variant, ['default', 'outlined', 'interactive', 'selected'], 'default', 'variant');
                wa.appearance = wa.dataset.variant === 'outlined' ? 'outlined' : 'filled';
                if (current.interactive || options.interactive) wa.setAttribute('aria-pressed', String(wa.dataset.variant === 'selected'));
                wa.replaceChildren();
                const body = document.createElement('div');
                body.className = 'vcp-ui-card-body';
                if (current.title) {
                    const title = document.createElement('strong');
                    title.className = 'vcp-ui-card-title';
                    title.textContent = current.title;
                    body.append(title);
                }
                if (current.description) {
                    const description = document.createElement('span');
                    description.className = 'vcp-ui-card-description';
                    description.textContent = current.description;
                    body.append(description);
                }
                if (current.content) appendContent(body, current.content);
                wa.append(body);
            });
        }
        const element = document.createElement(options.interactive ? 'button' : 'section');
        if (element instanceof HTMLButtonElement) element.type = 'button';
        element.className = 'vcp-ui-card';
        const state = { title: '', description: '', variant: options.interactive ? 'interactive' : 'default', ...options };
        return makeController(element, state, current => {
            element.dataset.variant = normalize(current.variant, ['default', 'outlined', 'interactive', 'selected'], 'default', 'variant');
            element.setAttribute('aria-pressed', String(element.dataset.variant === 'selected'));
            element.replaceChildren();
            const title = document.createElement('strong');
            title.textContent = current.title;
            const description = document.createElement('span');
            description.textContent = current.description;
            element.append(title, description);
            if (current.content) appendContent(element, current.content);
        });
    };
}

export function createToolbarFactory({ makeController }) {
    return function toolbarFactory(options = {}) {
        const element = document.createElement('div');
        element.className = 'vcp-ui-toolbar';
        element.setAttribute('role', 'toolbar');
        const state = { start: [], end: [], label: '工具栏', ...options };
        return makeController(element, state, current => {
            element.setAttribute('aria-label', current.label);
            const start = document.createElement('div');
            const end = document.createElement('div');
            start.className = 'vcp-ui-toolbar-group';
            end.className = 'vcp-ui-toolbar-group is-end';
            const add = (host, item) => {
                if (item === 'separator') {
                    const separator = document.createElement('span');
                    separator.className = 'vcp-ui-toolbar-separator';
                    separator.setAttribute('role', 'separator');
                    host.append(separator);
                } else host.append(item.element || item);
            };
            current.start.forEach(item => add(start, item));
            current.end.forEach(item => add(end, item));
            element.replaceChildren(start, end);
        });
    };
}
