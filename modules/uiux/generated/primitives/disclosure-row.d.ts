import type { UiScope } from '../contracts.js';
export interface DisclosureRowProps {
    readonly icon: Node;
    readonly title: string;
    readonly open: boolean;
    readonly expandable: boolean;
    readonly onToggle: () => void;
    readonly expandOnRowClick?: boolean;
    readonly previewChevron?: boolean;
    readonly keepContentWhenOpen?: boolean;
    readonly collapsedContent?: Node | readonly Node[];
    readonly children?: Node | readonly Node[];
    readonly className?: string;
    readonly rowClassName?: string;
    readonly leadingClassName?: string;
    readonly chevronClassName?: string;
    readonly titleClassName?: string;
}
export interface DisclosureRowController {
    readonly root: HTMLDivElement;
    readonly row: HTMLDivElement;
    readonly leading: HTMLElement;
    readonly open: boolean;
    readonly expandable: boolean;
    setOpen(open: boolean): void;
    setExpandable(expandable: boolean): void;
    setTitle(title: string): void;
    dispose(): void | Promise<void>;
}
/** Controlled Harness DisclosureRow with reversible Light-DOM ownership. */
export declare function mountDisclosureRow(host: HTMLElement, props: DisclosureRowProps, scope: UiScope): DisclosureRowController;
