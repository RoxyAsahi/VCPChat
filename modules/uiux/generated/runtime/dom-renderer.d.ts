import type { UiDisposer, UiScope } from '../contracts.js';
export interface DomRenderer {
    mount(parent: Node, node: Node, before?: Node | null): UiDisposer;
    updateText(node: Text, value: unknown): void;
    keyed<T>(parent: Element, items: readonly T[], key: (item: T) => string, render: (item: T) => Element): UiDisposer & {
        update(items: readonly T[]): void;
    };
}
/** Minimal Light-DOM kernel: owned insertion, text updates and keyed reconciliation. */
export declare function createDomRenderer(scope: UiScope): DomRenderer;
