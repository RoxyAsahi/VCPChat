import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const repo=path.resolve(process.argv[2] || '.');
fs.mkdirSync('work', {recursive:true});
const require=createRequire(path.join(repo,'package.json'));
const {JSDOM}=require('jsdom');
const mod=async f=>import(pathToFileURL(path.join(repo,f)).href);
const results=[];
const dir=fs.mkdtempSync(path.resolve('work/probe-')); 
const {createModelTrajectoryRecorder}=require('./modules/modelTrajectory.js');
const recorder=createModelTrajectoryRecorder({rootDir:path.join(dir,'trajectory'),maxFileBytes:1024,maxFieldChars:1000,maxRecords:200});
const call=recorder.begin({sessionKey:'size',params:{extra:{apiKey:'test-secret-only'}},messages:Array.from({length:8},()=>({role:'user',content:'x'.repeat(1000)}))}); call.finish();
const listed=await recorder.list('size');
results.push({id:'trajectory-byte-limit',limit:1024,actual:fs.statSync(recorder.fileOf('size')).size,secretRetained:JSON.stringify(listed).includes('test-secret-only')});
results.push({id:'trajectory-key-collision',sameFile:recorder.fileOf('a/b')===recorder.fileOf('a?b')});
const {extractFileChanges}=await mod('modules/ui-system/message-file-changes.js');
const request=p=>`<<<[TOOL_REQUEST]>>>\ntool_name:「始」FileOperator「末」,\ncommand:「始」WriteFile「末」,\nfilePath:「始」${p}「末」\n<<<[END_TOOL_REQUEST]>>>`;
const failed='[[VCP调用结果信息汇总:\n- 工具名称: FileOperator\n- 执行状态: ❌ ERROR\n- 返回内容: deniedVCP调用结果结束]]';
results.push({id:'file-summary-mismatch',changes:extractFileChanges(request('failed.txt')+'\n'+failed+'\n'+request('pending.txt'))});
const state=await mod('modules/ui-system/side-pane/side-pane-state.js');
let pane=state.createInitialSidePaneState(); pane=state.setParent(pane,{itemId:'a',topicId:'t1'}); pane=state.openTab(pane,{id:'git',kind:'git',scopeMode:'global'}); pane=state.setParent(pane,{itemId:'a',topicId:'t2'});
results.push({id:'global-tab-switch',visible:pane.visible,active:pane.activeTabId,tabs:pane.tabs.map(t=>t.id)});
const {initialize}=require('./modules/ipc/sideChatHandlers.js'); const handlers=new Map();
initialize({USER_DATA_DIR:path.join(dir,'sidechat'),ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:()=>{}}});
const unauthorized=await handlers.get('side-chat:create-child')({senderFrame:{url:'https://untrusted.invalid'}},'agent_probe');
results.push({id:'sidechat-sender',unauthorizedSuccess:unauthorized.success});
const {createConversationStatusPanel}=await mod('modules/ui-system/conversation-status-panel.js');
const dom=new JSDOM('<main class="main-content"><header></header></main>',{url:'http://localhost'});
dom.window.localStorage.setItem('vcp-status-panel-variant','panel');
const project=id=>({id,name:id,workspace_id:id}); const ws=id=>({id,alias:id,path:'/code/'+id});
let history=[{role:'assistant',content:'<<<[TOOL_REQUEST]>>> tool_name:「始」ProjectForge「末」 projectId:「始」A「末」 <<<[END_TOOL_REQUEST]>>>'}];
let releaseA; let calledA; const waitA=new Promise(r=>calledA=r);
const panel=createConversationStatusPanel({document:dom.window.document,getHistory:()=>history,api:{
 projectForgeListProjects:async()=>({success:true,data:[project('A'),project('B')]}),
 gitListWorkspaces:async()=>({success:true,data:{workspaces:[ws('A'),ws('B')]}}),
 gitChangeSummary:async id=>({success:true,data:{files:0,added:0,removed:0,branch:{head:id}}}),
 projectForgeGetProject:id=>id==='A'?new Promise(r=>{releaseA=r;calledA();}):Promise.resolve({success:true,data:{todos:[{seq:1,title:'B-only-task',status:'doing'}]}})
}});
panel.mount(); await waitA;
history=[{role:'assistant',content:'<<<[TOOL_REQUEST]>>> tool_name:「始」ProjectForge「末」 projectId:「始」B「末」 <<<[END_TOOL_REQUEST]>>>'}];
await panel.refresh(); releaseA({success:true,data:{todos:[{seq:1,title:'A-old-task',status:'doing'}]}});
await new Promise(r=>setTimeout(r,20)); panel.setVariant('mini'); panel.setVariant('panel');
results.push({id:'status-stale-plan',visibleText:dom.window.document.body.textContent,oldPlanShown:dom.window.document.body.textContent.includes('A-old-task')});
panel.dispose(); dom.window.close();
const {createSendQueue,STORAGE_KEY}=await mod('modules/ui-system/send-queue.js');
const qdom=new JSDOM('<div class="chat-input-area"><div class="chat-input-card"><textarea id="messageInput"></textarea><button id="sendMessageBtn" data-mode="interrupt"></button></div></div>',{url:'http://localhost'});
const queue=createSendQueue({document:qdom.window.document,getContext:()=>({key:'a:t'})}); queue.mount();
for(let i=0;i<51;i++)queue.enqueue('draft-'+i);
const persisted=JSON.parse(qdom.window.localStorage.getItem(STORAGE_KEY));
results.push({id:'queue-truncation',inMemory:queue.getState().items.length,persisted:persisted['a:t'].length,lostLastDraft:!persisted['a:t'].some(i=>i.text==='draft-50')});
queue.dispose();qdom.window.close();
fs.writeFileSync(path.resolve('work/adversarial-results.json'),JSON.stringify(results,null,2)); console.log(JSON.stringify(results,null,2));
