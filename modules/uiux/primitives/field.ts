import type { UiDisposer, UiScope } from '../contracts.js';

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
    props.control.id = fieldId;
    const existingLabel = root.tagName === 'LABEL' ? root : null;
    const label = existingLabel || document.createElement('label');
    if (!existingLabel) {
        label.className = 'vcp-harness-field-label';
        label.textContent = props.label;
        (label as HTMLLabelElement).htmlFor = fieldId;
        root.prepend(label);
    } else {
        existingLabel.dataset.vcpFieldLabel = props.label;
        existingLabel.classList.add('vcp-harness-field-label');
        (existingLabel as HTMLLabelElement).htmlFor = fieldId;
    }
    const description = props.description ? document.createElement('div') : null;
    if (description) { description.className = 'vcp-harness-field-description'; description.textContent = props.description ?? ''; }
    const error = props.error ? document.createElement('div') : null;
    if (error) { error.className = 'vcp-harness-field-error'; error.textContent = props.error ?? ''; error.id = `${fieldId}-error`; props.control.setAttribute('aria-invalid', 'true'); props.control.setAttribute('aria-describedby', error.id); }
    root.classList.add('vcp-harness-field');
    if (description) root.append(description);
    if (error) root.append(error);
    return scope.own(() => {
        if (!existingLabel) label.remove(); else { delete existingLabel.dataset.vcpFieldLabel; existingLabel.classList.remove('vcp-harness-field-label'); }
        description?.remove(); error?.remove();
        root.classList.remove('vcp-harness-field');
        if (error) { props.control.removeAttribute('aria-invalid'); props.control.removeAttribute('aria-describedby'); }
    }, 'harness-field', 'ui-primitive');
}
