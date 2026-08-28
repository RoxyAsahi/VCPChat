// Presentation-only visibility projection for the Rust Assistant section.
export function syncRustAssistantVisibility(form) {
    if (!form) return;
    const useAssistant = form.querySelector('#rustUseAssistant')?.checked === true;
    const customThresholds = form.querySelector('#rustEnableCustomThresholds')?.checked === true;
    const ruleMode = form.querySelector('#rustRuleMode')?.value;
    const debugMode = form.querySelector('#rustDebugMode')?.checked === true;
    const show = (selector, visible) => {
        const node = form.querySelector(selector);
        if (node) node.style.display = visible ? 'block' : 'none';
    };
    show('#rustGuardRulesContainer', useAssistant);
    show('#rustCustomThresholdsPanel', customThresholds);
    show('#rustWhitelistPanel', ruleMode === 'whitelist');
    show('#rustBlacklistPanel', ruleMode === 'blacklist');
    show('#rustDebugPanel', debugMode);
}
