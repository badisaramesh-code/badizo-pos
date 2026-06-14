const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { authenticate, authorize } = require('../middleware/auth');
const db = require('../config/db');
const { logError } = require('../services/logger');

const router = express.Router();
const execFileAsync = promisify(execFile);

const APP_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(APP_ROOT, 'barcode', 'templates');
const OUTPUT_DIR = path.join(APP_ROOT, 'barcode', 'output');
const DEFAULT_TEMPLATE = 'tsc-244-pro-50x50-two-up.prn';

const TEMPLATE_META = {
  'tsc-244-pro-50x50-two-up.prn': {
    size: '50 x 50 mm Two-Up',
    printer: 'TSC TTP-244 Pro',
    shares: ['\\\\localhost\\TSC TTP-244 Pro', '\\\\localhost\\TSC-244-Pro']
  },
  'tsc-244-1-33x25-single.prn': {
    size: '33 x 25 mm Two-Up',
    printer: 'TSC TTP-244 -1',
    shares: ['\\\\localhost\\TSC TTP-244 -1', '\\\\localhost\\TSC 244-1']
  },
  'tsc-244-2-jewellery-100x15-tail.prn': {
    size: '100 x 15 mm Jewellery Tail',
    printer: 'TSC 244-2',
    shares: ['\\\\localhost\\TSC 244-2']
  }
};

function normalizeTemplateMeta(rawValue) {
  let parsed = {};
  try {
    parsed = rawValue ? JSON.parse(rawValue) : {};
  } catch (err) {
    parsed = {};
  }

  return Object.entries(TEMPLATE_META).reduce((acc, [templateName, defaults]) => {
    const configured = parsed?.[templateName] || {};
    const shares = Array.isArray(configured.shares)
      ? configured.shares
      : String(configured.shares || configured.share || '')
        .split(/\r?\n|,/)
        .map((share) => share.trim())
        .filter(Boolean);

    acc[templateName] = {
      size: defaults.size,
      printer: String(configured.printer || defaults.printer || '').trim(),
      shares: shares.length ? shares.slice(0, 5) : defaults.shares
    };
    return acc;
  }, {});
}

async function getTemplateMeta(templateName) {
  try {
    const [rows] = await db.query(
      `SELECT setting_value FROM app_settings WHERE setting_key = 'barcode_printer_templates' LIMIT 1`
    );
    const configuredMeta = normalizeTemplateMeta(rows[0]?.setting_value || '');
    return configuredMeta[templateName] || TEMPLATE_META[templateName] || { size: templateName, printer: '', shares: [] };
  } catch (err) {
    return TEMPLATE_META[templateName] || { size: templateName, printer: '', shares: [] };
  }
}

function cleanTemplateName(value) {
  const fileName = path.basename(String(value || DEFAULT_TEMPLATE));
  return fileName.endsWith('.prn') ? fileName : DEFAULT_TEMPLATE;
}

function tsplText(value, maxLength = 30) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/"/g, "'")
    .trim()
    .slice(0, maxLength);
}

function moneyText(value) {
  const amount = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount)) return tsplText(value, 12);
  return amount.toFixed(2);
}

function replaceFields(block, data) {
  const fields = {
    PRODUCT_NAME: tsplText(data.product_name, 28).toUpperCase(),
    PRODUCT_NAME_25: tsplText(data.product_name, 25).toUpperCase(),
    PRODUCT_NAME_20: tsplText(data.product_name, 20).toUpperCase(),
    PRODUCT_NAME_18: tsplText(data.product_name, 18).toUpperCase(),
    BARCODE: tsplText(data.barcode, 40),
    MRP: moneyText(data.mrp),
    SALE_PRICE: moneyText(data.sale_price),
    QTY: tsplText(data.qty, 10),
    UNIT: tsplText(data.unit, 10),
    PKD_DATE: tsplText(data.pkd_date, 14),
    COMPANY: tsplText(data.company, 32),
    COMPANY_22: tsplText(data.company, 22),
    COMPANY_20: tsplText(data.company, 20),
    ADDRESS_LINE_1: tsplText(data.address_line_1 || data.address, 38),
    ADDRESS_LINE_1_28: tsplText(data.address_line_1 || data.address, 28),
    ADDRESS_LINE_1_24: tsplText(data.address_line_1 || data.address, 24),
    ADDRESS_LINE_2: tsplText(data.address_line_2, 38),
    ADDRESS_LINE_2_24: tsplText(data.address_line_2, 24),
    CUSTOMER_CARE: tsplText(data.customer_care, 48),
    ADDRESS: tsplText(data.address, 40),
    PHONE: tsplText(data.phone, 20)
  };

  return Object.entries(fields).reduce((text, [key, value]) => (
    text.replaceAll(`{{${key}}}`, value)
  ), block);
}

