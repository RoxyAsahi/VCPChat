/**
 * 桌宠上输入的话由主窗口按正常流程发送：切到那个 Agent，再用请求对象调用
 * handleSendMessage。不经过主输入框，用户还没发的草稿和已选附件都不会被带走或覆盖。
 */
export const DESK_PET_SEND_ACCEPT_MS = 1500;

export function createDeskPetSendBridge({
    getSelectedItem,
    getTopicId,
    findAgent,
    selectItem,
    sendMessage,
    isBusy,
    acceptMs = DESK_PET_SEND_ACCEPT_MS,
    wait = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}) {
    return async function sendFromPet({ agentId, text } = {}) {
        if (typeof agentId !== 'string' || !agentId || typeof text !== 'string' || !text.trim()) {
            return { success: false, error: '没有内容' };
        }
        if (getSelectedItem()?.id !== agentId || !getTopicId()) {
            const item = findAgent(agentId);
            if (!item) return { success: false, error: '助手列表里找不到这个 Agent' };
            // 等整个选中事务完成（话题定下来）再发；选中刚开始时话题还是空的，那时发出去的话会被丢掉。
            await selectItem(item);
        }
        const selected = getSelectedItem();
        if (selected?.id !== agentId || selected?.type !== 'agent' || !getTopicId()) {
            return { success: false, error: '没能切换到这个助手' };
        }
        if (isBusy()) return { success: false, error: '上一条还在回复中' };
        const sending = Promise.resolve().then(() => sendMessage({ content: text, attachments: [], propagateError: true }));
        // 发送要等回复开始流才返回；这里只等校验和落盘这一小段，之后的错误会显示在聊天里，桌宠也会收到出错事件。
        const early = await Promise.race([
            sending.then(() => null, error => error || new Error('发送失败')),
            wait(acceptMs).then(() => null),
        ]);
        // shownInChat：话已经存进历史，只是回复失败（聊天里有报错）；不能让桌宠当成没发出去再发一遍。
        if (early && !early.shownInChat) return { success: false, error: early.message || String(early) };
        return { success: true };
    };
}
