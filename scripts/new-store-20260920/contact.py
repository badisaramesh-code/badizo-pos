from PIL import Image,ImageDraw
from pathlib import Path
r=Path(r'D:\badizo-pos-main\output\new-store-20260920')
files=sorted(r.glob('guide-final-*.jpg'))
thumbs=[]
for p in files:
 im=Image.open(p).convert('RGB');im.thumbnail((350,500));thumbs.append((p,im))
for group in range(0,len(thumbs),6):
 subset=thumbs[group:group+6];sheet=Image.new('RGB',(1050,550*((len(subset)+2)//3)),'#dddddd');d=ImageDraw.Draw(sheet)
 for j,(p,im) in enumerate(subset):x=(j%3)*350;y=(j//3)*550;sheet.paste(im,(x,y+25));d.text((x+10,y+7),p.stem,fill='black')
 sheet.save(r/('contact-'+str(group//6)+'.jpg'),quality=65)
