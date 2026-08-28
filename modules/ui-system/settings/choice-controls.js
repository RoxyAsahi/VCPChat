// Appearance/voice Choice primitive mounting. Native radios remain canonical.
export function mountChoiceControls(form, api, scope) {
    if (!form || !scope || !api?.mountChoice) return;
    const voice = form.querySelector('#voiceModeLocal')?.closest('.vcp-settings-control-row');
    if (voice && voice.dataset.vcpTypedPrimitiveMounted !== 'true') {
        api.mountChoice(voice, scope);
        voice.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete voice.dataset.vcpTypedPrimitiveMounted; }, 'typed-voice-mode-choice-marker', 'ui-primitive');
    }
}
