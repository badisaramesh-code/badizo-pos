// Read-only inventory. Never import backend/config/db: it initializes schema.
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('../../backend/node_modules/mysql2/promise');
const dotenv = require('../../backend/node_modules/dotenv');
function assessReplication(variables, tables) {
  const blockers=[];
  if (!/^8\.0\./.test(variables.version || '')) blockers.push('Validate this MySQL version before selecting a replication adapter.');
  if (variables.log_bin !== 'ON') blockers.push('Binary logging is unavailable.');
  if (variables.binlog_format !== 'ROW') blockers.push('Row binary logging is required for the planned incremental path.');
  if (variables.gtid_mode !== 'ON') blockers.push('GTID is unavailable; consistent seed/checkpoint setup needs review.');
  if (!Number(variables.server_id)) blockers.push('A unique nonzero replication server ID is required.');
  if (tables.some(t => t.engine !== 'InnoDB')) blockers.push('Non-InnoDB tables require a separate consistent-backup strategy.');
  return { eligibleForFurtherValidation: blockers.length === 0, readyForSync: false, blockers };
}
async function inspect({envPath,shopId,output}) {
  if (!/^[A-Z][A-Z0-9_-]{2,31}$/.test(shopId || '')) throw Error('Supply the correct shop ID.');
  const env=dotenv.parse(fs.readFileSync(path.resolve(envPath)));
  if (!env.DB_NAME || !env.DB_USER) throw Error('Selected environment file must contain DB_NAME and DB_USER.');
  const connection=await mysql.createConnection({host:env.DB_HOST || '127.0.0.1',port:Number(env.DB_PORT || 3306),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,connectTimeout:10000});
  try {
    const [rows]=await connection.query("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','log_bin','binlog_format','binlog_row_image','gtid_mode','enforce_gtid_consistency','server_id','binlog_expire_logs_seconds','read_only','super_read_only')");
    const variables=Object.fromEntries(rows.map(r=>[r.Variable_name,r.Value]));
    const [tables]=await connection.execute('SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',[env.DB_NAME,'BASE TABLE']);
    const report={schemaVersion:1,shopId,observedAt:new Date().toISOString(),source:'explicitly-selected-database',variables,tables,assessment:assessReplication(variables,tables),changesApplied:false};
    fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    return {shopId,tableCount:tables.length,changesApplied:false,assessment:report.assessment};
  } finally { await connection.end(); }
}
module.exports={assessReplication,inspect};
if(require.main===module) {
  const [envPath,shopId,output]=process.argv.slice(2);
  if(!envPath || !shopId || !output) { console.error('Usage: node tools/fleet/inspect-shop.cjs ENV_FILE SHOP_ID NEW_REPORT_FILE');process.exitCode=1; }
  else inspect({envPath,shopId,output}).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('Inspection failed. Check the selected environment file, database access and new output path. No database settings were changed.');process.exitCode=1;});
}
