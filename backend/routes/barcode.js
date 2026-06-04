const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');
const db = require('../config/db');

const router = express.Router();

const APP_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(APP_ROOT, 'barcode', 'templates');
const OUTPUT_DIR = path.join(APP_ROOT, 'barcode', 'output');
const DEFAULT_TEMPLATE = 'tsc-244-pro-50x50-two-up.prn';

const TEMPLATE_META = {
  'tsc-244-pro-50x50-two-up.prn': { size: '50 x 50 mm Two-Up', printer: 'TSC-244-Pro' },
  'tsc-244-1-33x25-single.prn': { size: '33 x 25 mm Product Sticker', printer: 'TSC 244-1' },
  'tsc-244-2-jewellery-100x15-tail.prn': { size: '100 x 15 mm Jewellery Tail', printer: 'TSC 244-2' }
};

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
    BARCODE: tsplText(data.barcode, 40),
    MRP: moneyText(data.mrp),
    SALE_PRICE: moneyText(data.sale_price),
    QTY: tsplText(data.qty, 10),
    UNIT: tsplText(data.unit, 10),
    PKD_DATE: tsplText(data.pkd_date, 14),
    COMPANY: tsplText(data.company, 32),
    ADDRESS_LINE_1: tsplText(data.address_line_1 || data.address, 38),
    ADDRESS_LINE_2: tsplText(data.address_line_2, 38),
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

router.use(authenticate);

router.get('/template', authorize('SERVER', 'ADMIN'), async (req, res) => {
  try {
    const templateName = cleanTemplateName(req.query.template);
    const templatePath = path.join(TEMPLATE_DIR, templateName);
    const template = await fs.readFile(templatePath, 'utf8');
    res.json({ template, template_name: templateName, template_path: templatePath });
  } catch (err) {
    console.error('Barcode template read failed:', err.message);
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
    res.status(500).json({ error: 'Unable to load barcode sticker print report.' });
  }
});

router.post('/prn', authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const templateName = cleanTemplateName(req.body?.template_name);
    const templateMeta = TEMPLATE_META[templateName] || { size: templateName, printer: '' };
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
    res.status(500).json({ error: 'Unable to generate barcode PRN.' });
  }
});

module.exports = router;
