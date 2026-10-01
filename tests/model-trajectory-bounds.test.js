const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createModelTrajectoryRecorder}=require('../modules/modelTrajectory');
const {sanitizeParams}=require('../modules/modelTrajectoryStorage');
function setup(t,options={}){const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'trajectory-bounds-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));return {rootDir,recorder:createModelTrajectoryRecorder({rootDir,...options})};}
test('recursive redaction protects objects, arrays, cycles, depth and getters without mutating the request',()=>{
    const params={temperature:0.5,max_tokens:100,extra:{apiKey:'secret-a',nested:[{password:'secret-b',headers:{Authorization:'secret-c'},ok:1}]}};params.self=params;
    Object.defineProperty(params,'getter',{enumerable:true,get(){throw Error('must not evaluate accessor');}});
    const clean=sanitizeParams(params);assert.equal(JSON.stringify(clean).includes('secret-'),false);assert.equal(clean.max_tokens,100);assert.equal(clean.extra.nested[0].ok,1);assert.equal(params.extra.apiKey,'secret-a');
    assert.equal(JSON.stringify(sanitizeParams({media:'data:IMAGE/png;base64,private-media'})).includes('private-media'),false);
});
test('single huge UTF-8 record and repeated writes never exceed the actual file byte budget',async t=>{
    const {recorder}=setup(t,{maxFileBytes:1024,maxFieldChars:1000});
    for(let i=0;i<5;i++){
        const call=recorder.begin({sessionKey:'bytes',requestId:'r'+i,params:{extra:{apiKey:'test-secret-only'}},messages:Array.from({length:8},()=>({role:'user',content:'中文😀'.repeat(1000)}))});
        call.chunk({choices:[{delta:{content:'😀'.repeat(2000),reasoning_content:'中'.repeat(2000)}}]});call.finish();
        const result=await recorder.list('bytes');assert.equal(result.records.at(-1).requestId,'r'+i);assert.ok(result.records.at(-1).truncated);
        assert.ok(fs.statSync(recorder.fileOf('bytes')).size<=1024);assert.ok(!fs.readFileSync(recorder.fileOf('bytes'),'utf8').includes('test-secret-only'));
    }
});
test('running stream snapshots bound aggregate text, reasoning and tool payloads before finish',async t=>{
    const {recorder}=setup(t,{maxFileBytes:4096,maxFieldChars:64});const call=recorder.begin({sessionKey:'stream'});
    for(let i=0;i<100;i++)call.chunk({choices:[{delta:{content:'x'.repeat(1000),reasoning_content:'y'.repeat(1000),tool_calls:[{index:i,id:'tool-'+i,function:{name:'f',arguments:'z'.repeat(1000)}}]}}]});
    const record=(await recorder.list('stream')).records[0];assert.ok(record.truncated);assert.ok(record.response.text.length<=64);assert.ok(record.response.reasoningText.length<=64);assert.ok(record.response.toolCalls.length<=32);
    const chars=record.response.text.length+record.response.reasoningText.length+record.response.toolCalls.reduce((sum,c)=>sum+c.input.length+c.toolName.length+(c.toolCallId?.length||0),0);assert.ok(chars<=128);
    call.finish();await recorder.list('stream');
});
test('tail reads and persistence use asynchronous IO, tolerate a legacy oversized file and flag truncation',async t=>{
    const {recorder,rootDir}=setup(t,{maxFileBytes:2048});const record={id:'legacy',sessionKey:'tail',startedAt:1,request:{messages:[]},response:null,status:'completed'};
    fs.writeFileSync(path.join(rootDir,'tail.jsonl'),'x'.repeat(200000)+'\n'+JSON.stringify(record)+'\n');
    const read=fs.readFileSync;fs.readFileSync=()=>{throw Error('sync read forbidden');};
    let result;try{result=await recorder.list('tail');}finally{fs.readFileSync=read;}
    assert.equal(result.records[0].id,'legacy');assert.equal(result.truncated,true);
    const call=recorder.begin({sessionKey:'tail',requestId:'new'});call.finish();result=await recorder.list('tail');assert.equal(result.records.at(-1).requestId,'new');assert.ok(fs.statSync(recorder.fileOf('tail')).size<=2048);
});
test('hashed session filenames cannot collide and legacy records are filtered by exact session key',async t=>{
    const {recorder,rootDir}=setup(t);assert.notEqual(recorder.fileOf('a/b'),recorder.fileOf('a?b'));
    fs.writeFileSync(path.join(rootDir,'a_b.jsonl'),JSON.stringify({id:'other',sessionKey:'a/b',startedAt:1})+'\n'+JSON.stringify({id:'own',sessionKey:'a?b',startedAt:2})+'\n');
    assert.deepEqual((await recorder.list('a?b')).records.map(r=>r.id),['own']);
    await recorder.clear('a?b');const reopened=createModelTrajectoryRecorder({rootDir});assert.equal((await reopened.list('a?b')).records.length,0);
    assert.equal((await reopened.list('a/b')).records[0].id,'other');
});
test('clear invalidates current recording handles and later finish cannot resurrect cleared records',async t=>{
    const {recorder}=setup(t);const call=recorder.begin({sessionKey:'clear'});await recorder.clear('clear');call.finish({response:{choices:[{message:{content:'late'}}]}});assert.equal((await recorder.list('clear')).records.length,0);
});

test('clear takes effect before its IO completes and cannot be followed by a stale finish',async t=>{
 const {recorder}=setup(t);const call=recorder.begin({sessionKey:'race'});
 const clear=recorder.clear('race');call.finish({response:{choices:[{message:{content:'must not resurrect'}}]}});
 await clear;assert.equal((await recorder.list('race')).records.length,0);
});
test('clearing immediately after finish cancels the already queued snapshot',async t=>{
 const {recorder}=setup(t);recorder.begin({sessionKey:'queued'}).finish();await recorder.clear('queued');
 assert.equal((await recorder.list('queued')).records.length,0);
});
test('normalized multipart inputs share a single character budget',()=>{
 const {normalizeMessage}=require('../modules/modelTrajectory');
 const value=normalizeMessage({content:Array.from({length:32},()=>({type:'text',text:'x'.repeat(1000)}))},100);
 assert.equal(value.parts.reduce((sum,part)=>sum+(part.text?.length||0),0),100);
});

test('recording opt-out invalidates handles and queued snapshots',async t=>{
 const {recorder}=setup(t,{enabled:false});assert.equal(recorder.begin({sessionKey:'off'}).id,null);
 recorder.setEnabled(true);const call=recorder.begin({sessionKey:'off'});call.finish();recorder.setEnabled(false);
 assert.equal((await recorder.list('off')).records.length,0);
});
test('retention expires old legacy logs and bounds total recorder-owned files',async t=>{
 const {rootDir,recorder}=setup(t,{maxTotalBytes:1024,retentionDays:7});
 fs.writeFileSync(path.join(rootDir,'old.jsonl'),'x'.repeat(900));fs.utimesSync(path.join(rootDir,'old.jsonl'),new Date(1),new Date(1));
 fs.writeFileSync(path.join(rootDir,'one.jsonl'),'x'.repeat(700));fs.writeFileSync(path.join(rootDir,'two.jsonl'),'x'.repeat(700));
 fs.writeFileSync(path.join(rootDir,'do-not-delete.txt'),'user-owned');await recorder.enforceRetention();
 assert.equal(fs.existsSync(path.join(rootDir,'old.jsonl')),false);
 const size=fs.readdirSync(rootDir).filter(name=>name.endsWith('.jsonl')).reduce((sum,name)=>sum+fs.statSync(path.join(rootDir,name)).size,0);
 assert.ok(size<=1024);assert.equal(fs.readFileSync(path.join(rootDir,'do-not-delete.txt'),'utf8'),'user-owned');
});

test('request budget includes tool identities, names and image URLs across all messages',async t=>{
 const {recorder}=setup(t,{maxFieldChars:1024});const call=recorder.begin({sessionKey:'request-metadata',messages:Array.from({length:200},()=>({role:'user',name:'N'.repeat(500),content:Array.from({length:32},()=>({type:'image_url',image_url:{url:'https://example.invalid/'+ 'u'.repeat(1000)}})),tool_calls:[{id:'I'.repeat(1000),function:{name:'F'.repeat(1000),arguments:''}}]}))});
 const record=(await recorder.list('request-metadata')).records[0];const strings=[];function collect(v){if(typeof v==='string')strings.push(v);else if(v&&typeof v==='object')for(const [key,x]of Object.entries(v)){if(['kind'].includes(key))continue;collect(x);}}collect(record.request.messages);assert.ok(strings.join('').length<=1024);assert.equal(record.truncated,true);call.finish();await recorder.list('request-metadata');
});
