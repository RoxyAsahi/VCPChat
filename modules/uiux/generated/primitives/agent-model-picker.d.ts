import type { UiDisposer, UiScope } from '../contracts.js';
import { type PopupSelectController } from './popup-select.js';
export interface AgentModelOption {
    readonly id: string;
    readonly label: string;
    readonly provider?: string;
    readonly favorite?: boolean;
    readonly active?: boolean;
    readonly disabled?: boolean;
}
export interface AgentModelEffortOption {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}
export interface AgentModelPickerProps {
    readonly label?: string;
    /** Reuse an existing surface trigger while keeping its identity intact. */
    readonly trigger?: HTMLButtonElement;
    readonly options: (signal: AbortSignal) => Promise<readonly AgentModelOption[]>;
    readonly onSelect: (option: AgentModelOption) => void | Promise<void>;
    readonly efforts?: readonly AgentModelEffortOption[];
    readonly onEffortSelect?: (option: AgentModelEffortOption) => void | Promise<void>;
    readonly selectedEffort?: string;
    readonly selectedId?: string;
    /** Keep the product extension searchable by default; disable for parity fixtures. */
    readonly searchEnabled?: boolean;
    readonly open?: boolean;
}
export interface AgentModelPickerController {
    readonly root: HTMLSpanElement;
    readonly trigger: HTMLButtonElement;
    readonly popup: PopupSelectController;
    open(): void;
    close(): void;
    refresh(): void;
    setSelected(id: string | undefined): void;
    setPane(pane: 'root' | 'model' | 'effort'): void;
    dispose(): UiDisposer | Promise<void>;
}
/**
 * Candidate-only Agent model picker. It mirrors Harness model-selection
 * interaction while keeping model discovery and persistence injected.
 * `agentModel` remains a separate canonical native input in production.
 */
export declare function mountAgentModelPicker(host: HTMLElement, props: AgentModelPickerProps, scope: UiScope): AgentModelPickerController;
