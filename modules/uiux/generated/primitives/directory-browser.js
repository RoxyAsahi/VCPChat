import { mountButton } from './button.js';
import { mountModal } from './modal.js';
const STYLE_ID = 'vcp-harness-uiux-directory-browser';
function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID))
        return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Doubled selector deliberately beats the shared Modal dialog contract,
    // matching Harness DirectoryBrowser.module.css's `.dialog.dialog` seam.
    style.textContent = `.vcp-directory-browser.vcp-directory-browser{width:min(680px,100%);height:min(500px,calc(100dvh - 32px));padding:0;gap:0}.vcp-directory-browser-frame{display:flex;flex:1;min-height:0;flex-direction:column}.vcp-directory-browser-header{display:flex;flex:none;flex-direction:column;gap:8px;padding:16px 14px 8px 24px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-title{min-height:28px;margin:0;font-size:16px;font-weight:510;line-height:24px}.vcp-directory-browser-crumbs{display:flex;align-items:center;gap:4px;min-height:24px;overflow-x:auto}.vcp-directory-browser-crumb{max-width:160px;padding:0;border:0;background:transparent;overflow:hidden;color:var(--dsw-alias-label-tertiary,#737780);font:500 13px/20px inherit;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.vcp-directory-browser-crumb:hover{color:var(--dsw-alias-label-primary,#0f1115)}.vcp-directory-browser-content{position:relative;display:flex;flex:1;min-height:0;padding:16px 16px 16px 24px}.vcp-directory-browser-columns{display:flex;flex:1;min-width:0;gap:12px;overflow-x:auto}.vcp-directory-browser-column{display:flex;flex:1 1 0;flex-direction:column;min-width:256px;gap:2px;overflow-y:auto;padding-right:8px}.vcp-directory-browser-divider{flex:none;width:1px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-row{display:flex;align-items:center;gap:4px;width:100%;height:28px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:500 13px/20px inherit;text-align:left;cursor:pointer}.vcp-directory-browser-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}.vcp-directory-browser-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.1)))}.vcp-directory-browser-row-icon{flex:none;color:var(--dsw-alias-label-secondary,#50545b)}.vcp-directory-browser-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vcp-directory-browser-status{position:absolute;right:16px;bottom:8px;padding:2px 8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#50545b);font-size:12px;line-height:18px}.vcp-directory-browser-error{position:absolute;bottom:8px;left:24px;max-width:70%;color:var(--dsw-alias-state-error-primary,#d92d20);font-size:12px;line-height:18px}.vcp-directory-browser-footer{display:flex;flex:none;align-items:center;gap:8px;padding:12px 24px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.14))}.vcp-directory-browser-spacer{flex:1}.vcp-directory-browser-hidden{display:inline-flex;align-items:center;gap:4px;padding:4px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#50545b);font:inherit;font-size:12px;cursor:pointer}.vcp-directory-browser-hidden[aria-pressed=true]{color:var(--dsw-alias-label-primary,#0f1115)}`;
    (document.head || document.documentElement).append(style);
}
const errorText = (error) => error instanceof Error ? error.message : String(error);
/**
 * Candidate-only Light-DOM Miller browser. All filesystem actions are injected
 * by its owner; it does not import Electron, invoke IPC, or retain a path.
 */
