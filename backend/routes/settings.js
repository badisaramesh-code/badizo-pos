const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

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
  'default_print_mode'
]);

async function readSettings() {
  const [rows] = await db.query(`SELECT setting_key, setting_value FROM app_settings`);
  return rows.reduce((settings, row) => {
    settings[row.setting_key] = row.setting_value;
    return settings;
  }, {});
}

router.get('/', async (_req, res) => {
  try {
    const settings = await readSettings();
    res.json({
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
      default_print_mode: ['Thermal', 'A4'].includes(settings.default_print_mode) ? settings.default_print_mode : 'Thermal'
    });
  } catch (err) {
    console.error('Settings fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch settings.' });
  }
});

router.post('/', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const entries = Object.entries(req.body || {}).filter(([key]) => ALLOWED_SETTINGS.has(key));

    for (const [key, rawValue] of entries) {
      let value = String(rawValue ?? '').trim();

      if (key === 'counter_count') {
        const counterCount = Math.min(Math.max(Number.parseInt(value, 10) || 1, 1), 99);
        value = String(counterCount);
      }

      if (key === 'default_print_mode' && !['Thermal', 'A4'].includes(value)) {
        value = 'Thermal';
      }

      await db.query(
        `INSERT INTO app_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [key, value]
      );
    }

    res.json(await readSettings());
  } catch (err) {
    console.error('Settings save failed:', err.message);
    res.status(500).json({ error: 'Unable to save settings.' });
  }
});

module.exports = router;
