// Stable presentation keys for the canonical Global Settings rows. This is
// metadata only: settingsManager and the native controls remain authoritative.
const SECTION_KEYS = Object.freeze({
    '用户身份': 'user-identity',
    '服务器连接': 'server-connection',
    '界面与外观': 'appearance-settings',
    '消息渲染': 'render-settings',
    '划词助手': 'selection-assistant',
    '语音设置': 'voice-settings',
    '高级功能': 'advanced-features',
    '快捷操作': 'quick-actions',
});

function sectionKeyForRow(row) {
    const section = row?.closest?.('.settings-section');
    const title = section?.querySelector?.(':scope > .settings-section-title')?.textContent?.trim();
    return title ? SECTION_KEYS[title] || '' : '';
}

export { SECTION_KEYS, sectionKeyForRow };
