"""Restore only to an empty, separately provisioned recovery database.
No live database credentials, POS imports, or activation operations are used.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

TRIGGER_BODY = '''BEGIN
      IF NOT (NEW.updated_at <=> OLD.updated_at) THEN
        SET NEW.previous_updated_at = COALESCE(OLD.updated_at, OLD.created_at);
      END IF;
    END'''
TRIGGER_HEADER = '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `products_previous_update_timestamp` BEFORE UPDATE ON `products` FOR EACH ROW '

def reviewed_sql_lines(source, state):
    for line in source:
        if line.startswith(TRIGGER_HEADER.encode()):
            block = line
            for extra in source:
                block += extra
                if extra.strip().endswith(b'END */;;'):
                    break
                if len(block) > 4096:
                    raise ValueError('Unexpected trigger definition.')
            expected = TRIGGER_HEADER + TRIGGER_BODY + ' */;;'
            if ' '.join(block.decode().split()) != ' '.join(expected.split()) or state.get('trigger'):
                raise ValueError('Trigger differs from the reviewed product timestamp behavior.')
            state['trigger'] = True
            continue
        if b'DEFINER=' in line or re.match(rb'^(?:/\*!\d+ )?CREATE\s+(?:TRIGGER|PROCEDURE|FUNCTION|EVENT|VIEW)\b', line, re.I):
            raise ValueError('Unreviewed stored object. No automatic ownership migration allowed.')
        yield line

def reviewed_trigger_sql(database):
    if not re.fullmatch(r'badizo_recovery_[a-z0-9]{8,32}', database):
        raise ValueError('Invalid trigger target.')
    return 'USE `' + database + '`;\nDELIMITER ;;\nCREATE TRIGGER `products_previous_update_timestamp` BEFORE UPDATE ON `products` FOR EACH ROW ' + TRIGGER_BODY + ';;\nDELIMITER ;\n'

def configured_trigger_installer(config):
    # Provisioned by the installer, never accepted as an HTTP request field.
    command_config = config.get('triggerInstallerCommand')
    if command_config:
        executable = command_config.get('file')
        arguments = command_config.get('args')
        if not isinstance(executable, str) or not pathlib.Path(executable).is_absolute() or not isinstance(arguments, list) or any(not isinstance(arg, str) for arg in arguments):
            raise ValueError('Invalid fixed trigger installer command.')
        def install_command(database):
            if not re.fullmatch(r'badizo_recovery_[a-z0-9]{8,32}', database):
                raise ValueError('Invalid trigger target.')
            result = subprocess.run([executable, *arguments, database], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            if result.returncode:
                raise RuntimeError('Reviewed trigger installation failed; recovery remains inactive.')
        return install_command
    configured = config.get('triggerInstallerDefaultsFile')
    if not configured:
        return None
    defaults = pathlib.Path(configured)
    if not defaults.is_absolute() or defaults.is_symlink() or not defaults.is_file():
        raise ValueError('Private trigger-installer credentials are unavailable.')
    if os.name != 'nt' and defaults.stat().st_mode & 0o077:
        raise ValueError('Trigger-installer credentials must be owner-only.')
    def install(database):
        sql = reviewed_trigger_sql(database)
        port = config.get('port', 3306)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('Invalid recovery database port.')
        command = [config.get('mysqlPath', 'mysql'), '--defaults-file=' + str(defaults), '--protocol=TCP', '--host=localhost', '--port=' + str(port), '--local-infile=0', '--binary-mode']
        result = subprocess.run(command, input=sql.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('Reviewed trigger installation failed; recovery remains inactive.')
    return install


def verify_grants(lines, database):
    scoped = False
    for line in lines:
        if re.fullmatch(r'GRANT USAGE ON \*\.\* TO .+', line) and 'WITH GRANT OPTION' not in line:
            continue
        match = re.fullmatch(r'GRANT ([A-Z_, ]+) ON `([^`]+)`\.\* TO .+', line)
        if not match or match[2] != database.replace('_', '\\_') or 'WITH GRANT OPTION' in line:
            raise ValueError('Recovery user must have privileges only on its recovery database, without roles or grant option.')
        scoped = True
    if not scoped:
        raise ValueError('Missing scoped recovery privileges.')


def restore(config, install_reviewed_trigger=None):
    database = config['database']
    if not re.fullmatch(r'badizo_recovery_[a-z0-9]{8,32}', database):
        raise ValueError('Only a distinctly named recovery database is allowed.')
    if config['host'] not in ('127.0.0.1', 'localhost'):
        raise ValueError('Run recovery on the target machine using loopback.')
    port = config.get('port', 3306)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Invalid recovery database port.')
    artifact = pathlib.Path(config['artifactDirectory']).resolve(strict=True)
    manifest = json.loads((artifact / 'manifest.json').read_text())
    if manifest['shopId'] != config['shopId'] or manifest['integrityVerified'] is not True:
        raise ValueError('Backup identity or verification mismatch.')
    sql_file = artifact / 'database.sql'
    digest = hashlib.sha256()
    size = 0
    with sql_file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
            size += len(chunk)
    if digest.hexdigest() != manifest['sqlSha256'] or size != manifest['sqlBytes']:
        raise ValueError('Prepared SQL has changed.')
    # Stored objects need a separately reviewed ownership/privilege migration.
    # Reject before import rather than silently stripping behavior or granting
    # the recovery account global privileges.
    objects = {}
    with sql_file.open('rb') as source:
        for line in reviewed_sql_lines(source, objects):
            pass
    if objects.get('trigger') and install_reviewed_trigger is None:
        raise ValueError('Reviewed product trigger requires a trusted installation adapter. No SQL imported.')
    report = artifact / 'restore-result.json'
    if report.exists():
        raise ValueError('This recovery artifact already has a restore result.')
    with tempfile.TemporaryDirectory(prefix='badizo-recovery-') as private:
        if os.name == 'nt':
            identity = subprocess.check_output(['whoami'], text=True).strip()
            subprocess.run(['icacls', private, '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.chmod(private, 0o700)
        defaults = pathlib.Path(private) / 'client.cnf'
        def option(value):
            value = str(value)
            if '\n' in value or '\r' in value or '\x00' in value:
                raise ValueError('Invalid credential option.')
            return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
        with defaults.open('x') as handle:
            handle.write('[client]\n' + '\n'.join(key + '=' + option(config[key]) for key in ('host', 'user', 'password')) + '\n')
        os.chmod(defaults, 0o600)
        command = [config.get('mysqlPath', 'mysql'), '--defaults-file=' + str(defaults), '--protocol=TCP', '--port=' + str(port), '--database=' + database, '--batch', '--raw', '--skip-column-names', '--binary-mode', '--local-infile=0', '--skip-reconnect']
        def query(sql):
            result = subprocess.run(command, input=sql.encode(), capture_output=True)
            if result.returncode:
                raise RuntimeError('Recovery database operation failed; no credentials or SQL contents logged.')
            return result.stdout.decode().strip()
        verify_grants(query('SHOW GRANTS;').splitlines(), database)
        if not query('SELECT VERSION();').startswith('8.0.'):
            raise ValueError('This restore profile requires MySQL 8.0.')
        if query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE();') != '0':
            raise ValueError('Recovery database must be empty; nothing was overwritten.')
        # mysqldump --databases includes a CREATE DATABASE / USE header.
        # Rewrite only its exact, declared source database directives. Scoped
        # privileges remain the enforcement boundary for all other statements.
        original = config.get('sourceDatabase', 'badizo_pos')
        if not re.fullmatch(r'[A-Za-z0-9_]+', original):
            raise ValueError('Invalid source database name.')
        redirected = pathlib.Path(private) / 'staged.sql'
        with sql_file.open('rb') as source, redirected.open('xb') as target:
            for line in reviewed_sql_lines(source, {}):
                if line.startswith(b'CREATE DATABASE '):
                    if not re.match(rb'^CREATE DATABASE /\*!32312 IF NOT EXISTS\*/ `' + original.encode() + rb'` ', line):
                        raise ValueError('Unexpected database creation directive.')
                    continue
                if line.startswith(b'USE '):
                    if line.strip() != ('USE `' + original + '`;').encode():
                        raise ValueError('Unexpected database selection directive.')
                    line = ('USE `' + database + '`;\n').encode()
                target.write(line)
        with redirected.open('rb') as source:
            result = subprocess.run(command, stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('Restore failed. Partial recovery database retained for inspection; live billing untouched.')
        if objects.get('trigger'):
            # The adapter receives only the validated target, never dump SQL.
            install_reviewed_trigger(database)
            definition = query("SELECT HEX(ACTION_STATEMENT) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name='products_previous_update_timestamp' AND event_manipulation='UPDATE' AND action_timing='BEFORE' AND event_object_table='products';")
            if ' '.join(bytes.fromhex(definition).decode().split()) != ' '.join(TRIGGER_BODY.split()):
                raise ValueError('Restored trigger verification failed.')
        tables = query('SHOW TABLES;').splitlines()
        required = {'products', 'invoices', 'invoice_items', 'invoice_payments', 'users'}
        if not required.issubset(tables):
            raise ValueError('Restored database is missing required POS tables.')
        for table in tables:
            if not re.fullmatch(r'[A-Za-z0-9_]+', table):
                raise ValueError('Unexpected table name.')
            checks = query('CHECK TABLE `' + table + '` QUICK;').splitlines()
            if not checks or any(not line.endswith('\tstatus\tOK') for line in checks):
                raise ValueError('Restored table failed integrity check.')
        result = dict(shopId=config['shopId'], database=database, tableCount=len(tables),
                      products=int(query('SELECT COUNT(*) FROM products;')),
                      invoices=int(query('SELECT COUNT(*) FROM invoices;')),
                      sqlSha256=manifest['sqlSha256'], stagedRestoreVerified=True,
                      reviewedProductTriggerInstalled=bool(objects.get('trigger')),
                      businessReconciliationVerified=False, activated=False)
        with report.open('x') as handle:
            json.dump(result, handle, indent=2)
        return result


if __name__ == '__main__':
    try:
        with open(sys.argv[1]) as handle:
            config = json.load(handle)
        print(json.dumps(restore(config, install_reviewed_trigger=configured_trigger_installer(config))))
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('Staged restore did not complete. Check the private configuration, backup and empty recovery database. No billing switch was performed.', file=sys.stderr)
        sys.exit(1)
