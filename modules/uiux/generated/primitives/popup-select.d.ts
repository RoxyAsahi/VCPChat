import type { UiScope } from '../contracts.js';
/** Copy for an option that must be acknowledged before onSelect can run. */
export interface PopupSelectConfirmation {
    readonly title: string;
    readonly description: string;
    readonly acknowledgeLabel: string;
    readonly cancelLabel: string;
    readonly confirmLabel: string;
}
/** One option row of a popupSelect shell. */
export interface PopupSelectOption {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    readonly active?: boolean;
    readonly disabled?: boolean;
    readonly confirmation?: PopupSelectConfirmation;
}
/** Command token segment snapshotted at shell-open time (popup.ts contract). */
export type PopupTokenSegment = {
    readonly via: 'menu';
    readonly span: unknown;
} | {
    readonly via: 'enter';
    readonly token: string;
};
/** Headless shell state; closed renders null (view detaches the card). */
export interface PopupSelectSnapshot {
    readonly open: boolean;
    readonly command: string | null;
    readonly status: 'pending' | 'ready' | 'failed';
    readonly options: readonly PopupSelectOption[];
    readonly search: string;
    readonly active: number;
    readonly submitting: boolean;
    readonly confirming: PopupSelectOption | null;
    readonly acknowledged: boolean;
    readonly error: string | null;
}
export interface PopupSelectSpec {
    /** Load the option rows once per open (retry reuses the same signal). */
    readonly options: (context: unknown, signal: AbortSignal) => Promise<readonly PopupSelectOption[]>;
    /** Settle the picked option against the open-time context. */
    readonly onSelect: (option: PopupSelectOption, context: unknown) => void | Promise<void>;
}
/** Injected session-wiring callbacks (token consumption + composer focus). */
export interface PopupSelectDeps {
    /** Consume the open-time token segment after a successful onSelect; false is benign. */
    readonly consume: (segment: PopupTokenSegment) => boolean;
    /** Return focus to the composer (successful settle and Escape paths). */
    readonly focusComposer: () => void;
}
/**
 * Filter option rows case-insensitively over label and detail (blank search keeps every row).
 * Replicates ui-commands/src/client/popup.ts filterOptions.
 */
export declare function filterOptions(options: readonly PopupSelectOption[], search: string): readonly PopupSelectOption[];
export interface PopupSelectController {
    getSnapshot(): PopupSelectSnapshot;
    subscribe(listener: () => void): () => void;
    open(command: string, context: unknown, segment: PopupTokenSegment): void;
    retry(): void;
    setSearch(search: string): void;
    move(direction: 1 | -1): void;
    highlight(index: number): void;
    select(index: number): Promise<void>;
    acknowledge(acknowledged: boolean): void;
    cancelConfirmation(): void;
    confirm(): Promise<void>;
    dismiss(options?: {
        readonly focusComposer?: boolean;
    }): void;
    dispose(): void;
}
/**
 * Headless popupSelect controller replicating ui-commands PopupSelectController:
 * one options load per open, local filtering, single-flight settlement, risk
 * gate before onSelect, late settlements lose write rights through binding
 * identity (dismiss/dispose/reopen swap the binding and abort the fetch).
 */
export declare function createPopupSelectController(spec: PopupSelectSpec, deps: PopupSelectDeps): PopupSelectController;
export interface PopupSelectViewProps {
    readonly popup: PopupSelectController;
    /** Optional trigger/anchor that is part of the owning surface. */
    readonly anchor?: HTMLElement;
    readonly searchPlaceholder?: string;
    readonly searchAria?: string;
    readonly retryLabel?: string;
    readonly statusLoading?: string;
    readonly statusApplying?: string;
    readonly statusEmpty?: string;
    /** '{command}' substitutes the open command name. */
    readonly overlayAria?: string;
    readonly listboxAria?: string;
    /** Return true when the owner consumed Escape without dismissing. */
    readonly onEscape?: () => boolean;
}
export interface PopupSelectViewController {
    readonly card: HTMLDivElement;
    readonly search: HTMLInputElement;
    sync(): void;
    dispose(): void | Promise<void>;
}
/**
 * Candidate replication of ui-commands PopupSelectView: an absolutely
 * positioned card (the host is the conversation.input.overlay anchor strip),
 * holding focus in its search input while open. Caller owns placement.
 */
export declare function mountPopupSelectView(host: HTMLElement, props: PopupSelectViewProps, scope: UiScope): PopupSelectViewController;
