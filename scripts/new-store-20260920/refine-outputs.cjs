const fs=require('fs');
let p='scripts/new-store-20260920/create-guide.py',s=fs.readFileSync(p,'utf8');s=s.replace(' if story:story.append(PageBreak())',' if story:\n  while story and isinstance(story[-1],Spacer):story.pop()\n  story.append(PageBreak())');fs.writeFileSync(p,s);
p='scripts/new-store-20260920/electron-print-qa.cjs';s=fs.readFileSync(p,'utf8').replace("app.whenReady()","app.setPath('userData',path.join(out,'electron-profile'));app.on('window-all-closed',()=>{});\napp.whenReady()");fs.writeFileSync(p,s);
