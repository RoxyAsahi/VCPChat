// Presentation-only visibility projection for the Advanced settings section.
// The form remains the canonical business DOM; this helper only reflects the
// current native control values into conditional rows.

export function syncAdvancedSettingsVisibility(form) {
    if (!form) return;
    const sanitizerToggle = form.querySelector('#enableContextSanitizer');
    const sanitizerContainer = form.querySelector('#contextSanitizerDepthContainer');
    if (sanitizerContainer) sanitizerContainer.style.display = sanitizerToggle?.checked ? 'block' : 'none';

    const middleClickToggle = form.querySelector('#enableMiddleClickQuickAction');
    const middleClickContainer = form.querySelector('#middleClickQuickActionContainer');
    const middleClickAdvancedContainer = form.querySelector('#middleClickAdvancedContainer');
    const advancedToggle = form.querySelector('#enableMiddleClickAdvanced');
    const advancedSettings = form.querySelector('#middleClickAdvancedSettings');
    if (middleClickContainer) middleClickContainer.style.display = middleClickToggle?.checked ? 'block' : 'none';
    if (middleClickAdvancedContainer) middleClickAdvancedContainer.style.display = middleClickToggle?.checked ? 'block' : 'none';
    if (advancedSettings) advancedSettings.style.display = advancedToggle?.checked ? 'block' : 'none';

    const quickAction = form.querySelector('#middleClickQuickAction');
    const regenerateConfirmation = form.querySelector('#regenerateConfirmationContainer');
    if (regenerateConfirmation) {
        regenerateConfirmation.style.display = middleClickToggle?.checked && quickAction?.value === 'regenerate'
            ? 'block'
            : 'none';
    }
}
