import numpy as np
from PIL import Image
for p in ('acc3/p00_base.png','acc5/p00_base.png','acc5/e_Neutral.png'):
    a=np.array(Image.open(p).convert('RGB')).astype(int); h,w,_=a.shape
    r=a[int(h*.6):int(h*.66), int(w*.4):int(w*.6)]
    dark=(r.sum(-1)<200)
    cols=dark.sum(0); cols=cols[cols>0]
    print(p, a.shape, 'stroke px per column median', np.median(cols), 'p25', np.percentile(cols,25))
