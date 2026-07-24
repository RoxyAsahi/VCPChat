(() => {
    const aliases = Object.freeze({
        add: 'plus', add_comment: 'message-square-plus', ads_click: 'mouse-pointer-click',
        apps: 'layout-grid', attach_file: 'paperclip', chat_bubble: 'message-circle',
        check_box_outline_blank: 'square', check_circle: 'circle-check', content_copy: 'copy',
        crop_square: 'square', dark_mode: 'moon', delete: 'trash-2', edit: 'pencil',
        edit_note: 'notebook-pen', error: 'circle-alert', expand_less: 'chevron-up',
        extension: 'puzzle', favorite: 'heart', format_bold: 'bold', foundation: 'layers-3',
        fullscreen: 'maximize', grid_view: 'grid-3x3', group: 'users', hourglass_top: 'hourglass',
        inventory_2: 'archive', light_mode: 'sun', more_horiz: 'ellipsis', notifications: 'bell',
        person: 'user', progress_activity: 'loader-circle', redo: 'redo-2',
        sentiment_satisfied: 'smile', table_rows: 'rows-3', view_agenda: 'panels-top-left',
        view_day: 'panel-top', view_list: 'list', warning: 'triangle-alert', widgets: 'blocks'
    });

    function toPascalCase(name) {
        return name.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('');
    }

    function resolveIcon(name) {
        const lucideName = aliases[name] || name.replaceAll('_', '-');
        const iconNode = window.lucide?.icons?.[toPascalCase(lucideName)];
        return iconNode ? { lucideName, iconNode } : null;
    }

    function isNextUiIcon(element) {
        return document.documentElement.dataset.uiMode === 'next'
            && element instanceof Element
            && element.classList.contains('vcp-ui-icon')
            && element.closest('.vcp-ui-scope');
    }

    function render(element, requestedName) {
        if (!isNextUiIcon(element) || !requestedName || !window.lucide?.createElement) return element;
        const resolved = resolveIcon(requestedName);
        if (!resolved) return element;
        const { lucideName, iconNode } = resolved;
        const svg = window.lucide.createElement(iconNode, {
            'aria-hidden': element.getAttribute('aria-hidden') || 'true',
            'data-lucide': lucideName,
            'data-vcp-icon': requestedName,
            focusable: 'false'
        });

        if (element instanceof SVGElement) {
            element.replaceChildren(...Array.from(svg.childNodes));
            element.setAttribute('data-lucide', lucideName);
            element.setAttribute('data-vcp-icon', requestedName);
            Array.from(element.classList)
                .filter(className => className.startsWith('lucide-'))
                .forEach(className => element.classList.remove(className));
            element.classList.add('lucide', `lucide-${lucideName}`);
            return element;
        }

        Array.from(element.attributes).forEach(attribute => {
            if (!['class', 'data-lucide', 'data-vcp-icon'].includes(attribute.name)) {
                svg.setAttribute(attribute.name, attribute.value);
            }
        });
        svg.setAttribute('class', `${element.className} lucide lucide-${lucideName}`.trim());
        element.replaceWith(svg);
        return svg;
    }

    function refresh(root = document) {
        const candidates = [];
        if (root instanceof Element && root.matches('.vcp-ui-icon')) candidates.push(root);
        root.querySelectorAll?.('.vcp-ui-icon').forEach(element => candidates.push(element));
        candidates.forEach(element => {
            if (!isNextUiIcon(element)) return;
            const inlineName = element.textContent?.trim();
            if (element instanceof SVGElement && !inlineName) return;
            render(element, inlineName || element.dataset.vcpIcon);
        });
    }

    function set(element, name) {
        return element ? render(element, name) : null;
    }

    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            if (mutation.target instanceof Element && mutation.target.matches('.vcp-ui-icon')) {
                refresh(mutation.target);
            }
            mutation.addedNodes.forEach(node => {
                if (node instanceof Element) refresh(node);
            });
        });
    });

    window.VCPIcons = Object.freeze({ refresh, set });
    document.addEventListener('DOMContentLoaded', () => {
        refresh(document);
        observer.observe(document.body, { childList: true, subtree: true });
    });
    window.addEventListener('ui-mode-changed', event => {
        if (event.detail?.mode === 'next') requestAnimationFrame(() => refresh(document));
    });
})();
