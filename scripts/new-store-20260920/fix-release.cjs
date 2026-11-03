const fs=require('fs');
function edit(file,from,to){const s=fs.readFileSync(file,'utf8');if(!s.includes(from))throw Error('Missing anchor '+file);fs.writeFileSync(file,s.replace(from,to));}
edit('backend/config/db.js',"    await ensureColumn(connection, 'local_account_entries', 'is_cleared'",`    if (process.env.BADIZO_NEW_STORE === 'true') {
      const [configured] = await connection.query("SELECT 1 FROM app_settings WHERE setting_key = 'new_store_initialized'");
      if (!configured.length) {
        const settings = {
          shop_name: 'NEW STORE - CONFIGURE SYSTEM', gst_number: '', phone: '', address: '',
          bank_name: '', bank_account_name: '', bank_account_no: '', bank_ifsc: '', bank_branch: '', upi_id: '',
          thermal_footer_line_1: 'Thank you for shopping with us.', thermal_footer_line_2: '',
          thermal_footer_line_3: '', thermal_footer_line_4: '', backup_daily_time: '22:30',
          new_store_initialized: 'true'
        };
        for (const [key, value] of Object.entries(settings)) {
          await connection.query('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
        }
      }
    }

    await ensureColumn(connection, 'local_account_entries', 'is_cleared'`);
edit('backend/server.js','      scheduleDailySaleAlerts();',`      scheduleDailySaleAlerts();
      if (process.env.BADIZO_ENABLE_LOCAL_BACKUP_SCHEDULE === 'true') {
        const { scheduleDailyBackup, scheduleCloudBackupSync } = require('./services/backupService');
        scheduleDailyBackup();
        scheduleCloudBackupSync();
      }`);
edit('backend/services/backupService.js',"    'default-character-set=utf8mb4',","    'port=' + (Number.parseInt(process.env.DB_PORT, 10) || 3306),\n    'default-character-set=utf8mb4',");
edit('backend/services/backupService.js',"    '--single-transaction',","    '--single-transaction',\n    '--no-tablespaces',");
edit('backend/routes/backupHealth.js',"  try {\n    let status = null;",`  try {
    if (process.env.BADIZO_DISABLE_SCHEDULED_CLOUD_BACKUP === 'true') {
      return res.json({ enabled: false, status: 'disabled', message: 'Scheduled cloud backup is not configured for this store.' });
    }
    let status = null;`);
edit('frontend/src/App.js','        if (cancelled) return;','        if (cancelled) return;\n        if (health?.enabled === false) { setBackupAlert(null); return; }');
const file='frontend/src/components/BillingTerminalView.jsx';
let s=fs.readFileSync(file,'utf8');
for(const [a,b] of [["shop_name: 'Hyper Fresh Mart LLP'","shop_name: ''"],["gst_number: '36AAJFH7790R1ZB'","gst_number: ''"],["address: 'Sathupally - Khammam(dt) - 507303'","address: ''"],["phone: '08761 295000'","phone: ''"],["bank_name: 'HDFC BANK'","bank_name: ''"],["bank_account_name: 'Hyper Fresh Mart LLP'","bank_account_name: ''"],["bank_account_no: '59209440987345'","bank_account_no: ''"],["bank_ifsc: 'HDFC0004047'","bank_ifsc: ''"],["bank_branch: 'Sathupally'","bank_branch: ''"]])s=s.replace(a,b);
fs.writeFileSync(file,s);
s=fs.readFileSync('frontend/src/components/invoiceTemplates.js','utf8');
s=s.replace(/bankDetails: \[\s*\['Bank Name', 'ICICI BANK'\],[\s\S]*?\n  \]/,"bankDetails: []");
fs.writeFileSync('frontend/src/components/invoiceTemplates.js',s);
const f='scripts/new-store-20260920/database-setup.cjs';s=fs.readFileSync(f,'utf8').replace("'GOOGLE_DRIVE_BACKUP_ENABLED=false',","'BADIZO_NEW_STORE=true','BADIZO_ENABLE_LOCAL_BACKUP_SCHEDULE=true','GOOGLE_DRIVE_BACKUP_ENABLED=false',");fs.writeFileSync(f,s);
console.log('New-store identity, local backup scheduling and portable backup options updated.');
