import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createConversationStatusPanel} from '../modules/ui-system/conversation-status-panel.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};};
const history=id=>[{role:'assistant',content:'<<<[TOOL_REQUEST]>>> tool_name:「始」ProjectForge「末」 projectId:「始」'+id+'「末」 <<<[END_TOOL_REQUEST]>>>'}];
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
for(const outcome of ['resolve','reject']) test('late A plan '+outcome+' cannot overwrite the refreshed B conversation',async()=>{
    const dom=new JSDOM('<main class="main-content"><header></header></main>',{url:'https://test.invalid'});dom.window.localStorage.setItem('vcp-status-panel-variant','panel');
    const pending=deferred(),started=deferred();let current=history('A');
    const panel=createConversationStatusPanel({document:dom.window.document,getHistory:()=>current,api:{
        projectForgeListProjects:async()=>({success:true,data:['A','B'].map(id=>({id,name:id,workspace_id:id}))}),
        gitListWorkspaces:async()=>({success:true,data:{workspaces:['A','B'].map(id=>({id,alias:id,path:'/code/'+id}))}}),
        gitChangeSummary:async id=>({success:true,data:{files:0,added:0,removed:0,branch:{head:id}}}),
        projectForgeGetProject:id=>{if(id==='A'){started.resolve();return pending.promise;}return Promise.resolve({success:true,data:{todos:[{seq:1,title:'B-only-task',status:'doing'}]}});}
    }});
    panel.mount();await started.promise;current=history('B');await panel.refresh();
    if(outcome==='resolve')pending.resolve({success:true,data:{todos:[{seq:1,title:'A-old-task',status:'doing'}]}});else pending.reject(Error('old request failed'));
    await settle();panel.setVariant('mini');panel.setVariant('panel');
    assert.ok(dom.window.document.body.textContent.includes('B-only-task'));
    assert.ok(!dom.window.document.body.textContent.includes('A-old-task'));
    panel.dispose();dom.window.close();
});

test('disposal invalidates a delayed workspace result without mounting or committing a plan',async()=>{
    const dom=new JSDOM('<main class="main-content"><header></header></main>',{url:'https://test.invalid'});const pending=deferred(),started=deferred();let planCalls=0;
    const panel=createConversationStatusPanel({document:dom.window.document,api:{gitListWorkspaces:()=>{started.resolve();return pending.promise;},projectForgeListProjects:async()=>{planCalls++;return {success:true,data:[]};}}});
    panel.mount();await started.promise;panel.dispose();pending.resolve({success:true,data:{workspaces:[{id:'late'}]}});await settle();
    assert.equal(planCalls,0);assert.equal(dom.window.document.querySelector('.zc-scope'),null);dom.window.close();
});
