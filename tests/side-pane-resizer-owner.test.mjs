import test from 'node:test';
import assert from 'node:assert/strict';
import { createSidePaneResizerOwner } from '../modules/ui-system/side-pane/side-pane-resizer-owner.js';

test('createSidePaneResizerOwner initializes VCPSidebarResizer with direction -1 and pointer events', () => {
    let capturedOptions = null;
    const fakeHandle = {
        ownerDocument: {
            body: { style: {}, classList: { toggle() {} } },
        },
    };
    const fakePane = {
        style: { width: '360px' },
        getBoundingClientRect: () => ({ width: 360 }),
    };

    const mockFactory = (options) => {
        capturedOptions = options;
        return {
            refresh() {},
            dispose() { capturedOptions = null; },
        };
    };

    const owner = createSidePaneResizerOwner({
        handle: fakeHandle,
        paneElement: fakePane,
        resizerFactory: mockFactory,
        windowRef: { innerWidth: 1200, PointerEvent: function PointerEvent() {} },
    });

    assert.ok(capturedOptions);
    assert.equal(capturedOptions.direction, -1);
    assert.equal(capturedOptions.eventNames.down, 'pointerdown');

    // Check bounds calculation: total 1200, maxRatio 0.65 -> 780, minRemainder 1200 - 420 -> 780
    const bounds = capturedOptions.getBounds();
    assert.equal(bounds.min, 240);
    assert.equal(bounds.max, 780);

    owner.dispose();
    assert.equal(capturedOptions, null);
});

test('createSidePaneResizerOwner notifies width commit and binds lifecycle scope', () => {
    let appliedWidth = 0;
    let committedWidth = 0;
    let ownedDisposer = null;

    const fakeHandle = {
        classList: { toggle() {} },
        ownerDocument: {
            body: { style: {}, classList: { toggle() {} } },
        },
    };
    const fakePane = {
        style: { width: '360px' },
        getBoundingClientRect: () => ({ width: 360 }),
    };

    let factoryOptions = null;
    const mockFactory = (options) => {
        factoryOptions = options;
        return {
            refresh() {},
            dispose() {},
        };
    };

    const mockScope = {
        own(resource) {
            ownedDisposer = resource;
            return resource;
        },
    };

    createSidePaneResizerOwner({
        handle: fakeHandle,
        paneElement: fakePane,
        resizerFactory: mockFactory,
        scope: mockScope,
        onWidthChange: (w) => { appliedWidth = w; },
        onWidthCommit: (w) => { committedWidth = w; },
    });

    assert.ok(ownedDisposer);
    factoryOptions.applyValue(400);
    assert.equal(appliedWidth, 400);
    assert.equal(fakePane.style.width, '400px');

    factoryOptions.onCommit(400);
    assert.equal(committedWidth, 400);
});
