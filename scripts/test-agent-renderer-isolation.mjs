import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="main"><img src="https://example.com/main.png"></div><div id="agent"></div></body>', {
    url: 'https://vchat.local/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;

const observerInstances = [];
class FakeIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        observerInstances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true; }
}
dom.window.IntersectionObserver = FakeIntersectionObserver;
globalThis.IntersectionObserver = FakeIntersectionObserver;

const mainCalls = [];
const agentCalls = [];
const sharedImages = await import('../modules/renderer/imageHandler.js');
const sharedVisibility = await import('../modules/renderer/visibilityOptimizer.js');
const { createAgentImageController } = await import('../modules/ui-system/agent-presentation/fork/agentImageController.js');
const { createAgentVisibilityController } = await import('../modules/ui-system/agent-presentation/fork/agentVisibilityController.js');
const { getDominantAvatarColor } = await import('../modules/ui-system/agent-presentation/fork/agent-renderer-color.js');
const { processRenderedContent } = await import('../modules/ui-system/agent-presentation/fork/agent-renderer-content-utils.js');
const { processAnimationsInContent } = await import('../modules/ui-system/agent-presentation/fork/agent-renderer-animation-safety.js');

sharedImages.initializeImageHandler({
    electronAPI: {
        openImageViewer: (payload) => mainCalls.push(['open', payload.src]),
        showImageContextMenu: (source) => mainCalls.push(['menu', source]),
    },
});
sharedImages.setContentAndProcessImages(document.querySelector('#main'), '<img src="https://example.com/main.png">', 'main');

const mainScroller = document.querySelector('#main');
sharedVisibility.initializeVisibilityOptimizer(mainScroller);
const mainObserver = observerInstances.at(-1);

const agentRoot = document.querySelector('#agent');
const imageController = createAgentImageController({
    document,
    electronAPI: {
        openImageViewer: (payload) => agentCalls.push(['open', payload.src]),
        showImageContextMenu: (source) => agentCalls.push(['menu', source]),
    },
});
imageController.setContent(agentRoot, '<img src="https://example.com/agent.png">');
const visibilityController = createAgentVisibilityController({ container: agentRoot, window: dom.window });
visibilityController.observeMessage(agentRoot);

document.querySelector('#main img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
document.querySelector('#agent img').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(mainCalls.length, 1, 'Agent image initialization must not overwrite main-chat image actions');
assert.equal(agentCalls.length, 1, 'Agent image actions must remain scoped to the Agent controller');

assert.equal(await getDominantAvatarColor('https://example.com/avatar.png', {}), null,
    'Agent avatar color extraction must degrade without browser image APIs');
let mainChatButtonSends = 0;
dom.window.chatManager = { handleSendMessage: () => { mainChatButtonSends += 1; } };
const generatedButton = document.createElement('button');
generatedButton.textContent = 'send elsewhere';
agentRoot.append(generatedButton);
processRenderedContent(agentRoot);
generatedButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
assert.equal(mainChatButtonSends, 0,
    'Agent-rendered buttons must never route through the main-chat manager');
const script = document.createElement('script');
script.textContent = 'window.__agentScriptExecuted = true';
agentRoot.append(script);
processAnimationsInContent(agentRoot);
assert.equal(agentRoot.querySelector('script'), null,
    'Agent presentation must remove model-provided scripts instead of executing them');

visibilityController.dispose();
imageController.dispose();
assert.equal(mainObserver.disconnected, false, 'disposing Agent visibility must not disconnect main-chat visibility');
sharedVisibility.destroyVisibilityOptimizer();

console.log('Agent renderer isolation tests passed.');