function extractBlock(template, name) {
  const pattern = new RegExp(`{{#${name}}}([\\s\\S]*?){{/${name}}}`, 'g');
  const match = pattern.exec(template);
  return match ? match[1].trim() : '';
}

function renderLabels(template, data) {
  const labelBlock = extractBlock(template, 'LABEL');
  const stickerCount = Math.max(Number.parseInt(data.stickerCount, 10) || 1, 1);

  if (labelBlock) {
    const renderedLabels = Array.from({ length: stickerCount }, () => replaceFields(labelBlock, data));
    return template
      .replace(/{{#LABEL}}[\s\S]*?{{\/LABEL}}/, renderedLabels.join('\r\n'))
      .replace(/\n/g, '\r\n');
  }

  const rowBlock = extractBlock(template, 'ROW');
  const leftBlock = extractBlock(rowBlock, 'LEFT');
  const rightBlock = extractBlock(rowBlock, 'RIGHT');
  const rows = Math.ceil(stickerCount / 2);
  const renderedRows = [];

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const hasRight = rowIndex * 2 + 2 <= stickerCount;
    const left = replaceFields(leftBlock, data);
    const right = hasRight ? replaceFields(rightBlock, data) : '';
    renderedRows.push(
      rowBlock
        .replace(/{{#LEFT}}[\s\S]*?{{\/LEFT}}/, left)
        .replace(/{{#RIGHT}}[\s\S]*?{{\/RIGHT}}/, right)
    );
  }

  return template
    .replace(/{{#ROW}}[\s\S]*?{{\/ROW}}/, renderedRows.join('\r\n'))
    .replace(/\n/g, '\r\n');
}

async function sendPrnToPrinter(outputPath, printerShares) {
  const shares = Array.isArray(printerShares) ? printerShares.filter(Boolean) : [printerShares].filter(Boolean);
  if (!shares.length) {
    throw new Error('Printer share is not configured for this sticker template.');
  }

  await fs.access(outputPath);
  const errors = [];

  for (const printerShare of shares) {
    try {
      await execFileAsync('cmd.exe', ['/c', 'copy', '/b', outputPath, printerShare], {
        windowsHide: true,
        timeout: 15000
      });
      return printerShare;
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message || '').trim();
      errors.push(`${printerShare}: ${detail || err.message}`);
    }
  }

  throw new Error(
    `Unable to send sticker file to barcode printer. Tried: ${shares.join(', ')}. Share the Windows printer with one of these exact names and try again. Details: ${errors.join(' | ')}`
  );
}

router.use(authenticate);

router.get('/template', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const templateName = cleanTemplateName(req.query.template);
    const templatePath = path.join(TEMPLATE_DIR, templateName);
    const template = await fs.readFile(templatePath, 'utf8');
    res.json({ template, template_name: templateName, template_path: templatePath });
  } catch (err) {
    console.error('Barcode template read failed:', err.message);
    logError('Barcode template read failed', err, { template: req.query?.template });
    res.status(500).json({ error: 'Unable to read barcode PRN template.' });
  }
});

router.get('/print-logs', authorize('SERVER', 'ADMIN'), async (req, res) => {
  const { from, to, search = '' } = req.query || {};
  const clauses = [];
  const params = [];

  if (from) {
    clauses.push('DATE(created_at) >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('DATE(created_at) <= ?');
    params.push(to);
  }
  if (String(search).trim()) {
    clauses.push('(barcode LIKE ? OR product_name LIKE ? OR template_name LIKE ? OR printer_name LIKE ?)');
    const value = `%${String(search).trim()}%`;
    params.push(value, value, value, value);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, barcode, product_name, mrp, sale_price, pkd_date, qty, unit,
              template_name, sticker_size, printer_name, sticker_count, output_name,
              output_path, created_by, created_at
       FROM barcode_print_logs
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT 500`,
      params
    );
    const totals = rows.reduce((acc, row) => ({
      prints: acc.prints + 1,
      stickers: acc.stickers + Number(row.sticker_count || 0)
    }), { prints: 0, stickers: 0 });
    res.json({ rows, totals });
  } catch (err) {
    console.error('Barcode print log report failed:', err.message);
    logError('Barcode print log report failed', err, { query: req.query });
    res.status(500).json({ error: 'Unable to load barcode sticker print report.' });
  }
});

router.post('/prn', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const templateName = cleanTemplateName(req.body?.template_name);
    const templateMeta = await getTemplateMeta(templateName);
    const templatePath = path.join(TEMPLATE_DIR, templateName);
    const template = await fs.readFile(templatePath, 'utf8');
    const prn = renderLabels(template, req.body || {});
    const safeBarcode = tsplText(req.body?.barcode || 'barcode', 24).replace(/[^A-Z0-9_-]/gi, '_');
    const outputName = `${safeBarcode}_${Date.now()}.prn`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    await fs.writeFile(outputPath, prn, 'utf8');
    const stickerCount = Math.max(Number.parseInt(req.body?.stickerCount, 10) || 1, 1);

    await db.query(
      `INSERT INTO barcode_print_logs
       (barcode, product_name, mrp, sale_price, pkd_date, qty, unit, template_name,
        sticker_size, printer_name, sticker_count, output_name, output_path, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tsplText(req.body?.barcode, 120),
        tsplText(req.body?.product_name, 255).toUpperCase(),
        Number(req.body?.mrp || 0) || 0,
        Number(req.body?.sale_price || 0) || 0,
        tsplText(req.body?.pkd_date, 20),
        tsplText(req.body?.qty, 20),
        tsplText(req.body?.unit, 20),
        templateName,
        templateMeta.size,
        templateMeta.printer,
        stickerCount,
        outputName,
        outputPath,
        req.user?.username || ''
      ]
    );

    res.json({
      prn,
      template_name: templateName,
      template_path: templatePath,
      output_name: outputName,
      output_path: outputPath,
      sticker_count: stickerCount,
      sticker_size: templateMeta.size,
      printer_name: templateMeta.printer
    });
  } catch (err) {
    console.error('Barcode PRN render failed:', err.message);
    logError('Barcode PRN render failed', err, {
      barcode: req.body?.barcode,
      product_name: req.body?.product_name,
      template_name: req.body?.template_name,
      stickerCount: req.body?.stickerCount,
      user: req.user?.username || ''
    });
    res.status(500).json({ error: 'Unable to generate barcode PRN.' });
  }
});

router.post('/print', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const templateName = cleanTemplateName(req.body?.template_name);
    const templateMeta = await getTemplateMeta(templateName);
    const outputName = path.basename(String(req.body?.output_name || ''));

    if (!outputName.endsWith('.prn')) {
      return res.status(400).json({ error: 'Valid PRN output file name is required.' });
    }

    const outputPath = path.join(OUTPUT_DIR, outputName);
    const printerShare = await sendPrnToPrinter(outputPath, templateMeta.shares);

    res.json({
      printed: true,
      output_name: outputName,
      output_path: outputPath,
      printer_name: templateMeta.printer,
      printer_share: printerShare
    });
  } catch (err) {
    console.error('Barcode PRN print failed:', err.message);
    logError('Barcode PRN print failed', err, {
      output_name: req.body?.output_name,
      template_name: req.body?.template_name,
      user: req.user?.username || ''
    });
    res.status(500).json({ error: err.message || 'Unable to print barcode sticker.' });
  }
});

module.exports = router;
