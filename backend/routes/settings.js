const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { JWT_SECRET } = require('../middleware/auth');

const ALLOWED_SETTINGS = new Set([
  'shop_name',
  'gst_number',
  'phone',
  'address',
  'bank_name',
  'bank_account_name',
  'bank_account_no',
  'bank_ifsc',
  'bank_branch',
  'counter_count',
  'default_print_mode',
  'thermal_receipt_width_mm',
  'thermal_feed_margin_mm',
  'thermal_bill_logo_enabled',
  'thermal_bill_logo_data_url',
  'thermal_footer_line_1',
  'thermal_footer_line_2',
  'thermal_footer_line_3',
  'thermal_footer_line_4',
  'gst_slabs',
  'loyalty_enabled',
  'loyalty_earn_sale_amount',
  'loyalty_earn_points',
  'loyalty_redeem_points',
  'loyalty_redeem_amount',
  'backup_daily_time',
  'login_logout_alert_phone',
  'gst_api_enabled',
  'gst_api_environment',
  'gst_api_provider',
  'gst_api_username',
  'gst_api_client_id',
  'gst_api_client_secret',
  'gst_api_base_url',
  'ewaybill_enabled',
  'ewaybill_api_username',
  'ewaybill_api_base_url',
  'ewaybill_default_transporter_id',
  'ewaybill_default_transport_mode',
  'barcode_printer_templates'
]);

const DEFAULT_BARCODE_PRINTER_TEMPLATES = {
  'tsc-244-pro-50x50-two-up.prn': {
    label: '50 x 50 mm Two-Up',
    printer: 'TSC TTP-244 Pro',
    shares: ['\\\\localhost\\TSC TTP-244 Pro', '\\\\localhost\\TSC-244-Pro']
  },
  'tsc-244-1-33x25-single.prn': {
    label: '33 x 25 mm Two-Up',
    printer: 'TSC TTP-244 -1',
    shares: ['\\\\localhost\\TSC TTP-244 -1', '\\\\localhost\\TSC 244-1']
  },
  'tsc-244-2-jewellery-100x15-tail.prn': {
    label: '100 x 15 mm Jewellery Tail',
    printer: 'TSC 244-2',
    shares: ['\\\\localhost\\TSC 244-2']
  }
};

const VAULT_CATEGORIES = new Set(['BADIZO_PRODUCT', 'STORE_PROTECTED']);

const VAULT_DEFAULTS = {
  BADIZO_PRODUCT: {
    1: { title: 'SQL Root Password', username: 'root' },
    2: { title: 'Database Backup Password', username: '' },
    3: { title: 'Badizo Software Admin', username: 'badizo' },
    4: { title: 'Backend Server Login', username: '' },
    5: { title: 'Remote Support Password', username: '' }
  },
  STORE_PROTECTED: {
    1: { title: 'Store Server Login', username: 'server' },
    2: { title: 'Admin 1 Login', username: 'admin1', password: 'admin123' },
    3: { title: 'Admin 2 Login', username: 'admin2', password: 'admin123' },
    4: { title: 'Counter 1 Login', username: 'counter1', password: 'counter1' },
    5: { title: 'Counter 2 Login', username: 'counter2', password: 'counter2' },
    6: { title: 'Counter 3 Login', username: 'counter3', password: 'counter3' },
    7: { title: 'Counter 4 Login', username: 'counter4', password: 'counter4' },
    8: { title: 'Counter 5 Login', username: 'counter5', password: 'counter5' },
    9: { title: 'Counter 6 Login', username: 'counter6', password: 'counter6' },
    10: { title: 'Security 1 Login', username: 'security1', password: 'admin123' },
    11: { title: 'Security 2 Login', username: 'security2', password: 'admin123' }
  }
};

VAULT_DEFAULTS.STORE_PROTECTED[1].password = 'server123';

function normalizeVaultCategory(value) {
  const category = String(value || 'STORE_PROTECTED').trim().toUpperCase();
  return VAULT_CATEGORIES.has(category) ? category : 'STORE_PROTECTED';
}

async function readSettings() {
  const [rows] = await db.query(`SELECT setting_key, setting_value FROM app_settings`);
  return rows.reduce((settings, row) => {
    settings[row.setting_key] = row.setting_value;
    return settings;
  }, {});
}

function normalizeBarcodePrinterTemplates(rawValue) {
  let parsed = {};
  try {
    parsed = rawValue ? JSON.parse(rawValue) : {};
  } catch (err) {
    parsed = {};
  }

  return Object.entries(DEFAULT_BARCODE_PRINTER_TEMPLATES).reduce((acc, [templateName, defaults]) => {
    const configured = parsed?.[templateName] || {};
    const shares = Array.isArray(configured.shares)
      ? configured.shares
      : String(configured.shares || configured.share || '')
        .split(/\r?\n|,/)
        .map((share) => share.trim())
        .filter(Boolean);

    acc[templateName] = {
      label: defaults.label,
      printer: String(configured.printer || defaults.printer || '').trim(),
      shares: shares.length ? shares.slice(0, 5) : defaults.shares
    };
    return acc;
  }, {});
}

