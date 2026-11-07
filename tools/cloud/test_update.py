import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import update


class CloudUpdateTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name)
        self.old = 'a' * 40
        self.new = 'b' * 40
        self.ready = dict(ok=True, shopId='LAB001', nodeRole='cloud-standby', releaseCommit=self.old)
        self.releases = self.base/'releases'
        self.previous = self.releases/self.old
        self.previous.mkdir(parents=True)
        (self.base/'current').symlink_to(self.previous, target_is_directory=True)
        self.request = self.base/'request'
        self.request.write_text(self.new)
        self.addCleanup(patch.stopall)
        patch.multiple(update, BASE=self.base, STATE=self.base, REQUEST=self.request).start()
        patch.object(update, 'service_env', return_value={b'BADIZO_NODE_ROLE':b'cloud-standby', b'BADIZO_SHOP_ID':b'LAB001'}).start()
        patch.object(update, 'ready', return_value=self.ready).start()

    def test_active_cloud_does_not_stage_or_restart(self):
        self.ready['nodeRole'] = 'cloud-active'
        with patch.object(update,'activate') as activate, patch.object(update,'download') as download:
            with self.assertRaises(ValueError):
                update.run()
            activate.assert_not_called()
            download.assert_not_called()

    def test_failed_readiness_restores_previous_release(self):
        with patch.object(update,'download'), patch.object(update,'activate') as activate, patch.object(update,'verify',side_effect=[RuntimeError(),None]):
            update.run()
        self.assertEqual([call.args[0] for call in activate.call_args_list], [self.releases/self.new,self.previous])
        self.assertEqual(json.loads((self.base/'state.json').read_text())['phase'],'rolled-back')

    def test_download_rejects_corrupt_or_unsafe_package(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data,'w') as archive:
            archive.writestr('../outside','unsafe')
        raw = data.getvalue()
        asset = dict(name='badizo-pos-cloud.zip',size=len(raw),digest='sha256:'+'0'*64,
                     browser_download_url='https://github.com/badisaramesh-code/badizo-pos/releases/download/pos-'+self.new+'/badizo-pos-cloud.zip')
        release = dict(tag_name='pos-'+self.new, draft=False, prerelease=False, assets=[asset])
        for name, digest, message in [('bad-hash',asset['digest'],'checksum'),('bad-path','sha256:'+update.hashlib.sha256(raw).hexdigest(),'entry')]:
            stage=self.base/name
            stage.mkdir()
            asset['digest']=digest
            with patch.object(update,'read_json',return_value=release), patch.object(update.urllib.request,'urlopen',return_value=io.BytesIO(raw)):
                with self.assertRaisesRegex(ValueError,message):
                    update.download(self.new,stage)
        self.assertFalse((self.base/'outside').exists())
