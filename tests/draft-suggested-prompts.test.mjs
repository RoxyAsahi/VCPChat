import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    DEFAULT_SUGGESTED_PROMPTS,
    applyPromptToDraft,
    createDraftSuggestedPrompts,
    loadPromptPool,
    pickSuggestions
} from '../modules/ui-system/draft-suggested-prompts.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const storageWith = value => ({ getItem: () => value });

test('loadPromptPool validates custom prompts and falls back to the defaults', () => {
    assert.equal(loadPromptPool(storageWith(null)).length, DEFAULT_SUGGESTED_PROMPTS.length);
    assert.equal(loadPromptPool(storageWith('{bad')).length, DEFAULT_SUGGESTED_PROMPTS.length);
    assert.equal(loadPromptPool(storageWith('[]')).length, DEFAULT_SUGGESTED_PROMPTS.length);
    assert.deepEqual(
        loadPromptPool(storageWith(JSON.stringify([{ title: ' 自定义 ', prompt: '内容' }, { title: '', prompt: 'x' }, { title: 'y', prompt: '  ' }, 3]))),
        [{ title: '自定义', prompt: '内容' }]
    );
});

test('pickSuggestions wraps around the pool and applyPromptToDraft never overwrites typed text', () => {
    const pool = ['a', 'b', 'c', 'd', 'e', 'f'];
    assert.deepEqual(pickSuggestions(pool, 4, 0), ['a', 'b', 'c', 'd']);
    assert.deepEqual(pickSuggestions(pool, 4, 4), ['e', 'f', 'a', 'b']);
    assert.deepEqual(pickSuggestions(['a', 'b'], 4, 7), ['a', 'b']);
    assert.equal(applyPromptToDraft('', 'P'), 'P');
    assert.equal(applyPromptToDraft('  \n', 'P'), 'P');
    assert.equal(applyPromptToDraft('已有', 'P'), '已有\nP');
    assert.equal(applyPromptToDraft('已有\n', 'P'), '已有\nP');
});

function makeApp() {
    const dom = new JSDOM(`<div class="main-content" data-chat-empty="false">
        <section id="nextUiEmptyState"><div class="next-ui-empty-state-content"><p>tagline</p></div></section>
    </div><textarea id="messageInput"></textarea>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    return { dom, doc, main: doc.querySelector('.main-content'), input: doc.getElementById('messageInput') };
}

test('appears only for an empty topic, refills the draft on click and rotates with the refresh button', async () => {
    const { dom, doc, main, input } = makeApp();
    const suggestions = createDraftSuggestedPrompts({ document: doc, storage: storageWith(null), now: () => 0 });
    const list = suggestions.mount();
    assert.equal(list.hidden, true);

    main.dataset.chatEmpty = 'true';
    main.dataset.chatEmptyReason = 'no-selection';
    await wait();
    assert.equal(list.hidden, true, 'no agent selected: stay quiet');

    main.dataset.chatEmptyReason = 'empty-topic';
    await wait();
    assert.equal(list.hidden, false);
    const chips = [...list.querySelectorAll('.vcp-draft-suggestion:not(.vcp-draft-suggestion-refresh)')];
    assert.deepEqual(chips.map(chip => chip.textContent), DEFAULT_SUGGESTED_PROMPTS.slice(0, 4).map(item => item.title));

    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    chips[0].click();
    assert.equal(input.value, DEFAULT_SUGGESTED_PROMPTS[0].prompt);
    assert.equal(inputEvents, 1);
    assert.equal(doc.activeElement, input);
    assert.equal(input.selectionStart, input.value.length);

    list.querySelector('.vcp-draft-suggestion-refresh').click();
    const rotated = [...list.querySelectorAll('.vcp-draft-suggestion:not(.vcp-draft-suggestion-refresh)')].map(chip => chip.textContent);
    assert.deepEqual(rotated, DEFAULT_SUGGESTED_PROMPTS.slice(4, 8).map(item => item.title));

    main.dataset.chatEmpty = 'false';
    await wait();
    assert.equal(list.hidden, true);

    input.disabled = true;
    assert.equal(suggestions.fillDraft('x'), false);
    suggestions.dispose();
    assert.equal(doc.querySelector('.vcp-draft-suggestions'), null);
    assert.equal(dom.window.document.querySelectorAll('.vcp-draft-suggestion').length, 0);
});

test('mount is a no-op without the empty-state host', () => {
    const dom = new JSDOM('<div></div>');
    const suggestions = createDraftSuggestedPrompts({ document: dom.window.document });
    assert.equal(suggestions.mount(), null);
    suggestions.dispose();
});
