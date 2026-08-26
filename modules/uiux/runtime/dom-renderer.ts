import type { UiDisposer, UiScope } from '../contracts.js';

export interface DomRenderer {
    mount(parent: Node, node: Node, before?: Node | null): UiDisposer;
    updateText(node: Text, value: unknown): void;
    keyed<T>(parent: Element, items: readonly T[], key: (item: T) => string, render: (item: T) => Element): UiDisposer;
}

/** Minimal Light-DOM kernel: owned insertion, text updates and keyed reconciliation. */
export function createDomRenderer(scope: UiScope): DomRenderer {
    if (!scope) throw new TypeError('DomRenderer requires a scope.');
    const mount = (parent: Node, node: Node, before: Node | null = null) => {
        parent.insertBefore(node, before);
        return scope.own(() => { node.parentNode?.removeChild(node); }, 'dom-renderer-node', 'ui-renderer');
    };
    const updateText = (node: Text, value: unknown) => { node.data = String(value ?? ''); };
    const keyed = <T>(parent: Element, items: readonly T[], key: (item: T) => string, render: (item: T) => Element) => {
        const nodes = new Map<string, Element>();
        items.forEach((item, index) => { const node = render(item); nodes.set(key(item), node); parent.insertBefore(node, parent.children[index] || null); });
        return scope.own(() => { nodes.forEach(node => node.remove()); nodes.clear(); }, 'dom-renderer-keyed', 'ui-renderer');
    };
    return Object.freeze({ mount, updateText, keyed });
}