export function mountDirectoryBrowser(props, scope) {
    if (!props?.listDirectory || !props.createDirectory || !props.onOpen || !props.onClose || !scope)
        throw new TypeError('DirectoryBrowser requires injected browse/create/open/close capabilities and scope.');
    ensureStyles();
    const browserScope = scope.child('harness-directory-browser');
    const frame = document.createElement('div');
    frame.className = 'vcp-directory-browser-frame';
    const header = document.createElement('header');
    header.className = 'vcp-directory-browser-header';
    const title = document.createElement('h2');
    title.className = 'vcp-directory-browser-title';
    title.textContent = props.title ?? 'Open folder';
    const crumbs = document.createElement('nav');
    crumbs.className = 'vcp-directory-browser-crumbs';
    crumbs.setAttribute('aria-label', 'Folder path');
    header.append(title, crumbs);
    const content = document.createElement('div');
    content.className = 'vcp-directory-browser-content';
    const columns = document.createElement('div');
    columns.className = 'vcp-directory-browser-columns';
    content.append(columns);
    const status = document.createElement('div');
    status.className = 'vcp-directory-browser-status';
    status.setAttribute('role', 'status');
    const error = document.createElement('div');
    error.className = 'vcp-directory-browser-error';
    error.setAttribute('role', 'alert');
    content.append(status, error);
    const footer = document.createElement('footer');
    footer.className = 'vcp-directory-browser-footer';
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = props.newFolderLabel ?? 'New folder';
    const hidden = document.createElement('button');
    hidden.type = 'button';
    hidden.className = 'vcp-directory-browser-hidden';
    hidden.textContent = props.showHiddenLabel ?? 'Show hidden files';
    hidden.setAttribute('aria-pressed', 'false');
    const spacer = document.createElement('span');
    spacer.className = 'vcp-directory-browser-spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = props.cancelLabel ?? 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = props.openLabel ?? 'Open';
    footer.append(create, hidden, spacer, cancel, confirm);
    frame.append(header, content, footer);
    mountButton(create, { variant: 'outline', size: 'sm' }, browserScope);
    mountButton(cancel, { variant: 'outline', size: 'sm' }, browserScope);
    mountButton(confirm, { variant: 'primary', size: 'sm' }, browserScope);
    let generation = 0;
    let controller = null;
    let parent = null;
    let selected = null;
    let child = null;
    let loading = false;
    let busy = Boolean(props.busy);
    let showHidden = false;
    let failure = null;
    let creating = false;
    const modal = mountModal({ title: props.title ?? 'Open folder', className: 'vcp-directory-browser', body: frame, headless: true, open: props.open, onClose: () => { if (!busy && !creating)
            props.onClose(); } }, browserScope);
    const visible = (entries) => entries.filter(entry => showHidden || !entry.hidden);
    const sync = () => {
        crumbs.replaceChildren();
        const source = child ?? parent;
        const chain = source?.crumbs?.length ? source.crumbs : source ? [{ name: source.path, path: source.path }] : [];
        chain.forEach((crumb, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'vcp-directory-browser-crumb'; button.textContent = `${index ? '› ' : ''}${crumb.name}`; button.disabled = busy || loading || creating; browserScope.listen(button, 'click', () => navigate(crumb.path)); crumbs.append(button); });
        columns.replaceChildren();
        const renderColumn = (listing, current, onPick) => { const column = document.createElement('div'); column.className = 'vcp-directory-browser-column'; visible(listing.entries).forEach(entry => { const row = document.createElement('button'); row.type = 'button'; row.className = 'vcp-directory-browser-row'; row.setAttribute('aria-current', String(current?.path === entry.path)); row.disabled = busy || loading || creating; const icon = document.createElement('span'); icon.className = 'vcp-directory-browser-row-icon vcp-ui-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = current?.path === entry.path ? 'folder-open' : 'folder'; const name = document.createElement('span'); name.className = 'vcp-directory-browser-row-name'; name.textContent = entry.name; row.append(icon, name); browserScope.listen(row, 'click', () => onPick(entry)); column.append(row); }); columns.append(column); };
        if (parent)
            renderColumn(parent, selected, pick);
        if (selected && child) {
            const divider = document.createElement('span');
            divider.className = 'vcp-directory-browser-divider';
            columns.append(divider);
            renderColumn(child, null, advance);
        }
        status.textContent = loading ? 'Loading…' : parent?.truncated || child?.truncated ? 'Some entries are not shown.' : '';
        status.hidden = status.textContent === '';
        error.textContent = failure ?? '';
        error.hidden = failure === null;
        hidden.setAttribute('aria-pressed', String(showHidden));
        hidden.disabled = busy || creating;
        create.disabled = !parent || loading || busy || creating;
        cancel.disabled = busy || creating;
        confirm.disabled = !parent || loading || busy || creating;
    };
    const scan = async (path, commit) => { const request = ++generation; controller?.abort(); controller = new AbortController(); loading = true; failure = null; sync(); try {
        const listing = await props.listDirectory(path, controller.signal);
        if (request !== generation || !modal.open)
            return;
        commit(listing);
    }
    catch (reason) {
        if (request !== generation || !modal.open)
            return;
        failure = errorText(reason);
    }
    finally {
        if (request === generation && modal.open) {
            loading = false;
            sync();
        }
    } };
    const navigate = (path) => { selected = null; child = null; void scan(path, listing => { parent = listing; }); };
    const pick = (entry) => { selected = entry; child = null; void scan(entry.path, listing => { child = listing; }); };
    const advance = (entry) => { if (!child)
        return; parent = child; selected = null; child = null; pick(entry); };
    browserScope.listen(hidden, 'click', () => { showHidden = !showHidden; sync(); });
    browserScope.listen(cancel, 'click', () => props.onClose());
    browserScope.listen(confirm, 'click', () => { const target = selected?.path ?? parent?.path; if (target)
        props.onOpen(target); });
    browserScope.listen(create, 'click', () => { if (!parent || creating)
        return; const name = 'New folder'; creating = true; sync(); const target = selected?.path ?? parent.path; const token = generation; void props.createDirectory(target, name).then(created => { if (token !== generation || !modal.open)
        return; creating = false; navigate(target); selected = { name, path: created }; }, reason => { if (token !== generation || !modal.open)
        return; creating = false; failure = errorText(reason); sync(); }); });
    const setOpen = (open) => { if (open) {
        modal.setOpen(true);
        parent = null;
        selected = null;
        child = null;
        failure = null;
        showHidden = false;
        navigate();
    }
    else {
        generation += 1;
        controller?.abort();
        controller = null;
        modal.setOpen(false);
    } };
    const dispose = scope.own(async () => { generation += 1; controller?.abort(); controller = null; await browserScope.dispose('harness-directory-browser-unmounted'); }, 'harness-directory-browser', 'ui-primitive');
    if (props.open)
        navigate();
    else
        sync();
    return { modal, get open() { return modal.open; }, setOpen, setBusy(value) { busy = Boolean(value); sync(); }, dispose };
}
