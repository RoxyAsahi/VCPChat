'use strict';
const electron = require('electron');
const { app, BrowserWindow, protocol, net, ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');
process.on('uncaughtException', error => { fs.writeFileSync(path.join(__dirname, 'nova-expression-integration-uncaught.log'), error.stack); app.exit(3); });
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
if (!process.argv[2] || !process.env.NOVA_CUBISM_CORE_PATH) throw new Error('Usage: electron tools/nova/verify_expressions.cjs OUTPUT_DIR, with NOVA_CUBISM_CORE_PATH set to your Core 5.x file');
const resultDir = path.resolve(process.argv[2]);
const data = path.join(resultDir, 'appdata');
fs.mkdirSync(path.join(data, 'deskpet'), { recursive: true });
fs.mkdirSync(path.join(data, 'Agents', 'nova-test'), { recursive: true });
fs.writeFileSync(path.join(data, 'Agents', 'nova-test', 'config.json'), JSON.stringify({ name: 'Nova' }));
fs.writeFileSync(path.join(data, 'deskpet', 'settings.json'), JSON.stringify({ restoreOnStartup: false, doNotDisturb: false, shortcuts: { toggle: '', talk: '' } }));
fs.copyFileSync(process.env.NOVA_CUBISM_CORE_PATH, path.join(data, 'deskpet', 'live2dcubismcore.min.js'));
app.setPath('userData', path.join(resultDir, 'electron-profile'));
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
// QA process never acquires global shortcuts or changes the running VCPChat.
electron.globalShortcut.register = () => true;
electron.globalShortcut.unregister = () => {};
electron.globalShortcut.unregisterAll = () => {};
const handlers = require(path.join(root, 'modules/ipc/deskPetHandlers.js'));
handlers.registerSchemes();
const registered = new Map();
let capturedMenu = null;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => { registered.set(channel, callback); return handle(channel, callback); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const logs = [];
const result = { cases: [], errors: [], assertions: [] };
const timer = setTimeout(() => { fs.writeFileSync(path.join(resultDir, 'timeout.json'), JSON.stringify(result, null, 2)); app.exit(2); }, 150000);
app.whenReady().then(async () => {
  electron.Menu.buildFromTemplate = template => { capturedMenu = template; return { popup() {} }; };
  fs.writeFileSync(path.join(resultDir, 'stage.txt'), 'ready');
  const testPaths = { projectRoot: root, appDataRoot: data, agentDir: path.join(data, 'Agents') };
  handlers.initialize(testPaths);
  protocol.unhandle('vcp-deskpet');
  protocol.handle('vcp-deskpet', async request => {
    const file = handlers._resolveServedFile(request.url, testPaths);
    if (!file || !fs.existsSync(file)) { result.errors.push(`404 ${request.url}`); return new Response('not found', { status: 404 }); }
    if (file === path.join(root, 'DeskPetmodules', 'deskpet.js')) {
      // Instrument this QA response only; shipped renderer is unchanged.
      const source = fs.readFileSync(file, 'utf8')
        .replace('const coreModel = internal.coreModel;', 'const coreModel = internal.coreModel; window.__qaRig = { coreModel, model, app, internal };')
        .replace('window.__deskPetReady = {', 'window.__qaBackend = backend; window.__deskPetReady = {');
      return new Response(source, { headers: { 'Content-Type': 'text/javascript' } });
    }
    return net.fetch(pathToFileURL(file).href);
  });
  await delay(100);
  for (const preset of ['tech', 'maid', 'chibi']) {
    const win = new BrowserWindow({ width: 440, height: 740, show: false, frame: false, transparent: true, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(root, 'preloads', 'deskpet.js'), contextIsolation: true, sandbox: true } });
    const pet = { win, agentId: 'nova-test', scale: 1, outfit: null, aspect: null, drag: null, ready: false, readyWaiters: [], pendingToggle: null };
    handlers._pets().set(pet.agentId, pet);
    win.webContents.on('console-message', (event) => logs.push({ preset, level: event.level, message: event.message }));
    win.webContents.on('render-process-gone', (_event, details) => result.errors.push({ preset, rendererGone: details }));
    capturedMenu = null;
    fs.writeFileSync(path.join(resultDir, 'stage.txt'), `context menu ${preset}`);
    ipcMain.emit('deskpet:context-menu', { sender: win.webContents });
    for (let attempt = 0; attempt < 100 && !capturedMenu; attempt++) await delay(50);
    const choices = capturedMenu?.find(item => item.label === '换装')?.submenu;
    if (!choices || choices.length !== 3) throw new Error(`Missing outfit menu for ${preset}`);
    await choices[['tech', 'maid', 'chibi'].indexOf(preset)].click();
    fs.writeFileSync(path.join(resultDir, 'stage.txt'), `chosen ${preset}`);
    const assets = await registered.get('deskpet:get-assets')({ sender: win.webContents });
    const savedChoice = JSON.parse(fs.readFileSync(path.join(data, 'deskpet', 'state.json'), 'utf8'))['nova-test']?.outfit;
    result.assertions.push({ preset, name: 'actual outfit menu writes the chosen outfit', passed: savedChoice === `builtin:nova-${preset}` && pet.outfit === savedChoice });
    result.assertions.push({ preset, name: 'three selectable Live2D presets', passed: assets.outfits.filter(o => o.id.startsWith('builtin:')).length === 3 && assets.outfit.id === pet.outfit && assets.live2d.modelUrl.startsWith('vcp-deskpet://pet/builtin/nova/') });
    await win.loadURL('vcp-deskpet://pet/app/deskpet.html');
    for (let attempts = 0; attempts < 160; attempts++) {
      if (await win.webContents.executeJavaScript('Boolean(window.__deskPetReady)')) break;
      await delay(200);
    }
    const ready = await win.webContents.executeJavaScript('({ ready: window.__deskPetReady, figure: window.__deskPetFigure, bounds: window.__deskPetBounds?.(), notice: document.getElementById("notice")?.textContent })');
    result.cases.push({ preset, assets: { outfit: assets.outfit, model: assets.live2d?.modelUrl }, ...ready });
    if (ready.ready?.backend !== 'live2d') throw new Error(`${preset} did not load Live2D: ${JSON.stringify(ready)}`);
    await delay(1000);

    await win.webContents.executeJavaScript(`__qaRig.internal.on('beforeModelUpdate', () => { const {coreModel: core, internal} = __qaRig; for (const [id,v] of Object.entries(window.__qaPose || {})) core.setParameterValueById(internal.getIdSafe(id), v); const p=core._model.parameters; window.__qaFrameParameters=Object.fromEntries(Array.from(p.ids).map((id,i)=>[id,p.values[i]])); }); document.getElementById('dndBadge').style.display='none';`);
    const expressionMap=JSON.parse(fs.readFileSync(path.join(root,'assets/deskpet/nova',preset,'deskpet.json'),'utf8')).expressions;
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/deskpet/nova',preset,`Nova${preset[0].toUpperCase()+preset.slice(1)}.model3.json`),'utf8'));
    const snapshots=[];
    for (const [emotion,expression] of Object.entries(expressionMap)) {
      const exprFile=manifest.FileReferences.Expressions.find(e=>e.Name===expression).File;
      const expressionData=JSON.parse(fs.readFileSync(path.join(root,'assets/deskpet/nova',preset,exprFile),'utf8'));
      for (const pose of ['normal','blink-talk','turn']) {
        const forced={ParamAngleX:pose==='turn'?30:0,ParamAngleY:pose==='turn'?20:0,ParamAngleZ:0,ParamBodyLean:0,ParamBodyAngleX:0,ParamBodyAngleY:0,ParamBodyAngleZ:0,ParamEyeBallX:0,ParamEyeBallY:0,ParamMouthOpenY:pose==='blink-talk'?1:0};
        if(pose==='blink-talk') Object.assign(forced,{ParamEyeLOpen:0,ParamEyeROpen:0});
        await win.webContents.executeJavaScript(`window.__qaPose=${JSON.stringify(forced)}; __qaBackend.apply({emotion:${JSON.stringify(emotion)},intensity:1},{changed:true,motion:false}); __qaRig.app.ticker.start();`);
        await delay(pose==='normal'?1000:350);
        const measured=await win.webContents.executeJavaScript(`(() => { const {coreModel:core,app,internal}=__qaRig;app.ticker.stop();internal.motionManager.stopAllMotions();app.renderer.render(app.stage);const p=core._model.parameters,d=core._model.drawables;return {ids:Array.from(p.ids),parameters:window.__qaFrameParameters,opacity:Object.fromEntries(Array.from(d.ids).map((id,i)=>[id,d.opacities[i]])),geometry:Object.fromEntries(Array.from(d.ids).map((id,i)=>[id,Array.from(d.vertexPositions[i])]))}; })()`);
        snapshots.push({emotion,expression,pose,...measured});
        result.assertions.push({preset,emotion,pose,name:'expression only targets actual model parameters',passed:expressionData.Parameters.every(p=>measured.ids.includes(p.Id))});
        if(preset!=='chibi') {
          result.assertions.push({preset,emotion,pose,name:'five authored expression parameters exist',passed:['ParamEyeLSmile','ParamEyeRSmile','ParamBrowLAngle','ParamBrowRAngle','ParamCheek'].every(id=>measured.ids.includes(id))});
          if(pose==='blink-talk') result.assertions.push({preset,emotion,pose,name:'blink hides both irises and eyewhites while talking',passed:['ArtMeshIridesL','ArtMeshIridesR','ArtMeshEyewhiteL','ArtMeshEyewhiteR'].every(id=>measured.opacity[id]<.001)});
        }
        result.assertions.push({preset,emotion,pose,name:'all rendered geometry remains finite',passed:Object.values(measured.geometry).every(v=>v.every(Number.isFinite))});
        if(pose==='normal') {
          await win.webContents.executeJavaScript(`__qaRig.app.stage.scale.set(4);__qaRig.app.stage.position.set(-550,-530);__qaRig.app.renderer.render(__qaRig.app.stage);`);
          await delay(100);
          fs.writeFileSync(path.join(resultDir,`${preset}-${emotion}.png`),(await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`__qaRig.app.stage.scale.set(1);__qaRig.app.stage.position.set(0,0);__qaRig.app.renderer.render(__qaRig.app.stage);`);
        }
      }
    }
    if(preset!=='chibi') {
      await win.webContents.executeJavaScript(`window.__qaPose={ParamAngleX:0,ParamAngleY:0,ParamMouthOpenY:0};__qaBackend.apply({emotion:'neutral',intensity:1},{changed:true,motion:false});__qaRig.app.ticker.start();`);
      await delay(1100);
      const values=await win.webContents.executeJavaScript(`(() => {return window.__qaFrameParameters;})()`);
      result.assertions.push({preset,name:'neutral clears smile brow-angle and blush after all expressions',values,passed:['ParamEyeLSmile','ParamEyeRSmile','ParamBrowLAngle','ParamBrowRAngle','ParamCheek'].every(id=>Math.abs(values[id])<.001)});
    }
    fs.writeFileSync(path.join(resultDir,`${preset}-snapshots.json`),JSON.stringify(snapshots));
    handlers._pets().delete(pet.agentId);
    win.destroy();
  }
  fs.writeFileSync(path.join(resultDir, 'logs.json'), JSON.stringify(logs, null, 2));
  fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify(result, null, 2));
  handlers.closeAll(); clearTimeout(timer);
  app.exit(result.assertions.every(a => a.passed) && !result.errors.length ? 0 : 1);
}).catch(error => { result.errors.push(error.stack); fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(resultDir, 'logs.json'), JSON.stringify(logs, null, 2)); clearTimeout(timer); app.exit(1); });






