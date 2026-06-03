const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

const APP_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(APP_ROOT, 'barcode', 'templates');
const OUTPUT_DIR = path.join(APP_ROOT, 'barcode', 'output');
const DEFAULT_TEMPLATE = 'tsc-244-pro-50x50-two-up.prn';

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

router.use(authenticate, authorize('SERVER', 'ADMIN'));

router.get('/template', async (req, res) => {
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

router.post('/prn', async (req, res) => {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const templateName = cleanTemplateName(req.body?.template_name);
    const templatePath = path.join(TEMPLATE_DIR, templateName);
    const template = await fs.readFile(templatePath, 'utf8');
    const prn = renderLabels(template, req.body || {});
    const safeBarcode = tsplText(req.body?.barcode || 'barcode', 24).replace(/[^A-Z0-9_-]/gi, '_');
    const outputName = `${safeBarcode}_${Date.now()}.prn`;
    const outputPath = path.join(OUTPUT_DIR, outputName);

    await fs.writeFile(outputPath, prn, 'utf8');

    res.json({
      prn,
      template_name: templateName,
      template_path: templatePath,
      output_name: outputName,
      output_path: outputPath,
      sticker_count: Math.max(Number.parseInt(req.body?.stickerCount, 10) || 1, 1)
    });
  } catch (err) {
    console.error('Barcode PRN render failed:', err.message);
    res.status(500).json({ error: 'Unable to generate barcode PRN.' });
  }
});

module.exports = router;
