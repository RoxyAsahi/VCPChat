import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildTerminalTheme, DARK_PALETTE, LIGHT_PALETTE, isLightTheme, normalizeCssColor } from '../modules/ui-system/side-pane/terminalTheme.js';

function makeDoc(bodyAttrs = '') {
    const dom = new JSDOM(`<body ${bodyAttrs}><div id="screen"></div></body>`, { pretendToBeVisual: true });
    return dom.window.document;
}

test('dark theme gets the dark ANSI palette and keeps token background / foreground', () => {
    const doc = makeDoc();
    const screen = doc.getElementById('screen');
    screen.style.setProperty('--color-surface', '#101010');
    screen.style.setProperty('--primary-text', '#eeeeee');
    const theme = buildTerminalTheme(doc, screen);
    assert.equal(isLightTheme(doc), false);
    assert.equal(theme.red, DARK_PALETTE.red);
    assert.equal(theme.brightWhite, DARK_PALETTE.brightWhite);
    assert.equal(theme.background, '#101010');
    assert.equal(theme.foreground, '#eeeeee');
    assert.equal(theme.cursorAccent, theme.background);
});

test('light theme (data attribute or class) gets the light palette', () => {
    for (const attrs of ['data-vcp-theme="light"', 'class="light-theme"']) {
        const doc = makeDoc(attrs);
        const theme = buildTerminalTheme(doc, doc.getElementById('screen'));
        assert.equal(isLightTheme(doc), true, attrs);
        assert.equal(theme.yellow, LIGHT_PALETTE.yellow);
        assert.equal(theme.background, '#fafafa', 'falls back when the token is missing');
    }
});

test('normalizeCssColor falls back / passes through without a canvas', () => {
    const doc = makeDoc();
    assert.equal(normalizeCssColor(doc, '', '#123456'), '#123456');
    assert.equal(normalizeCssColor(doc, 'var(--x)', '#123456'), 'var(--x)');
});

test('mounted terminal: frame background follows the xterm theme and switches with the light/dark theme', async () => {
    const { createTerminalSideProvider } = await import('../modules/ui-system/side-pane/terminalSideProvider.js');
    const dom = new JSDOM('<body><div id="view"></div></body>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const terminals = [];
    class FakeTerminal {
        constructor(options) { this.options = options; this.cols = 80; this.buffer = { active: {} }; terminals.push(this); }
        loadAddon() {} open() {} onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; }
        focus() {} write() {} dispose() {} reset() {} clear() {} registerLinkProvider() {}
        onTitleChange() { return { dispose() {} }; } onBell() { return { dispose() {} }; }
    }
    const api = { gitListWorkspaces: async () => ({ success: true, data: { workspaces: [] } }), terminalCreate: async () => ({ success: true, data: { id: "s1", replay: "" } }), terminalKill() {} };
    const provider = createTerminalSideProvider({
        document: doc, api, sidePaneController: null,
        xtermLoader: async () => ({ Terminal: FakeTerminal, FitAddon: null })
    });
    const view = doc.getElementById('view');
    let handle;
    try { handle = await provider.mountTab({ id: 'terminal:main' }, view); } catch (_e) { /* the fake api is minimal */ }
    const screen = view.querySelector('.side-terminal-screen');
    assert.ok(screen && terminals[0], "terminal mounted");
    assert.equal(screen.style.background, 'rgb(20, 22, 26)');
    doc.body.setAttribute('data-vcp-theme', 'light');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(terminals[0].options.theme.red, LIGHT_PALETTE.red);
    assert.equal(screen.style.background, 'rgb(250, 250, 250)');
    await handle?.dispose?.();
});
