import { fixEmoticonUrl } from '../../../renderer/emoticonUrlFixer.js';

function createAgentImageController({ document, electronAPI }) {
    let disposed = false;

    function setContent(content, html) {
        if (disposed || !content) return;
        content.innerHTML = html;
        for (const image of content.querySelectorAll('img')) {
            let source = image.src;
            if (source.includes('表情包')) {
                const fixed = fixEmoticonUrl(source);
                if (fixed !== source) {
                    image.src = fixed;
                    source = fixed;
                }
            }
            image.style.cursor = 'pointer';
            image.title = '点击在新窗口预览\n右键可复制图片';
            image.addEventListener('click', (event) => {
                if (disposed) return;
                event.stopPropagation();
                electronAPI?.openImageViewer?.({
                    src: source,
                    title: image.alt || source.split('/').pop() || 'AI 图片',
                    theme: document.body.classList.contains('light-theme') ? 'light' : 'dark',
                });
            });
            image.addEventListener('contextmenu', (event) => {
                if (disposed) return;
                event.preventDefault();
                event.stopPropagation();
                electronAPI?.showImageContextMenu?.(source);
            });
        }
    }

    return {
        setContent,
        dispose() { disposed = true; },
    };
}

export { createAgentImageController };
