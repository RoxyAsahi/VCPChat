import type { UiDisposer, UiScope } from '../contracts.js';
import { createDomRenderer } from '../runtime/dom-renderer.js';

export interface FieldProps {
    readonly label: string;
    readonly description?: string;
    readonly error?: string;
    readonly control: HTMLElement;
}

/** Harness Field contract rendered in Light DOM; no business state or IPC. */
export function mountField(root: HTMLElement, props: FieldProps, scope: UiScope): UiDisposer {
    if (!root || !props?.control || !scope) throw new TypeError('Field requires root, control and scope.');
    const fieldId = props.control.id || `vcp-field-${Math.random().toString(36).slice(2)}`;
    const originalId = props.control.getAttribute('id');
    const originalDescribedBy = props.control.getAttribute('aria-describedby');
    const originalInvalid = props.control.getAttribute('aria-invalid');
    const originalControlClass = props.control.getAttribute('class');
    props.control.id = fieldId;
    const existingLabel = root.tagName === 'LABEL' ? root : null;
    const label = existingLabel || document.createElement('label');
    if (!existingLabel) {
        label.className = 'vcp-harness-field-label';
        label.id = `${fieldId}-label`;
        label.textContent = props.label;
        (label as HTMLLabelElement).htmlFor = fieldId;
        root.prepend(label);
    } else {
        existingLabel.dataset.vcpFieldLabel = props.label;
        existingLabel.classList.add('vcp-harness-field-label');
        (existingLabel as HTMLLabelElement).htmlFor = fieldId;
    }
    const head = document.createElement('div');
    head.className = 'vcp-harness-field-head';
    if (!existingLabel) { root.insertBefore(head, label); head.append(label); }
    else head.remove();
    props.control.classList.add('vcp-harness-field-input');
    const description = props.description ? document.createElement('p') : null;
    if (description) { description.className = 'vcp-harness-field-description'; description.textContent = props.description ?? ''; }
    const error = props.error ? document.createElement('p') : null;
    if (error) { error.className = 'vcp-harness-field-error'; error.textContent = props.error ?? ''; props.control.classList.replace('vcp-harness-field-input', 'vcp-harness-field-input-invalid'); props.control.setAttribute('aria-invalid', 'true'); }
    root.classList.add('vcp-harness-field');
    const renderer = createDomRenderer(scope);
    if (description) renderer.mount(root, description);
    if (error) renderer.mount(root, error);
    return scope.own(() => {
        head.remove(); if (!existingLabel) label.remove(); else { delete existingLabel.dataset.vcpFieldLabel; existingLabel.classList.remove('vcp-harness-field-label'); }
        description?.remove(); error?.remove();
        root.classList.remove('vcp-harness-field');
        if (originalId === null) props.control.removeAttribute('id'); else props.control.setAttribute('id', originalId);
        if (originalInvalid === null) props.control.removeAttribute('aria-invalid'); else props.control.setAttribute('aria-invalid', originalInvalid);
        if (originalDescribedBy === null) props.control.removeAttribute('aria-describedby'); else props.control.setAttribute('aria-describedby', originalDescribedBy);
        if (originalControlClass === null) props.control.removeAttribute('class'); else props.control.setAttribute('class', originalControlClass);
    }, 'harness-field', 'ui-primitive');
}
