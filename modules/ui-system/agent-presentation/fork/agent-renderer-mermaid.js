function createAgentRendererMermaid({ documentRef, getMermaid, escapeHtml, requestFrame }) {
    function enhance(element) {
        if (!element || element.dataset.vcpMermaidEnhanced === 'true') return;
        const svg = element.querySelector('svg');
        if (!svg) return;
        element.dataset.vcpMermaidEnhanced = 'true';

        const wrapper = documentRef.createElement('div');
        wrapper.className = 'mermaid-viewer';
        wrapper.dataset.scale = '1';
        wrapper.dataset.translateX = '0';
        wrapper.dataset.translateY = '0';
        const toolbar = documentRef.createElement('div');
        toolbar.className = 'mermaid-viewer-toolbar';
        toolbar.innerHTML = `
            <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-out" title="缩小">−</button>
            <button type="button" class="mermaid-viewer-btn" data-mermaid-action="reset" title="重置视图">100%</button>
            <button type="button" class="mermaid-viewer-btn" data-mermaid-action="zoom-in" title="放大">＋</button>
            <button type="button" class="mermaid-viewer-btn" data-mermaid-action="fit" title="适应宽度">适应</button>`;
        const viewport = documentRef.createElement('div');
        viewport.className = 'mermaid-viewer-viewport';
        viewport.title = '滚轮缩放，按住鼠标左键拖拽平移，双击重置';
        const canvas = documentRef.createElement('div');
        canvas.className = 'mermaid-viewer-canvas';
        svg.removeAttribute('style');
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        canvas.appendChild(svg);
        viewport.appendChild(canvas);
        element.textContent = '';
        wrapper.append(toolbar, viewport);
        element.appendChild(wrapper);

        const clamp = (scale) => Math.min(5, Math.max(0.2, scale));
        const getState = () => ({
            scale: parseFloat(wrapper.dataset.scale) || 1,
            x: parseFloat(wrapper.dataset.translateX) || 0,
            y: parseFloat(wrapper.dataset.translateY) || 0,
        });
        const setState = ({ scale, x = 0, y = 0 }) => {
            const nextScale = clamp(scale);
            wrapper.dataset.scale = String(nextScale);
            wrapper.dataset.translateX = String(x);
            wrapper.dataset.translateY = String(y);
            canvas.style.transform = `translate(${x}px, ${y}px) scale(${nextScale})`;
            const reset = toolbar.querySelector('[data-mermaid-action="reset"]');
            if (reset) reset.textContent = `${Math.round(nextScale * 100)}%`;
        };
        const zoomAt = (target, originX = viewport.clientWidth / 2, originY = viewport.clientHeight / 2) => {
            const current = getState();
            const scale = clamp(target);
            const ratio = scale / current.scale;
            setState({ scale, x: originX - (originX - current.x) * ratio, y: originY - (originY - current.y) * ratio });
        };
        const reset = () => setState({ scale: 1 });
        const fit = () => {
            const width = svg.getBBox?.().width || svg.viewBox?.baseVal?.width || svg.getBoundingClientRect().width;
            if (!width) return reset();
            setState({ scale: clamp(Math.min(1.8, Math.max(1, viewport.clientWidth - 32) / width)) });
        };
        toolbar.addEventListener('click', (event) => {
            const button = event.target.closest('[data-mermaid-action]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const action = button.dataset.mermaidAction;
            const { scale } = getState();
            if (action === 'zoom-in') zoomAt(scale * 1.2);
            else if (action === 'zoom-out') zoomAt(scale / 1.2);
            else if (action === 'reset') reset();
            else if (action === 'fit') fit();
        });
        viewport.addEventListener('wheel', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = viewport.getBoundingClientRect();
            zoomAt(getState().scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX - rect.left, event.clientY - rect.top);
        }, { passive: false });
        let drag = null;
        viewport.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const state = getState();
            drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y };
            viewport.classList.add('dragging');
            viewport.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        viewport.addEventListener('pointermove', (event) => {
            if (!drag || drag.id !== event.pointerId) return;
            setState({ scale: getState().scale, x: drag.x + event.clientX - drag.startX, y: drag.y + event.clientY - drag.startY });
        });
        const endDrag = (event) => {
            if (!drag || drag.id !== event.pointerId) return;
            drag = null;
            viewport.classList.remove('dragging');
            viewport.releasePointerCapture?.(event.pointerId);
        };
        viewport.addEventListener('pointerup', endDrag);
        viewport.addEventListener('pointercancel', endDrag);
        viewport.addEventListener('dblclick', (event) => { event.preventDefault(); reset(); });
        requestFrame(fit);
    }

    async function render(container) {
        const placeholders = Array.from(container.querySelectorAll('.mermaid-placeholder'));
        if (!placeholders.length) return;
        for (const placeholder of placeholders) {
            const code = placeholder.dataset.mermaidCode;
            if (!code) continue;
            try {
                const decoded = decodeURIComponent(code).replace(/[—–－]/g, '--');
                placeholder.textContent = decoded;
                placeholder.classList.remove('mermaid-placeholder');
                placeholder.classList.add('mermaid');
                placeholder.dataset.mermaidSource = decoded;
            } catch (error) {
                console.error('Failed to decode mermaid code', error);
                placeholder.textContent = '[Mermaid code decoding error]';
            }
        }
        const elements = placeholders.filter((element) => element.classList.contains('mermaid'));
        const mermaidApi = getMermaid();
        if (!elements.length || !mermaidApi) return;
        mermaidApi.initialize({ startOnLoad: false });
        for (const element of elements) {
            try {
                await mermaidApi.run({ nodes: [element] });
                enhance(element);
            } catch (error) {
                console.error('Error rendering Mermaid diagram:', error);
                const source = element.dataset.mermaidSource || element.textContent;
                element.innerHTML = `<div class="mermaid-error">Mermaid 渲染错误: ${escapeHtml(error.message)}</div><pre>${escapeHtml(source)}</pre>`;
            }
        }
    }

    return { render };
}

export { createAgentRendererMermaid };
