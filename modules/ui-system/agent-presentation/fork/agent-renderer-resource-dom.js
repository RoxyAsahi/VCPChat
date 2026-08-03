export function getAttachmentFileVisualDescriptor(windowRef, name = '', type = '') {
    const resolver = windowRef.uiHelperFunctions?.resolveAttachmentFileVisual;
    if (typeof resolver === 'function') return resolver(name, type);
    return {
        kind: 'file',
        iconMarkup: `
<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path>
    <path d="M14 2v5a1 1 0 0 0 1 1h5"></path>
</svg>`,
    };
}

export async function renderAttachments({ documentRef, windowRef, electronAPI, message, contentDiv }) {
    if (!message.attachments?.length) return;
    const attachmentsContainer = documentRef.createElement('div');
    attachmentsContainer.classList.add('message-attachments');
    message.attachments.forEach((attachment) => {
        const wrapper = documentRef.createElement('div');
        wrapper.classList.add('message-attachment-wrapper');
        let element;
        if (attachment.type.startsWith('image/')) {
            element = documentRef.createElement('img');
            element.src = attachment.src;
            element.alt = `附件图片: ${attachment.name}`;
            element.title = `点击在新窗口预览: ${attachment.name}`;
            element.classList.add('message-attachment-image-thumbnail');
            element.onclick = (event) => {
                event.stopPropagation();
                const theme = documentRef.body.classList.contains('light-theme') ? 'light' : 'dark';
                electronAPI.openImageViewer({ src: attachment.src, title: attachment.name, theme });
            };
            element.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                electronAPI.showImageContextMenu(attachment.src);
            });
        } else if (attachment.type.startsWith('audio/')) {
            element = documentRef.createElement('audio');
            element.src = attachment.src;
            element.controls = true;
        } else if (attachment.type.startsWith('video/')) {
            element = documentRef.createElement('video');
            element.src = attachment.src;
            element.controls = true;
            element.classList.add('message-attachment-video');
        } else {
            element = documentRef.createElement('a');
            element.href = attachment.src;
            const visual = getAttachmentFileVisualDescriptor(windowRef, attachment.name, attachment.type);
            element.classList.add('message-attachment-file', `message-attachment-file--${visual.kind}`);
            element.title = `点击打开文件: ${attachment.name}`;
            element.onclick = (event) => {
                event.preventDefault();
                if (electronAPI.sendOpenExternalLink && attachment.src.startsWith('file://')) {
                    electronAPI.sendOpenExternalLink(attachment.src);
                } else {
                    console.warn('Cannot open local file attachment', attachment.src);
                }
            };
            const icon = documentRef.createElement('span');
            icon.className = 'message-attachment-file-icon';
            icon.innerHTML = visual.iconMarkup;
            const name = documentRef.createElement('span');
            name.className = 'message-attachment-file-name';
            name.textContent = attachment.name;
            element.append(icon, name);
        }
        wrapper.appendChild(element);
        attachmentsContainer.appendChild(wrapper);
    });
    contentDiv.appendChild(attachmentsContainer);
}
