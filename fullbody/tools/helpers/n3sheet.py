import sys
from PIL import Image
d=sys.argv[1]
fs=['rest','angZ_m10','angZ_p10','angZ_m30','Cheer_1000','Heart_1000','Akimbo_1000','Wave_1000']
ims=[]
for f in fs:
    im=Image.open(f'{d}/{f}.png').convert('RGBA'); bg=Image.new('RGBA',im.size,(90,160,90,255)); bg.alpha_composite(im)
    ims.append(bg.convert('RGB'))
w,h=ims[0].size
out=Image.new('RGB',(w*4,h*2))
for i,im in enumerate(ims): out.paste(im,((i%4)*w,(i//4)*h))
out.resize((w*2,h)).save(f'{d}/__n3.png'); print(w,h)
