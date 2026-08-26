/** Minimal Light-DOM kernel: owned insertion, text updates and keyed reconciliation. */
export function createDomRenderer(scope) {
    if (!scope)
        throw new TypeError('DomRenderer requires a scope.');
    const mount = (parent, node, before = null) => {
        parent.insertBefore(node, before);
        return scope.own(() => { node.parentNode?.removeChild(node); }, 'dom-renderer-node', 'ui-renderer');
    };
    const updateText = (node, value) => { node.data = String(value ?? ''); };
    const keyed = (parent, items, key, render) => {
        const nodes = new Map();
        items.forEach((item, index) => { const node = render(item); nodes.set(key(item), node); parent.insertBefore(node, parent.children[index] || null); });
        return scope.own(() => { nodes.forEach(node => node.remove()); nodes.clear(); }, 'dom-renderer-keyed', 'ui-renderer');
    };
    return Object.freeze({ mount, updateText, keyed });
}
