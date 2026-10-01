'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const activeAtomicTemps = new Set();
const tempKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const isActiveAtomicTemp = file => activeAtomicTemps.has(tempKey(file));
const SECRET = /(api[-_]?key|secret|authorization|password|bearer|credential|(?:access|refresh|auth)[-_]?token)/i;

function sanitizeParams(params) {
    const seen = new WeakSet();let nodes = 2048, chars = 16000;
    function visit(value, depth) {
        if (--nodes < 0 || chars <= 0 || depth > 12) return '[已截断]';
        if (typeof value === 'string') { const text = /^data:(image|video)\//i.test(value) ? '[媒体数据已省略]' : value.slice(0,Math.min(500,chars));chars -= text.length;return text; }
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (value === null || typeof value === 'boolean') return value;
        if (!value || typeof value !== 'object') return undefined;
        if (seen.has(value)) return '[循环引用]';
        seen.add(value);
        const result = Array.isArray(value) ? [] : {};
        for (const key in value) {
            if (--nodes < 0) break;
            if (!Object.hasOwn(value,key)) continue;
            if (key.length > 128 || key.length > chars) continue;
            chars -= key.length;
            // 递归净化数组及对象，不能把嵌套参数原样交给 JSON.stringify。
            if (SECRET.test(key) || ['messages','requestId','__proto__','constructor','prototype'].includes(key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(value,key);
            if (!descriptor || !Object.hasOwn(descriptor,'value')) continue;
            const clean = visit(descriptor.value,depth + 1);
            if (clean !== undefined) result[key] = clean;
            if (nodes <= 0 || chars <= 0) break;
        }
        seen.delete(value);
        return result;
    }
    return visit(params && typeof params === 'object' ? params : {},0);
}

async function readFileTail(file, maxBytes) {
    let handle;
    try {
        handle = await fs.open(file,'r');
        const {size} = await handle.stat();
        const length = Math.min(size,maxBytes,16 * 1024 * 1024);
        const offset = size - length;
        const buffer = Buffer.alloc(length);let read = 0;
        while (read < length) { const result = await handle.read(buffer,read,length-read,offset+read);if (!result.bytesRead) break;read += result.bytesRead; }
        let text = buffer.subarray(0,read).toString('utf8');
        if (offset) { const end = text.indexOf('\n');text = end < 0 ? '' : text.slice(end+1); }
        return { text, truncated: offset > 0, exists: true };
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return {text:'',truncated:false,exists:false};
    } finally { await handle?.close(); }
}

function fitRecord(record, maxBytes) {
    const line = value => JSON.stringify(value)+'\n';
    let encoded=line(record);
    if (Buffer.byteLength(encoded) <= maxBytes) return encoded;
    function shrink(value, chars, key = '', depth = 0) {
        if (typeof value === 'string') return ['id','requestId','sessionKey','status','kind'].includes(key) ? value : value.slice(0,chars);
        if (!value || typeof value !== 'object' || depth > 12) return value;
        if (Array.isArray(value)) return value.slice(-Math.max(1,Math.floor(chars/100))).map(v=>shrink(v,chars,'',depth+1));
        return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shrink(v,chars,k,depth+1)]));
    }
    for(let chars=Math.min(64000,Math.floor(maxBytes/4));chars>=1;chars=Math.floor(chars/2)) {
        encoded=line({...shrink(record,chars),truncated:true});
        if(Buffer.byteLength(encoded)<=maxBytes) return encoded;
    }
    const minimal={id:record.id,sessionKey:record.sessionKey,requestId:record.requestId,startedAt:record.startedAt,status:record.status,retention:record.retention,truncated:true,source:{kind:record.source?.kind},model:{modelId:''},request:{messages:[]},response:null};
    encoded=line(minimal);
    if(Buffer.byteLength(encoded)<=maxBytes)return encoded;
    return null;
}

async function atomicWrite(file, text) {
    const temp=file+'.tmp-'+crypto.randomBytes(8).toString('hex');
    const key = tempKey(temp);
    activeAtomicTemps.add(key);
    try { await fs.writeFile(temp,text,'utf8');await fs.rename(temp,file); }
    finally {
        await fs.rm(temp,{force:true}).catch(()=>{});
        activeAtomicTemps.delete(key);
    }
}
module.exports={sanitizeParams,readFileTail,fitRecord,atomicWrite,isActiveAtomicTemp};
