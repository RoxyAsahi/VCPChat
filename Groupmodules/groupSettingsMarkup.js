// Compatibility facade for the schema-driven group settings surface.
// GroupRenderer still uses the historical global while the actual DOM is
// produced by modules/settings/schema/sidebar-surfaces.js.
window.GroupSettingsMarkup = (() => {
    function fallbackMarkup() {
        return `<form id="groupSettingsForm">
            <input type="hidden" id="editingGroupId">
            <div class="group-settings-section" data-section-key="identity"><div class="group-settings-section-header"><span>基础信息</span></div><div class="group-settings-section-content"><input id="groupNameInput"><input id="groupAvatarInput" type="file"><img id="groupAvatarPreview"><div id="groupMembersList"></div></div></div>
            <div class="group-settings-section" data-section-key="mode"><div class="group-settings-section-header"><span>群聊模式</span></div><div class="group-settings-section-content"><select id="groupChatMode"><option value="sequential">顺序发言</option><option value="naturerandom">自然随机</option><option value="invite_only">邀请发言</option></select><div id="sequentialOrderContainer"><div id="sequentialSpeakerOrderList"></div></div><div id="memberTagsContainer"><select id="tagMatchMode"><option value="strict">严格模式</option><option value="natural">自然模式</option></select><div id="memberTagsInputs"></div></div></div></div>
            <div class="group-settings-section" data-section-key="model"><div class="group-settings-section-header"><span>模型设置</span></div><div class="group-settings-section-content"><input id="groupUseUnifiedModel" type="checkbox"><div id="groupUnifiedModelContainer"><input id="groupUnifiedModelInput"><button id="openGroupModelSelectBtn" type="button">选择</button></div></div></div>
            <div class="group-settings-section" data-section-key="prompt"><div class="group-settings-section-header"><span>系统提示词</span></div><div class="group-settings-section-content"><textarea id="groupPrompt"></textarea><textarea id="invitePrompt"></textarea></div></div>
            <div class="form-actions"><button type="submit">保存群组设置</button><button type="button" id="deleteGroupBtn">删除此群组</button></div>
        </form>`;
    }

    function renderGroupSettingsMarkup() {
        const schema = window.VCPSettingsSchema;
        if (!schema?.renderGroupSettingsMarkup) {
            return fallbackMarkup();
        }
        return schema.renderGroupSettingsMarkup(document);
    }

    function renderGroupSettingsSurface(host) {
        const schema = window.VCPSettingsSchema;
        if (!schema?.renderGroupSettingsSurface) {
            host.innerHTML = fallbackMarkup();
            return host.querySelector('#groupSettingsForm');
        }
        return schema.renderGroupSettingsSurface(host, document);
    }

    return { renderGroupSettingsMarkup, renderGroupSettingsSurface };
})();
