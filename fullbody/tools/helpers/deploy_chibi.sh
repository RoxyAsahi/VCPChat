set -e
cd C:/Users/CHENXI/Documents/Codex/nova-live2d/fullbody
PY=C:/Users/CHENXI/Documents/Codex/nova-live2d/venv/Scripts/python.exe
W=../../2026-10-09/nova-builtin-v2/assets/deskpet/nova/chibi
timeout 300 $PY -I tools/finalize_chibi_v2.py work-v2/chibi/export $W | tail -1
$PY -I tools/fix_chibi_backhair.py $W/NovaChibi.2048/texture_00.png
cp -r $W/. C:/Users/CHENXI/Documents/Codex/deskpet-demo/assets/deskpet/nova/chibi/
cd C:/Users/CHENXI/AppData/Local/Temp/claude/C--Users-CHENXI-Documents-Codex/ca8e633e-9059-40e6-bd60-9430ed554d7a/scratchpad/cdp
node cdp.mjs 9377 "桌宠设置" -e "deskPetSettingsAPI.setOutfit('_Agent_1760530265093_1760530265093','builtin:nova-tech').then(()=>new Promise(r=>setTimeout(r,2500))).then(()=>deskPetSettingsAPI.setOutfit('_Agent_1760530265093_1760530265093','builtin:nova-chibi')).then(()=>new Promise(r=>setTimeout(r,4000))).then(()=>'ok')"
