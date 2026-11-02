const path = require('path');
const root = path.resolve(__dirname,'../..');
const build = require(path.join(root,'electron/package.json')).build;
module.exports = {
 ...build,
 directories:{output:path.join(root,'output/new-store-20260920/electron-dist')},
 files:['main.js','preload.js','assets/**/*',{from:path.join(root,'output/new-store-20260920/app-config.json'),to:'app-config.json'}],
 extraResources:[
 {from:path.join(root,'electron/assets/badizo.ico'),to:'assets/badizo.ico'},
 {from:path.join(root,'output/new-store-20260920/app-config.json'),to:'app-config.json'},
 {from:path.join(root,'output/new-store-20260920/package/payload/app/backend'),to:'backend',filter:['**/*','!node_modules/**']},
 {from:path.join(root,'output/new-store-20260920/frontend-build'),to:'frontend'}
 ],
 nsis:{...build.nsis,runAfterFinish:false}
};
