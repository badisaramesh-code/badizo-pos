// Source-only release package. Never copies a developer's working directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const roots = ['backend','frontend/src','frontend/public','frontend/scripts','frontend/package.json','frontend/package-lock.json','package.json'];
function forbidden(name) {
  return /(^|\/)(\.env[^/]*|node_modules|backups?|logs|credentials?|secrets?)(\/|$)/i.test(name)
    || /\.(pem|key|pfx|p12|sql|gz|log|sqlite|db)$/i.test(name);
}
function packageRelease(repository, commit, output) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Supply a full immutable Git commit.');
  const git = args => execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true});
  if (git(['rev-parse',commit+'^{commit}']).trim() !== commit) throw Error('Release commit mismatch.');
  const files=git(['ls-tree','-r','--name-only',commit,'--',...roots]).trim().split('\n');
  if (files.some(forbidden)) throw Error('Release contains a forbidden configuration or data file.');
  if (!files.includes('backend/server.js') || !files.includes('frontend/package-lock.json')) throw Error('Incomplete release source.');
  const destination=path.resolve(output);
  // Exclusive directory creation prevents overwriting a previous release.
  fs.mkdirSync(destination);
  const archive=path.join(destination,'source.tar');
  git(['archive','--format=tar','--output='+archive,commit,'--',...roots]);
  const manifest={schemaVersion:1,commit,dirty:false,artifactType:'source-only',
    sha256:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    requiresBuildAndValidation:true};
  fs.writeFileSync(path.join(destination,'release.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  return manifest;
}
module.exports={forbidden,packageRelease};
if(require.main===module) {
  try { console.log(JSON.stringify(packageRelease(process.cwd(),process.argv[2],process.argv[3]),null,2)); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}
