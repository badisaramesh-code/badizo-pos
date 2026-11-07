"""Install the requested public POS release on a standalone Linux standby."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import zipfile

BASE = Path('/opt/badizo')
STATE = Path('/var/lib/badizo-cloud-update')
REQUEST = STATE / 'inbox/request'
RELEASE_ENV = Path('/etc/badizo/release.env')
SERVICE = 'badizo-pos.service'
TAG_API = 'https://api.github.com/repos/badisaramesh-code/badizo-pos/releases/tags/pos-'


def atomic(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(value)
    os.replace(tmp, path)


def report(commit, phase, message):
    atomic(STATE / 'state.json', json.dumps(dict(commit=commit, phase=phase, message=message)))


def read_json(url):
    with urllib.request.urlopen(url, timeout=12) as response:
        return json.load(response)


def ready():
    return read_json('http://127.0.0.1:5000/api/ready')


def service_env():
    pid = subprocess.check_output(['systemctl','show','-p','MainPID','--value',SERVICE], text=True).strip()
    return dict(item.split(b'=',1) for item in Path('/proc',pid,'environ').read_bytes().split(b'\0') if b'=' in item)


def check_standby():
    env = service_env()
    status = ready()
    if (env.get(b'BADIZO_NODE_ROLE') != b'cloud-standby' or env.get(b'BADIZO_DB_BOOTSTRAP') == b'true'
            or any(env.get(key) for key in [b'BADIZO_RUNTIME_BINDING', b'BADIZO_SYNC_ENROLLMENT_CONFIG', b'BADIZO_RECOVERY_CONTROL_CONFIG'])
            or not status.get('ok') or status.get('nodeRole') != 'cloud-standby'
            or status.get('releaseCommit') != (BASE/'current').resolve().name
            or not status.get('shopId') or status['shopId'].encode() != env.get(b'BADIZO_SHOP_ID')):
        raise ValueError('Cloud is busy or its standby identity could not be verified.')
    return status


def download(commit, stage):
    metadata = read_json(TAG_API + commit)
    if metadata['tag_name'] != 'pos-'+commit or metadata['draft'] or metadata['prerelease']:
        raise ValueError('Unpublished release.')
    asset = next(a for a in metadata['assets'] if a['name']=='badizo-pos-cloud.zip')
    expected = 'https://github.com/badisaramesh-code/badizo-pos/releases/download/pos-'+commit+'/badizo-pos-cloud.zip'
    if asset['browser_download_url'] != expected or not 0 < asset['size'] <= 256*1024**2:
        raise ValueError('Invalid release archive.')
    archive = stage/'package.zip'
    digest = hashlib.sha256()
    with urllib.request.urlopen(expected,timeout=45) as src, archive.open('xb') as dst:
        while chunk := src.read(1024**2):
            dst.write(chunk)
            digest.update(chunk)
            if dst.tell() > asset['size']:
                raise ValueError('Archive exceeds published size.')
    if archive.stat().st_size != asset['size'] or asset['digest'] != 'sha256:'+digest.hexdigest():
        raise ValueError('Cloud release checksum mismatch.')
    with zipfile.ZipFile(archive) as bundle:
        if sum(f.file_size for f in bundle.infolist()) > 1024**3:
            raise ValueError('Cloud release exceeds space limit.')
        for f in bundle.infolist():
            parts = f.filename.rstrip('/').split('/')
            if (any(p in ('','.','..') or '\\' in p for p in parts) or
                    parts[0] not in ('backend','frontend','cloud-release')):
                raise ValueError('Unexpected archive entry.')
            bundle.extract(f,stage)
    archive.unlink()
    if (stage/'cloud-release').read_text().strip() != commit:
        raise ValueError('Cloud release identity mismatch.')
    for name in ['frontend/build/index.html','backend/server.js','backend/node_modules/mysql2/package.json','backend/routes/cloudSoftware.js']:
        if not (stage/name).is_file():
            raise ValueError('Cloud release is incomplete.')
    (stage/'backend/logs').symlink_to('/var/log/badizo')
    stage.chmod(0o755)


def activate(directory):
    link = BASE/'current.updating'
    link.unlink(missing_ok=True)
    link.symlink_to(directory)
    os.replace(link, BASE/'current')
    atomic(RELEASE_ENV, 'BADIZO_RELEASE_COMMIT='+directory.name+'\n')
    subprocess.run(['systemctl','restart',SERVICE],check=True,timeout=75)


def verify(commit, shop):
    for _ in range(30):
        try:
            info = ready()
            if info.get('ok') and info.get('shopId')==shop and info.get('nodeRole')=='cloud-standby' and info.get('releaseCommit')==commit:
                return
        except (OSError,ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Cloud POS readiness check failed.')


def run():
    # The POS user controls only this inbox. Never follow a link supplied there.
    fd = os.open(REQUEST,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        import stat
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Invalid request file.')
        commit = stream.read(41)
    if not re.fullmatch('[a-f0-9]{40}',commit):
        raise ValueError('Invalid release identity.')
    journal = STATE/'switch.json'
    if journal.exists():
        report(commit,'inspect','Interrupted cloud update. Inspect the service before retrying.')
        return
    report(commit,'checking','Checking cloud standby.')
    before = check_standby()
    previous = (BASE/'current').resolve()
    releases = BASE/'releases'
    if previous.parent != releases or not re.fullmatch('[a-f0-9]{40}',previous.name):
        raise ValueError('Invalid previous release.')
    if previous.name == commit:
        report(commit,'ready','Cloud POS is ready.')
        return
    report(commit,'preparing','Downloading and verifying the cloud release.')
    dest = releases/commit
    if dest.exists():
        if not (dest/'cloud-release').is_file() or (dest/'cloud-release').read_text().strip()!=commit:
            raise ValueError('Existing release needs inspection.')
    else:
        stage = Path(tempfile.mkdtemp(dir=releases,prefix='.cloud-stage-'))
        try:
            download(commit,stage)
            stage.rename(dest)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    if check_standby()!=before or (BASE/'current').resolve()!=previous:
        raise ValueError('Standby changed during download.')
    atomic(journal,json.dumps(dict(previous=previous.name,target=commit,shop=before['shopId'])))
    try:
        report(commit,'restarting','Restarting and checking cloud POS.')
        activate(dest)
        verify(commit,before['shopId'])
    except Exception:
        activate(previous)
        verify(previous.name,before['shopId'])
        report(commit,'rolled-back','Update failed. The previous cloud version is running.')
    else:
        report(commit,'ready','Cloud POS is ready.')
    journal.unlink()


if __name__=='__main__':
    try:
        run()
    except Exception as error:
        state = json.loads((STATE/'state.json').read_text())
        report(state.get('commit'), 'inspect' if (STATE/'switch.json').exists() else 'failed', 'Cloud update needs attention. Check the updater service log.')
        print(type(error).__name__,str(error),flush=True)
        raise
    finally:
        REQUEST.unlink(missing_ok=True)
