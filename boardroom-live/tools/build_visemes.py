"""Builds each advisor's mouth-shape atlas (app/visemes/<name>.jpg) from their talking video.
Tracks the face against the still frame, then picks real mouth frames: closed, 5 openness levels, rounded lips, teeth.
If you change a still frame or video, update the eye/mouth landmark pixels in SPEC (and PHOTOS in index.html)."""
import cv2, numpy as np, json, sys
# Run from the project root:  python3 tools/build_visemes.py
# Needs: pip install opencv-python-headless numpy
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A=os.path.join(ROOT,'assets','source-videos')+'/'
SPEC={'elena':('elena',(390,137),(460,137),(420,201)),
      'marcus':('marcus',(392,137),(457,137),(427,203)),
      'devon':('devon',(387,135),(452,135),(422,203))}
PX0,PX1,PY0,PY1=-64,64,-30,58   # patch box relative to mouth centre
import glob
meta={}
for k,(fid,eL,eR,M) in SPEC.items():
    f=A+fid+'.mp4'
    cap=cv2.VideoCapture(f); frames=[]
    while True:
        ok,fr=cap.read()
        if not ok: break
        frames.append(cv2.resize(fr,(854,480),interpolation=cv2.INTER_AREA))
    base=cv2.imread(os.path.join(ROOT,'app','video',f'{k}-still.jpg'))
    g0=cv2.cvtColor(base,cv2.COLOR_BGR2GRAY)
    tx0,tx1=eL[0]-28,eR[0]+28; ty0,ty1=eL[1]-18,M[1]-22
    tmpl=g0[ty0:ty1,tx0:tx1]
    mx,my=M
    recs=[]
    for i,fr in enumerate(frames):
        g=cv2.cvtColor(fr,cv2.COLOR_BGR2GRAY); best=None
        for sc in (0.94,0.97,1.0,1.03,1.06):
            t=cv2.resize(tmpl,None,fx=sc,fy=sc)
            sx0,sy0=max(0,tx0-60),max(0,ty0-50)
            win=g[sy0:min(480,ty1+50),sx0:min(854,tx1+60)]
            if win.shape[0]<t.shape[0] or win.shape[1]<t.shape[1]: continue
            r=cv2.matchTemplate(win,t,cv2.TM_CCOEFF_NORMED); _,v,_,loc=cv2.minMaxLoc(r)
            if best is None or v>best[0]: best=(v,sc,sx0+loc[0],sy0+loc[1])
        v,sc,X,Y=best
        # map base coords -> frame coords: p' = (p - (tx0,ty0))*sc + (X,Y)
        Mx=(mx-tx0)*sc+X; My=(my-ty0)*sc+Y
        # warp frame so that it aligns to base around mouth: inverse similarity
        Aff=np.float32([[1/sc,0,0],[0,1/sc,0]]); Aff[0,2]=tx0-X/sc; Aff[1,2]=ty0-Y/sc
        al=cv2.warpAffine(fr,Aff,(854,480),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE)
        patch=al[my+PY0:my+PY1, mx+PX0:mx+PX1]
        recs.append(dict(i=i,score=float(v),sc=sc,patch=patch))
    # features on mouth core
    def feats(p):
        hsv=cv2.cvtColor(p,cv2.COLOR_BGR2HSV); gray=cv2.cvtColor(p,cv2.COLOR_BGR2GRAY).astype(float)
        cy=-PY0; cx=-PX0
        core=gray[cy-12:cy+32, cx-34:cx+34]
        skin=np.median(gray[cy+38:cy+50, cx-50:cx+50]) if gray.shape[0]>cy+50 else np.median(gray)
        dark=core< skin*0.55
        rows=dark.any(1).sum(); cols=dark.any(0).sum()
        bright=(core> skin*1.12)&(hsv[cy-12:cy+32, cx-34:cx+34,1]<70)
        b,g_,r_=[p[:,:,i].astype(float) for i in range(3)]
        lip=(r_-g_)> (np.median((r_-g_)[cy+38:cy+50, cx-50:cx+50])+14)
        lipc=lip[cy-14:cy+30, cx-56:cx+56]; lw=float(lipc.any(0).sum())
        return dict(open=float(rows), width=float(cols), lipw=lw, area=float(dark.sum()), teeth=float(bright.sum()))
    good=[r for r in recs if r['score']>0.8]
    for r in good: r.update(feats(r['patch']))
    O=np.array([r['open'] for r in good]); W=np.array([r['width'] for r in good]); T=np.array([r['teeth'] for r in good])
    def pct(a,p): return np.percentile(a,p)
    o_lo,o_hi=pct(O,5),pct(O,97); w_lo,w_hi=pct(W,5),pct(W,95); t_hi=pct(T,95)+1e-6
    L=np.array([r['lipw'] for r in good]); l_lo,l_hi=pct(L,5),pct(L,95)
    def norm(r): return ((r['open']-o_lo)/(o_hi-o_lo+1e-6),(r['lipw']-l_lo)/(l_hi-l_lo+1e-6),r['teeth']/t_hi)
    # openness ladder: frames with a neutral (not smiling) lip width, from closed to wide open
    lw_med=np.median(L)
    neutral=[r for r in good if abs(r['lipw']-lw_med) <= (l_hi-l_lo)*0.35] or good
    neutral=sorted(neutral, key=lambda r:r['open'])
    ladder=[]
    for q in (0.22,0.42,0.62,0.8,0.96):
        r=neutral[min(len(neutral)-1,int(q*(len(neutral)-1)))]
        # among frames of similar openness take the best-tracked one
        cands=[x for x in neutral if abs(x['open']-r['open'])<=1.5]
        ladder.append(max(cands,key=lambda x:x['score']))
    opens=sorted(O)
    rnd=[r for r in good if r['open']>=np.percentile(O,55)]
    round_=max(rnd,key=lambda r:(r['open']/(r['lipw']+1))+r['score']*0.2)
    tee=[r for r in good if r['open']<=np.percentile(O,45)]
    teeth=max(tee,key=lambda r:r['teeth']/t_hi - (r['lipw']-l_lo)/(l_hi-l_lo+1e-6)*0.2)
    picks=ladder+[round_,teeth]
    names=['closed','o1','o2','o3','o4','o5','round','teeth']
    bp=base[my+PY0:my+PY1, mx+PX0:mx+PX1]
    atlas=np.concatenate([bp]+[r['patch'] for r in picks],axis=1)
    cv2.imwrite(os.path.join(ROOT,'app','visemes',f'{k}.jpg'),atlas,[cv2.IMWRITE_JPEG_QUALITY,92])
    chosen={n:r for n,r in zip(names[1:],picks)}
    targets=chosen
    meta[k]=dict(names=names,pw=PX1-PX0,ph=PY1-PY0,ox=mx+PX0,oy=my+PY0,frames=[0]+[r['i'] for r in picks],opens=[0]+[r['open'] for r in picks])
    print(k,meta[k]['frames'],meta[k]['opens'])
json.dump(meta,open(os.path.join(ROOT,'tools','visemes-meta.json'),'w'))
