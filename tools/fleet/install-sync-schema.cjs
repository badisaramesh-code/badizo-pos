// Explicit operator tool; never imported by the application startup path.
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('../../backend/node_modules/mysql2/promise');
const {installSyncSchema} = require('../../backend/services/syncSchemaInstaller');
async function main() {
  const [configFile, mode, expectedDatabase] = process.argv.slice(2);
  if (!configFile || !path.isAbsolute(configFile) || !['--plan','--apply'].includes(mode) || !/^[a-zA-Z0-9_]{1,64}$/.test(expectedDatabase || '')) throw Error('Usage: node install-sync-schema.cjs ABSOLUTE_PRIVATE_DB_CONFIG --plan|--apply EXPECTED_DATABASE');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  if (!['localhost','127.0.0.1','::1'].includes(config.host) || config.database !== expectedDatabase) throw Error('Run the installer on the intended database host using its private configuration.');
  const connection = await mysql.createConnection({host:config.host,user:config.user,password:config.password,database:config.database,multipleStatements:false});
  try { console.log(JSON.stringify(await installSyncSchema({connection,directory:path.resolve(__dirname,'../../database/migrations'),expectedDatabase,apply:mode==='--apply'}),null,2)); }
  finally { await connection.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