function publicSettings(settings) {
  const logoDataUrl = String(settings.thermal_bill_logo_data_url || '').trim();
  const thermalFooterDefaults = [
    '1. Goods Exchange Time 2 P.M - 4 P.M',
    '2. Decoration Items & Toys Exchange Not Allowed',
    '3. Warranty or guarantee is the responsibility of the manufacturer.',
    '4. Any dispute subject related to SATHUPALLY jurisdiction.'
  ];
  const gstSlabs = String(settings.gst_slabs || '0,3,5,12,18,28,40')
    .split(/[,;\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    .filter((value, index, list) => list.indexOf(value) === index)
    .sort((a, b) => a - b);
  return {
    shop_name: settings.shop_name || 'Hyper Fresh Mart LLP',
    gst_number: settings.gst_number || '36AAJFH7790R1ZB',
    phone: settings.phone || '08761 295000',
    address: settings.address || 'Sathupally - Khammam(dt) - 507303',
    bank_name: settings.bank_name || 'HDFC BANK',
    bank_account_name: settings.bank_account_name || settings.shop_name || 'Hyper Fresh Mart LLP',
    bank_account_no: settings.bank_account_no || '59209440987345',
    bank_ifsc: settings.bank_ifsc || 'HDFC0004047',
    bank_branch: settings.bank_branch || 'Sathupally',
    counter_count: Number.parseInt(settings.counter_count, 10) || 6,
    default_print_mode: ['Thermal', 'A4'].includes(settings.default_print_mode) ? settings.default_print_mode : 'Thermal',
    thermal_receipt_width_mm: [58, 60, 72, 76, 80, 82, 85, 90].includes(Number.parseInt(settings.thermal_receipt_width_mm, 10))
      ? Number.parseInt(settings.thermal_receipt_width_mm, 10)
      : 80,
    thermal_feed_margin_mm: Number.isFinite(Number.parseInt(settings.thermal_feed_margin_mm, 10))
      ? Math.min(Math.max(Number.parseInt(settings.thermal_feed_margin_mm, 10), 0), 30)
      : 4,
    thermal_bill_logo_enabled: String(settings.thermal_bill_logo_enabled || '1') !== '0',
    thermal_bill_logo_data_url: /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(logoDataUrl) ? logoDataUrl : '',
    thermal_footer_line_1: settings.thermal_footer_line_1 || thermalFooterDefaults[0],
    thermal_footer_line_2: settings.thermal_footer_line_2 || thermalFooterDefaults[1],
    thermal_footer_line_3: settings.thermal_footer_line_3 || thermalFooterDefaults[2],
    thermal_footer_line_4: settings.thermal_footer_line_4 || thermalFooterDefaults[3],
    gst_slabs: gstSlabs.length ? gstSlabs.join(',') : '0,3,5,12,18,28,40',
    loyalty_enabled: String(settings.loyalty_enabled || '0') === '1',
    loyalty_earn_sale_amount: Number(settings.loyalty_earn_sale_amount || 100) > 0 ? Number(settings.loyalty_earn_sale_amount || 100) : 100,
    loyalty_earn_points: Number(settings.loyalty_earn_points || 10) > 0 ? Number(settings.loyalty_earn_points || 10) : 10,
    loyalty_redeem_points: Number(settings.loyalty_redeem_points || 10) > 0 ? Number(settings.loyalty_redeem_points || 10) : 10,
    loyalty_redeem_amount: Number(settings.loyalty_redeem_amount || 0.5) > 0 ? Number(settings.loyalty_redeem_amount || 0.5) : 0.5,
    backup_daily_time: /^\d{2}:\d{2}$/.test(settings.backup_daily_time || '')
      ? settings.backup_daily_time
      : (process.env.BACKUP_DAILY_TIME || '09:00'),
    login_logout_alert_phone: settings.login_logout_alert_phone || '',
    gst_api_enabled: String(settings.gst_api_enabled || '0') === '1',
    gst_api_environment: ['SANDBOX', 'PRODUCTION'].includes(settings.gst_api_environment) ? settings.gst_api_environment : 'SANDBOX',
    gst_api_provider: settings.gst_api_provider || '',
    gst_api_username: settings.gst_api_username || '',
    gst_api_client_id: settings.gst_api_client_id || '',
    gst_api_client_secret: settings.gst_api_client_secret || '',
    gst_api_base_url: settings.gst_api_base_url || 'https://einv-apisandbox.nic.in',
    ewaybill_enabled: String(settings.ewaybill_enabled || '0') === '1',
    ewaybill_api_username: settings.ewaybill_api_username || '',
    ewaybill_api_base_url: settings.ewaybill_api_base_url || 'https://api.ewaybillgst.gov.in',
    ewaybill_default_transporter_id: settings.ewaybill_default_transporter_id || '',
    ewaybill_default_transport_mode: settings.ewaybill_default_transport_mode || 'Road',
    barcode_printer_templates: normalizeBarcodePrinterTemplates(settings.barcode_printer_templates)
  };
}

function vaultKey() {
  return crypto
    .createHash('sha256')
    .update(String(process.env.PASSWORD_VAULT_KEY || JWT_SECRET || 'badizo-password-vault'))
    .digest();
}

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(payload) {
  if (!payload) return '';
  const [ivText, tagText, encryptedText] = String(payload).split(':');
  if (!ivText || !tagText || !encryptedText) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

function publicVaultSlot(row, slotNo, category = 'STORE_PROTECTED') {
  const defaults = VAULT_DEFAULTS[category]?.[slotNo] || {};
  return {
    category,
    slot_no: slotNo,
    title: row?.title || defaults.title || '',
    username: row?.username || defaults.username || '',
    notes: row?.notes || '',
    has_password: Boolean(row?.secret_encrypted || defaults.password),
    updated_by: row?.updated_by || '',
    updated_at: row?.updated_at || null
  };
}

router.get('/', async (_req, res) => {
  try {
    const settings = await readSettings();
    res.json(publicSettings(settings));
  } catch (err) {
    console.error('Settings fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch settings.' });
  }
});

router.post('/', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const entries = Object.entries(req.body || {}).filter(([key]) => ALLOWED_SETTINGS.has(key));

    for (const [key, rawValue] of entries) {
      let value = key === 'barcode_printer_templates'
        ? JSON.stringify(normalizeBarcodePrinterTemplates(JSON.stringify(rawValue || {})))
        : String(rawValue ?? '').trim();

      if (key === 'counter_count') {
        const counterCount = Math.min(Math.max(Number.parseInt(value, 10) || 1, 1), 99);
        value = String(counterCount);
      }

      if (key === 'default_print_mode' && !['Thermal', 'A4'].includes(value)) {
        value = 'Thermal';
      }

      if (key === 'thermal_receipt_width_mm') {
        const width = Number.parseInt(value, 10);
        value = String([58, 60, 72, 76, 80, 82, 85, 90].includes(width) ? width : 80);
      }

      if (key === 'thermal_feed_margin_mm') {
        const margin = Number.parseInt(value, 10);
        value = String(Number.isFinite(margin) ? Math.min(Math.max(margin, 0), 30) : 4);
      }

      if (key === 'thermal_bill_logo_enabled') {
        value = ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()) ? '1' : '0';
      }

      if (key === 'thermal_bill_logo_data_url') {
        value = String(rawValue || '').trim();
        if (value && !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(value)) {
          return res.status(400).json({ error: 'Thermal bill logo must be a PNG, JPG, or WebP image.' });
        }
        if (value.length > 700000) {
          return res.status(400).json({ error: 'Thermal bill logo is too large. Use a small 22mm x 22mm image.' });
        }
      }

      if (key.startsWith('thermal_footer_line_')) {
        value = String(rawValue || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      }

      if (key === 'gst_slabs') {
        const slabs = String(rawValue || '')
          .split(/[,;\s]+/)
          .map((item) => Number(item))
          .filter((item) => Number.isFinite(item) && item >= 0 && item <= 100)
          .filter((item, index, list) => list.indexOf(item) === index)
          .sort((a, b) => a - b);
        value = slabs.length ? slabs.join(',') : '0,3,5,12,18,28,40';
      }

      if ([
        'loyalty_enabled',
        'loyalty_earn_sale_amount',
        'loyalty_earn_points',
        'loyalty_redeem_points',
        'loyalty_redeem_amount'
      ].includes(key)) {
        if (key === 'loyalty_enabled') {
          value = ['1', 'true', 'yes', 'on'].includes(String(rawValue).toLowerCase()) ? '1' : '0';
        } else {
          const number = Number(rawValue);
          value = String(Number.isFinite(number) && number > 0 ? number : publicSettings({})[key]);
        }
      }

      if (key === 'backup_daily_time') {
        const [hour, minute] = String(value || '').split(':').map((part) => Number.parseInt(part, 10));
        value = Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
          ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
          : '09:00';
      }

      if (key === 'login_logout_alert_phone') {
        value = String(rawValue || '').replace(/[^\d+]/g, '').slice(0, 20);
      }

      if (['gst_api_enabled', 'ewaybill_enabled'].includes(key)) {
        value = ['1', 'true', 'yes', 'on'].includes(String(rawValue).toLowerCase()) ? '1' : '0';
      }

      if (key === 'gst_api_environment') {
        value = String(rawValue || '').toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
      }

      if ([
        'gst_api_provider',
        'gst_api_username',
        'gst_api_client_id',
        'gst_api_client_secret',
        'gst_api_base_url',
        'ewaybill_api_username',
        'ewaybill_api_base_url',
        'ewaybill_default_transporter_id',
        'ewaybill_default_transport_mode'
      ].includes(key)) {
        value = String(rawValue || '').trim().slice(0, 255);
      }

      await db.query(
        `INSERT INTO app_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
      );
    }

    res.json(publicSettings(await readSettings()));
  } catch (err) {
    console.error('Settings save failed:', err.message);
    res.status(500).json({ error: 'Unable to save settings.' });
  }
});

router.get('/password-vault', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const category = normalizeVaultCategory(req.query?.category);
  try {
    const [rows] = await db.query(
      `SELECT category, slot_no, title, username, secret_encrypted, notes, updated_by, updated_at
       FROM password_vault
       WHERE category = ?
       ORDER BY slot_no ASC`,
      [category]
    );
    const bySlot = new Map(rows.map((row) => [Number(row.slot_no), row]));
    const slotCount = category === 'STORE_PROTECTED' ? 11 : 10;
    const slots = Array.from({ length: slotCount }, (_, index) => publicVaultSlot(bySlot.get(index + 1), index + 1, category));
    res.json({ category, slots });
  } catch (err) {
    console.error('Password vault list failed:', err.message);
    res.status(500).json({ error: 'Unable to load password vault.' });
  }
});

router.post('/password-vault/:slotNo', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const slotNo = Number.parseInt(req.params.slotNo, 10);
  const category = normalizeVaultCategory(req.body?.category || req.query?.category);
  const maxSlotNo = category === 'STORE_PROTECTED' ? 11 : 10;
  if (slotNo < 1 || slotNo > maxSlotNo) {
    return res.status(400).json({ error: `Password slot must be between 1 and ${maxSlotNo}.` });
  }

  try {
    const title = String(req.body?.title || '').trim().slice(0, 120);
    const username = String(req.body?.username || '').trim().slice(0, 120);
    const notes = String(req.body?.notes || '').trim().slice(0, 255);
    const password = String(req.body?.password ?? '');
    const shouldUpdateSecret = Boolean(req.body?.update_password);

    const values = [category, slotNo, title, username, notes, req.user?.username || ''];
    let insertSecretSql = 'NULL';
    let updateSecretSql = '';

    if (shouldUpdateSecret) {
      insertSecretSql = '?';
      updateSecretSql = ', secret_encrypted = VALUES(secret_encrypted)';
      values.splice(4, 0, encryptSecret(password));
    }

    await db.query(
      `INSERT INTO password_vault
       (category, slot_no, title, username, secret_encrypted, notes, updated_by)
       VALUES (?, ?, ?, ?, ${insertSecretSql}, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         username = VALUES(username),
         notes = VALUES(notes),
         updated_by = VALUES(updated_by)
         ${updateSecretSql}`,
      values
    );

    const [rows] = await db.query(
      `SELECT category, slot_no, title, username, secret_encrypted, notes, updated_by, updated_at
       FROM password_vault
       WHERE category = ? AND slot_no = ?
       LIMIT 1`,
      [category, slotNo]
    );
    res.json(publicVaultSlot(rows[0], slotNo, category));
  } catch (err) {
    console.error('Password vault save failed:', err.message);
    res.status(500).json({ error: 'Unable to save password vault entry.' });
  }
});

router.get('/password-vault/:slotNo/reveal', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const slotNo = Number.parseInt(req.params.slotNo, 10);
  const category = normalizeVaultCategory(req.query?.category);
  const maxSlotNo = category === 'STORE_PROTECTED' ? 11 : 10;
  if (slotNo < 1 || slotNo > maxSlotNo) {
    return res.status(400).json({ error: `Password slot must be between 1 and ${maxSlotNo}.` });
  }

  try {
    const [rows] = await db.query(
      `SELECT secret_encrypted FROM password_vault WHERE category = ? AND slot_no = ? LIMIT 1`,
      [category, slotNo]
    );
    const defaultPassword = VAULT_DEFAULTS[category]?.[slotNo]?.password || '';
    res.json({ category, slot_no: slotNo, password: rows[0]?.secret_encrypted ? decryptSecret(rows[0].secret_encrypted) : defaultPassword });
  } catch (err) {
    console.error('Password vault reveal failed:', err.message);
    res.status(500).json({ error: 'Unable to reveal password.' });
  }
});

module.exports = router;
