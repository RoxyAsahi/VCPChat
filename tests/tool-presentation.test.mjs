import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
const source = fs.readFileSync('modules/renderer/toolPresentation.js','utf8');
const {createToolPresentation,toolStatus} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const req=()=>`<div class="vcp-tool-use-bubble" data-vcp-block-type="tool-use"><div class="vcp-tool-summary"><span class="vcp-tool-label">VCP-ToolUse:</span><span class="vcp-tool-name-highlight">ProjectForge</span></div><div class="vcp-tool-details"></div><template class="vcp-tool-details-template"><pre>tool_name:「始」ProjectForge「末」\ncommand:「始」GetCode「末」\npath:「始」demo/index.html「末」</pre></template></div>`;
const res=(status='SUCCESS',hash='h',body='真实结果')=>`<div class="vcp-tool-result-bubble collapsible" data-vcp-block-type="tool-result" data-vcp-tool-result-index="2" data-vcp-tool-result-hash="${hash}"><div class="vcp-tool-result-header"><span class="vcp-tool-result-label">VCP-ToolResult</span><span class="vcp-tool-result-name">ProjectForge</span><span class="vcp-tool-result-status">${status}</span><span class="vcp-result-toggle-icon"></span><button class="vcp-tool-result-delete-btn">删除</button></div><div class="vcp-tool-result-collapsible-content"><div class="vcp-tool-result-details">${body}</div></div></div>`;
const summary='<div class="vcp-tool-call-summary-bubble" data-vcp-block-type="tool-call-summary"><div class="vcp-tool-call-summary-header"><span class="vcp-tool-call-summary-icon">图标</span><span class="vcp-tool-call-summary-title">本轮工具调用摘要</span></div><div class="vcp-tool-call-summary-list"><span>ProjectForge 成功</span></div></div>';
function fixture(html,p={toolPresentation:'grouped',toolExpansion:'attention'}){
 const dom=new JSDOM(`<html data-ui-mode="next"><body><div id="root"><article class="message-item"><div class="md-content">${html}</div></article></div></body></html>`,{url:'https://vcp.local/'});
 const root=dom.window.document.getElementById('root'),content=root.querySelector('.md-content');
 const presenter=createToolPresentation({root,getProfile:()=>p});
 return {dom,root,content,p,presenter,apply:()=>presenter.apply(content),close:()=>{presenter.dispose();dom.window.close();}};
}
test('unknown and misleading status never becomes success',()=>{
 assert.equal(toolStatus('SUCCESS'),'success');assert.equal(toolStatus('❌ ERROR'),'failed');assert.equal(toolStatus('success but error?'),'unknown');assert.equal(toolStatus(''),'unknown');
});
test('Legacy remains exact; new mode round-trips original headers and summary',()=>{
 const f=fixture(req()+res()+summary,{toolPresentation:'legacy'});const before=f.content.innerHTML;f.apply();assert.equal(f.content.innerHTML,before);
 f.p.toolPresentation='grouped';f.apply();assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,3);
 f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
test('Classic and auxiliary documents keep the existing renderer even with a Next preference',()=>{
 const f=fixture(req()+res());f.dom.window.document.documentElement.dataset.uiMode='classic';const before=f.content.innerHTML;f.apply();assert.equal(f.content.innerHTML,before);f.close();
});
test('counts are requests/results, no fabricated pairing and no crossing text/roles',()=>{
 const f=fixture(req()+req()+res('ERROR')+'<p>说明文字</p>'+res('SUCCESS','b')+'<div data-vcp-block-type="role-divider">User</div>'+req());f.apply();
 const groups=[...f.content.querySelectorAll('.vcp-tool-process')];assert.equal(groups.length,3);assert.match(groups[0].textContent,/2 请求 1 结果/);assert.match(groups[0].textContent,/1 失败/);
 assert.equal(f.content.querySelectorAll('.vcp-tool-presented').length,5);f.close();
});
test('failures visible; unknown stays unknown; exact delete button preserved',()=>{
 const f=fixture(res('ERROR')+res('Unknown Status','b'));const original=f.content.querySelector('.vcp-tool-result-delete-btn');f.apply();
 const failed=f.content.querySelector('[data-vcp-tool-state="failed"]');assert.ok(failed.classList.contains('expanded'));assert.equal(failed.dataset.vcpToolResultHash,'h');assert.equal(failed.dataset.vcpToolResultIndex,'2');assert.equal(failed.querySelector('.vcp-tool-result-delete-btn'),original);assert.equal(failed.querySelector('.vcp-tool-row-toggle').contains(original),false);
 assert.match(f.content.querySelector('.vcp-tool-process-stats').textContent,/状态未知/);f.close();
});
test('request lazily mounts; repeated apply keeps name and user disclosure state',()=>{
 const f=fixture(req());f.apply();assert.equal(f.content.querySelector('.vcp-tool-details').childNodes.length,0);
 f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(f.content.querySelectorAll('.vcp-tool-details pre').length,1);f.apply();f.apply();assert.match(f.content.querySelector('.vcp-tool-row-title').textContent,/读取源码/);assert.equal(f.content.querySelectorAll('.vcp-tool-details pre').length,1);
 f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(f.content.querySelector('.vcp-tool-details').childNodes.length,0);f.close();
});
test('repeated identical requests remain separate and preserve their own states on terminal replacement',()=>{
 const html=req()+req();const f=fixture(html);f.apply();const buttons=f.content.querySelectorAll('.vcp-tool-row-toggle');buttons[1].click();f.presenter.capture(f.content);f.content.innerHTML=html;f.apply();const nodes=f.content.querySelectorAll('.vcp-tool-presented');assert.notEqual(nodes[0].dataset.vcpToolKey,nodes[1].dataset.vcpToolKey);assert.equal(nodes[0].classList.contains('expanded'),false);assert.equal(nodes[1].classList.contains('expanded'),true);f.close();
});
test('folded group keeps failure count and rich result entry outside body',()=>{
 const f=fixture(res('ERROR')+res('SUCCESS','img','<img class="vcp-tool-result-image" src="https://local.test/image.png" alt="图片">'),{toolPresentation:'grouped',toolExpansion:'none'});f.apply();
 assert.equal(f.content.querySelector('.vcp-tool-process-body').hidden,true);assert.match(f.content.querySelector('.vcp-tool-process-stats').textContent,/失败/);
 const artifact=f.content.querySelector('.vcp-tool-process-artifact');assert.equal(artifact.closest('.vcp-tool-process-body'),null);artifact.click();assert.equal(f.content.querySelector('.vcp-tool-process-body').hidden,false);assert.ok(f.content.querySelector('[data-vcp-tool-result-hash="img"]').classList.contains('expanded'));f.close();
});
test('summary details can collapse and dispose removes capture listeners',()=>{
 const f=fixture(summary);f.apply();assert.equal(f.content.querySelector('.vcp-tool-presented').classList.contains('expanded'),false);const b=f.content.querySelector('.vcp-tool-row-toggle');b.click();assert.equal(b.getAttribute('aria-expanded'),'true');f.presenter.dispose();b.click();assert.equal(b.getAttribute('aria-expanded'),'true');f.close();
});
test('appearance event immediately updates and cancels preview on existing DOM',()=>{
 const f=fixture(req(),{toolPresentation:'legacy'});f.apply();f.p.toolPresentation='compact';f.dom.window.dispatchEvent(new f.dom.window.Event('vcp-appearance-changed'));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,1);f.p.toolPresentation='legacy';f.dom.window.dispatchEvent(new f.dom.window.Event('vcp-appearance-changed'));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,0);f.close();
});
test('preview uses event payload even if getCurrent is published a moment later',()=>{
 const f=fixture(req(),{toolPresentation:'legacy'});f.apply();f.dom.window.dispatchEvent(new f.dom.window.CustomEvent('vcp-appearance-changed',{detail:{profile:{toolPresentation:'compact'}}}));assert.equal(f.content.querySelectorAll('.vcp-tool-row-toggle').length,1);f.close();
});
test('late file-change actions retain their identity and click handler across previews',()=>{
 const f=fixture(res());f.apply();let clicks=0;const badge=f.dom.window.document.createElement('button');badge.className='vcp-file-changes-counts';badge.textContent='+1 -1';badge.addEventListener('click',()=>clicks++);f.content.querySelector('.vcp-tool-result-header').append(badge);f.apply();assert.equal(f.content.querySelector('.vcp-file-changes-counts'),badge);badge.click();assert.equal(clicks,1);f.p.toolPresentation='legacy';f.apply();assert.equal(f.content.querySelector('.vcp-file-changes-counts'),badge);f.close();
});
test('stable stream segments retain individual choices when finalized into the canonical tree',()=>{
 const f=fixture(`<div class="vcp-stream-stable-block">${req()}</div><div class="vcp-stream-stable-block">${req()}</div>`);
 for(const block of f.content.querySelectorAll('.vcp-stream-stable-block'))f.presenter.apply(block);
 f.content.querySelectorAll('.vcp-tool-row-toggle')[1].click();f.presenter.capture(f.content);f.content.innerHTML=req()+req();f.apply();assert.equal(f.content.querySelectorAll('.vcp-tool-presented')[1].classList.contains('expanded'),true);f.close();
});

test('none expansion keeps rich rows folded until explicitly opened',()=>{
 const f=fixture(res('SUCCESS','media','<img class="vcp-tool-result-image" src="https://local.test/image.png">'),{toolPresentation:'compact',toolExpansion:'none'});f.apply();const block=f.content.querySelector('.vcp-tool-presented');assert.equal(block.classList.contains('expanded'),false);f.content.querySelector('.vcp-tool-row-toggle').click();assert.equal(block.classList.contains('expanded'),true);f.close();
});
test('unknown command names cannot inherit object prototype summaries',()=>{
 const f=fixture(req().replace('GetCode','constructor'));f.apply();assert.match(f.content.querySelector('.vcp-tool-row-title').textContent,/ProjectForge · constructor/);f.close();
});
