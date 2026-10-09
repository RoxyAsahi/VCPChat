(async () => { const cm = __m.internalModel.coreModel; const D = cm.getModel().drawables;
 if (!cm.__upd) { cm.__upd = cm.update.bind(cm); cm.update = () => { cm.__upd(); for (const id of (window.__hide||[])) { const i = D.ids.indexOf(id); if (i>=0) D.opacities[i]=0; } }; }
 window.__hide = HIDE; __setPose({ParamAngleZ:-30,ParamEyeLOpen:1,ParamEyeROpen:1}); await new Promise(r=>setTimeout(r,1200)); return 1; })()
