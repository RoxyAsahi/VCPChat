import { processAnimationsInContent, cleanupAnimationsInContent } from './agent-renderer-animation-safety.js';

function createAgentAnimationLifecycle({ root }) {
    const contents = new Set();
    let disposed = false;

    function process(content) {
        if (disposed || !content || !root?.contains(content)) return;
        contents.add(content);
        processAnimationsInContent(content);
    }

    function cleanup(content) {
        if (!content) return;
        contents.delete(content);
        cleanupAnimationsInContent(content);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const content of contents) cleanupAnimationsInContent(content);
        contents.clear();
    }

    return { process, cleanup, dispose };
}

export { createAgentAnimationLifecycle };
