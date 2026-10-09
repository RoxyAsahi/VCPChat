(() => { const D = __m.internalModel.coreModel.getModel().drawables; const out = [];
for (let i = 0; i < D.ids.length; i++) { const id = D.ids[i]; if (!/Eye|FaceDetail/.test(id)) continue;
  const uv = D.vertexUvs[i]; let a=1,b=1,c=0,d=0; for (let k=0;k<uv.length;k+=2){a=Math.min(a,uv[k]);c=Math.max(c,uv[k]);b=Math.min(b,uv[k+1]);d=Math.max(d,uv[k+1]);}
  out.push([id, D.renderOrders[i], [a,1-d,c,1-b].map(v=>Math.round(v*2048))]); }
return JSON.stringify(out); })()
