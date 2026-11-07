import importlib.util
import pathlib
import unittest
import io

spec = importlib.util.spec_from_file_location('restore_staged', pathlib.Path(__file__).with_name('restore-staged.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreBoundaryTests(unittest.TestCase):
    def test_only_exact_reviewed_trigger_is_separated_for_installation(self):
        block=(module.TRIGGER_HEADER+module.TRIGGER_BODY+' */;;\n').encode()
        state={}
        self.assertEqual(list(module.reviewed_sql_lines(io.BytesIO(block),state)),[])
        self.assertTrue(state['trigger'])
        for invalid in [block.replace(b'COALESCE',b'UNREVIEWED'),block+block,b'CREATE TRIGGER arbitrary BEFORE UPDATE ON products;\n']:
            with self.assertRaises(ValueError):
                list(module.reviewed_sql_lines(io.BytesIO(invalid),{}))
        with self.assertRaises(ValueError):
            module.reviewed_trigger_sql('badizo_pos')

    def test_only_exact_database_scope_is_accepted(self):
        database = 'badizo_recovery_20261102a'
        scoped = r'GRANT SELECT, INSERT ON `badizo\_recovery\_20261102a`.* TO `restore`@`127.0.0.1`'
        module.verify_grants(['GRANT USAGE ON *.* TO `restore`@`127.0.0.1`', scoped], database)
        for grant in ['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`',
                      'GRANT SELECT ON `badizo_pos`.* TO `restore`@`localhost`',
                      scoped.replace('\\_', '_'), scoped + ' WITH GRANT OPTION',
                      'GRANT `admin_role`@`%` TO `restore`@`localhost`']:
            with self.assertRaises(ValueError):
                module.verify_grants([grant], database)

    def test_live_database_names_are_rejected_before_any_connection(self):
        with self.assertRaises(ValueError):
            module.restore({'database': 'badizo_pos'})


if __name__ == '__main__':
    unittest.main()
