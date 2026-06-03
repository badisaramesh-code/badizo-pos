import React, { useEffect, useMemo, useState } from 'react';
import { createWorker, PSM } from 'tesseract.js';
import {
  fetchInwardDetails,
  fetchInwardDetailsByNumber,
  fetchInwardHistory,
  fetchRecentInwards,
  saveInwardEntry,
  searchProducts
} from '../api/client';
import { formatMoney, toNumber } from '../utils/money';

const blankLine = {
  product: '',
  barcode: '',
  hsn_code: '',
  mrp: '',
  gst_percent: '0',
  price: '',
  batch_no: '',
  expiry_date: '',
  discount_type: 'PERCENT',
  discount: '',
  scheme_type: 'PERCENT',
  scheme: '',
  free: '',
  qty: '',
  last_amount_input: 'RATE'
};

const blankSupplier = {
  name: '',
  address: '',
  gstin: '',
  phone: '',
  invoice_no: '',
  invoice_date: ''
};

function todayIso() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

const invoiceColumnAliases = {
  barcode: ['barcode', 'bar code', 'ean', 'item code', 'product code', 'code'],
  product: ['product', 'products', 'product name', 'item', 'items', 'item name', 'goods', 'description', 'description of goods', 'particulars'],
  hsn_code: ['hsn', 'hsn code', 'hsn/sac', 'hsn sac'],
  mrp: ['mrp'],
  price: ['price', 'rate', 'purchase price', 'basic rate', 'rate incl of tax', 'rate inclusive tax'],
  batch_no: ['batch', 'batch no', 'batch number', 'lot', 'lot no'],
  expiry_date: ['expiry', 'expiry date', 'exp', 'exp date', 'best before'],
  discount: ['discount', 'disc', 'disc%', 'discount%'],
  scheme: ['scheme', 'scheam', 'offer'],
  free: ['free', 'free qty', 'free quantity'],
  gst_percent: ['gst', 'gst%', 'tax', 'tax%'],
  qty: ['qty', 'quantity', 'nos']
};

const itemHeaderWords = [
  'item',
  'items',
  'product',
  'products',
  'goods',
  'description',
  'description of goods',
  'particulars'
];

const ocrStopWords = [
  'total',
  'amount chargeable',
  'tax amount',
  'company',
  'declaration',
  'bank',
  'customer',
  'authorised',
  'generated',
  'sgst',
  'cgst',
  'igst',
  'round off',
  'less',
  'e. & o.e',
  'hsn/sac taxable',
  'taxable value'
];

function splitDelimitedLine(line) {
  if (!/[,\t]/.test(line) && /\s{2,}/.test(line)) {
    return line.split(/\s{2,}/).map((cell) => cell.trim());
  }

  const cells = [];
  let value = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === ',' || char === '\t') && !inQuotes) {
      cells.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }

  cells.push(value.trim());
  return cells;
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[().:%]/g, '')
    .replace(/[_/-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function buildColumnMap(headers) {
  return headers.reduce((map, header, index) => {
    const normalized = normalizeHeader(header);
    Object.entries(invoiceColumnAliases).forEach(([field, aliases]) => {
      if (map[field] === undefined && aliases.includes(normalized)) {
        map[field] = index;
      }
    });
    return map;
  }, {});
}

function isItemHeaderLine(line) {
  const normalized = normalizeHeader(line);
  const hasItemColumn = itemHeaderWords.some((word) => normalized.includes(word));
  const hasSupportingColumn = ['hsn', 'qty', 'quantity', 'rate', 'price', 'amount', 'mrp'].some((word) => normalized.includes(word));
  return hasItemColumn && hasSupportingColumn;
}

function isHeaderOnlyLine(line) {
  const normalized = normalizeHeader(line);
  const hasHeaderWord = itemHeaderWords.some((word) => normalized.includes(word))
    || ['sl', 'no', 'hsn', 'sac', 'quantity', 'rate', 'amount', 'per'].some((word) => normalized.includes(word));
  const hasItemData = /\d{4,8}/.test(line) && /\d+/.test(line.replace(/\d{4,8}/, ''));
  return hasHeaderWord && !hasItemData;
}

function isLikelyInvoiceFooter(line) {
  const normalized = normalizeHeader(line);
  return ocrStopWords.some((word) => normalized === word || normalized.startsWith(`${word} `) || normalized.includes(word));
}

function cleanHsnToken(token) {
  const digits = String(token || '').replace(/\D/g, '');
  return /^\d{4,8}$/.test(digits) ? digits : '';
}

function isLikelyOcrItemLine(line) {
  const tokens = line.replace(/[|]/g, ' ').split(/\s+/).filter(Boolean);
  const hsnIndex = tokens.findIndex((token) => cleanHsnToken(token));
  if (hsnIndex < 0) return false;

  const beforeHsn = tokens.slice(0, hsnIndex).join(' ');
  const hasProductText = /[A-Za-z]{3,}/.test(beforeHsn);
  const hasAmountAfterHsn = tokens.slice(hsnIndex + 1).some(isMoneyLike);
  return hasProductText && hasAmountAfterHsn;
}

function findDelimitedHeaderIndex(rows) {
  return rows.findIndex((row) => {
    const headerMap = buildColumnMap(row);
    return Boolean(headerMap.product !== undefined && (headerMap.hsn_code !== undefined || headerMap.qty !== undefined || headerMap.price !== undefined));
  });
}

function parseInvoiceRows(text) {
  const sourceLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows = sourceLines.map(splitDelimitedLine).filter((row) => row.some(Boolean));

  if (rows.length < 2) return [];

  const headerIndex = findDelimitedHeaderIndex(rows);
  const hasHeader = headerIndex >= 0;
  const headerMap = hasHeader ? buildColumnMap(rows[headerIndex]) : {};
  const dataRows = hasHeader ? rows.slice(headerIndex + 1) : [];
  const fallbackOrder = ['barcode', 'product', 'hsn_code', 'mrp', 'price', 'batch_no', 'expiry_date', 'discount', 'scheme', 'free', 'gst_percent', 'qty'];

  const parsedRows = dataRows.map((row) => {
    const getValue = (field) => {
      const index = hasHeader ? headerMap[field] : fallbackOrder.indexOf(field);
      return index >= 0 ? String(row[index] || '').trim() : '';
    };

    return {
      product: getValue('product'),
      barcode: getValue('barcode').toUpperCase(),
      hsn_code: getValue('hsn_code'),
      mrp: getValue('mrp'),
      gst_percent: normalizeGstPercent(getValue('gst_percent') || '0'),
      price: getValue('price'),
      batch_no: getValue('batch_no').toUpperCase(),
      expiry_date: getValue('expiry_date'),
      discount: getValue('discount'),
      scheme: getValue('scheme'),
      free: getValue('free'),
      qty: getValue('qty')
    };
  }).filter((line) => line.product && (line.hsn_code || line.qty || line.price || line.barcode));

  if (parsedRows.length) return parsedRows;
  return parseOcrInvoiceRows(sourceLines);
}

function isMoneyLike(value) {
  return /^-?\d+(\.\d+)?%?$/.test(String(value || '').replace(/[₹,]/g, ''));
}

function cleanNumber(value) {
  return String(value || '').replace(/[₹,%]/g, '').replace(/,/g, '').trim();
}

function getOcrItemLines(lines) {
  const headerIndex = lines.findIndex((line, index) => isItemHeaderLine(lines.slice(index, index + 3).join(' ')));
  if (headerIndex < 0) {
    return lines.filter((line) => !isLikelyInvoiceFooter(line) && isLikelyOcrItemLine(line));
  }

  const itemLines = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (isLikelyInvoiceFooter(line)) break;
    if (isHeaderOnlyLine(line)) continue;
    itemLines.push(line);
  }
  return itemLines;
}

function pickOcrPrice(numbersAfterHsn) {
  const qty = toNumber(numbersAfterHsn[0]);
  const amount = toNumber(numbersAfterHsn[numbersAfterHsn.length - 1]);
  const candidates = numbersAfterHsn.slice(1, -1);
  if (!candidates.length) return numbersAfterHsn[1] || '';

  const ranked = candidates
    .map((value) => {
      const price = toNumber(value);
      const directDiff = Math.abs(qty * price - amount);
      const taxInclusiveDiff = [0, 3, 5, 12, 18, 28, 40].reduce((best, gst) => (
        Math.min(best, Math.abs(qty * price * (1 + gst / 100) - amount))
      ), Number.POSITIVE_INFINITY);
      return { value, diff: Math.min(directDiff, taxInclusiveDiff) };
    })
    .sort((a, b) => a.diff - b.diff);

  return ranked[0]?.value || candidates[candidates.length - 1] || '';
}

function pickOcrGstPercent(numberTokens, price) {
  const gstToken = numberTokens.find((token) => /%$/.test(token));
  if (gstToken) return cleanNumber(gstToken);

  const priceValue = toNumber(price);
  const possibleRates = numberTokens
    .map(cleanNumber)
    .filter((value) => ['0', '3', '5', '12', '18', '28', '40'].includes(value));
  return possibleRates.find((value) => toNumber(value) !== priceValue) || '0';
}

function normalizeOcrProductName(value) {
  return String(value || '')
    .replace(/[‘’']/g, '*')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function normalizeDiscountType(value) {
  return value === 'VALUE' ? 'VALUE' : 'PERCENT';
}

function normalizeGstPercent(value) {
  const number = toNumber(value, 0);
  return Number.isInteger(number) ? String(number) : String(number);
}

function calculateLineReduction(baseAmount, value, type) {
  const amount = toNumber(value);
  if (amount <= 0 || baseAmount <= 0) return 0;
  const reduction = normalizeDiscountType(type) === 'VALUE' ? amount : baseAmount * (amount / 100);
  return Math.min(reduction, baseAmount);
}

function calculateInwardLine(line, taxType, discountType, schemeType) {
  const quantity = toNumber(line.qty);
  const purchaseRate = toNumber(line.price);
  const gross = purchaseRate * quantity;
  const discount = calculateLineReduction(gross, line.discount, discountType);
  const scheme = calculateLineReduction(gross - discount, line.scheme, schemeType);
  const taxable = Math.max(gross - discount - scheme, 0);
  const gst = taxable * (toNumber(line.gst_percent) / 100);

  return {
    gross,
    discount,
    scheme,
    taxable,
    gst,
    cgst: taxType === 'LOCAL' ? gst / 2 : 0,
    sgst: taxType === 'LOCAL' ? gst / 2 : 0,
    igst: taxType === 'INTERSTATE' ? gst : 0,
    amount: taxable + gst
  };
}

function reversePercentFactor(value) {
  const percent = Math.min(Math.max(toNumber(value), 0), 99.99);
  return 1 - (percent / 100);
}

function deriveGrossFromTaxable(taxableAmount, line, discountType, schemeType) {
  let amountAfterDiscount = toNumber(taxableAmount);

  if (normalizeDiscountType(schemeType) === 'VALUE') {
    amountAfterDiscount += toNumber(line.scheme);
  } else {
    amountAfterDiscount /= reversePercentFactor(line.scheme);
  }

  if (normalizeDiscountType(discountType) === 'VALUE') {
    return amountAfterDiscount + toNumber(line.discount);
  }

  return amountAfterDiscount / reversePercentFactor(line.discount);
}

function deriveRateFromTaxable(taxableAmount, line, discountType, schemeType) {
  const quantity = toNumber(line.qty);
  if (quantity <= 0) return line.price;
  const gross = deriveGrossFromTaxable(taxableAmount, line, discountType, schemeType);
  return Math.max(gross / quantity, 0).toFixed(2);
}

function deriveRateFromTotal(totalAmount, line, discountType, schemeType) {
  const total = toNumber(totalAmount);
  const gstFactor = 1 + (toNumber(line.gst_percent) / 100);
  const taxable = gstFactor > 0 ? total / gstFactor : total;
  return deriveRateFromTaxable(taxable, line, discountType, schemeType);
}

function parseOcrItemLine(line) {
    const tokens = line.replace(/[|]/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 5) return null;

    let cursor = 0;
    if (/^\d{1,3}$/.test(tokens[cursor])) cursor += 1;

    const hsnIndex = tokens.findIndex((token, index) => index >= cursor && cleanHsnToken(token));
    if (hsnIndex < 0) return null;

    const productTokens = tokens.slice(cursor, hsnIndex).filter((token) => !/^[.:,-]+$/.test(token));
    if (!productTokens.length) return null;

    const numberTokensAfterHsn = tokens.slice(hsnIndex + 1).filter(isMoneyLike);
    const numbersAfterHsn = numberTokensAfterHsn.map(cleanNumber);
    if (numbersAfterHsn.length < 1) return null;

    const barcode = /^[A-Z0-9-]{6,}$/.test(productTokens[0]) && /\d/.test(productTokens[0])
      ? productTokens.shift().toUpperCase()
      : '';
    const quantity = numbersAfterHsn.length >= 2 ? numbersAfterHsn[0] : '';
    const price = numbersAfterHsn.length >= 2 ? pickOcrPrice(numbersAfterHsn) : numbersAfterHsn[0];
    const mrp = numbersAfterHsn.length >= 3 ? numbersAfterHsn[1] : price;
    const gstPercent = pickOcrGstPercent(numberTokensAfterHsn, price);

    return {
      barcode,
      product: normalizeOcrProductName(productTokens.join(' ')),
      hsn_code: cleanHsnToken(tokens[hsnIndex]),
      mrp,
      price,
      discount_type: 'PERCENT',
      discount: '',
      scheme_type: 'PERCENT',
      scheme: '',
      free: '',
      gst_percent: normalizeGstPercent(gstPercent),
      qty: quantity
    };
}

function buildOcrCandidateRows(itemLines) {
  const candidates = [];

  itemLines.forEach((line, index) => {
    candidates.push(line);
    if (itemLines[index + 1]) candidates.push(`${line} ${itemLines[index + 1]}`);
    if (itemLines[index + 1] && itemLines[index + 2]) candidates.push(`${line} ${itemLines[index + 1]} ${itemLines[index + 2]}`);
  });

  return candidates;
}

function parseOcrInvoiceRows(lines) {
  const parsedRows = buildOcrCandidateRows(getOcrItemLines(lines))
    .map(parseOcrItemLine)
    .filter(Boolean)
    .sort((a, b) => b.product.length - a.product.length);

  const seen = new Set();
  return parsedRows.filter((row) => {
    const key = `${row.product.toLowerCase()}|${row.hsn_code}|${row.qty}|${row.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function InwardEntryView() {
  const [supplier, setSupplier] = useState(blankSupplier);
  const [taxType, setTaxType] = useState('LOCAL');
  const [paymentMode, setPaymentMode] = useState('Credit');
  const [discountType, setDiscountType] = useState('PERCENT');
  const [schemeType, setSchemeType] = useState('PERCENT');
  const [lines, setLines] = useState([blankLine]);
  const [recentInwards, setRecentInwards] = useState([]);
  const [historyFilters, setHistoryFilters] = useState({ from: '', to: '', supplier: '', invoice: '' });
  const [viewedInward, setViewedInward] = useState(null);
  const [isLoadingInward, setIsLoadingInward] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [invoiceImportText, setInvoiceImportText] = useState('');
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadRecentInwards();
  }, []);

  const totals = useMemo(() => lines.reduce((acc, line) => {
    const calculated = calculateInwardLine(line, taxType, discountType, schemeType);

    return {
      qty: acc.qty + toNumber(line.qty) + toNumber(line.free),
      taxable: acc.taxable + calculated.taxable,
      discount: acc.discount + calculated.discount + calculated.scheme,
      gst: acc.gst + calculated.gst,
      cgst: acc.cgst + calculated.cgst,
      sgst: acc.sgst + calculated.sgst,
      igst: acc.igst + calculated.igst,
      total: acc.total + calculated.amount
    };
  }, { qty: 0, taxable: 0, discount: 0, gst: 0, cgst: 0, sgst: 0, igst: 0, total: 0 }), [discountType, lines, schemeType, taxType]);

  async function loadRecentInwards() {
    try {
      const hasFilters = historyFilters.from || historyFilters.to || historyFilters.supplier || historyFilters.invoice;
      setRecentInwards(hasFilters ? await fetchInwardHistory(historyFilters) : await fetchRecentInwards());
    } catch (err) {
      setRecentInwards([]);
    }
  }

  function updateHistoryFilter(field, value) {
    setHistoryFilters((current) => ({ ...current, [field]: value }));
  }

  function resetHistoryDatesToToday() {
    const date = todayIso();
    setHistoryFilters((current) => ({ ...current, from: date, to: date }));
  }

  async function clearHistoryFilters() {
    const emptyFilters = { from: '', to: '', supplier: '', invoice: '' };
    setHistoryFilters(emptyFilters);
    try {
      setRecentInwards(await fetchRecentInwards());
    } catch (err) {
      setRecentInwards([]);
    }
  }

  async function handleViewInward(entry) {
    const serialNo = typeof entry === 'object' ? entry?.id : entry;
    const inwardNo = typeof entry === 'object' ? entry?.inward_no : '';
    setIsLoadingInward(true);
    setErrorMessage('');
    setViewedInward(null);
    try {
      const details = serialNo
        ? await fetchInwardDetails(serialNo)
        : await fetchInwardDetailsByNumber(inwardNo);
      setViewedInward(details);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to open inward bill.');
    } finally {
      setIsLoadingInward(false);
    }
  }

  function handlePrintInward() {
    document.body.classList.add('printing-inward');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-inward'), 300);
  }

  function updateSupplier(field, value) {
    setSupplier((current) => ({ ...current, [field]: value }));
  }

  function updateLine(index, field, value) {
    setLines((current) => current.map((line, lineIndex) => {
      if (lineIndex !== index) return line;

      const nextValue = field === 'gst_percent'
        ? normalizeGstPercent(value)
        : (field === 'product' ? value.toUpperCase() : value);
      const nextLine = { ...line, [field]: nextValue };

      if (field === 'taxable_amount') {
        return {
          ...nextLine,
          price: deriveRateFromTaxable(nextValue, nextLine, discountType, schemeType),
          last_amount_input: 'TAXABLE'
        };
      }

      if (field === 'total_amount') {
        return {
          ...nextLine,
          price: deriveRateFromTotal(nextValue, nextLine, discountType, schemeType),
          last_amount_input: 'TOTAL'
        };
      }

      if (field === 'price') {
        return { ...nextLine, taxable_amount: '', total_amount: '', last_amount_input: 'RATE' };
      }

      if (['qty', 'gst_percent', 'discount', 'scheme'].includes(field)) {
        if (nextLine.last_amount_input === 'TAXABLE' && String(nextLine.taxable_amount || '').trim()) {
          return {
            ...nextLine,
            price: deriveRateFromTaxable(nextLine.taxable_amount, nextLine, discountType, schemeType)
          };
        }

        if (nextLine.last_amount_input === 'TOTAL' && String(nextLine.total_amount || '').trim()) {
          return {
            ...nextLine,
            price: deriveRateFromTotal(nextLine.total_amount, nextLine, discountType, schemeType)
          };
        }
      }

      return nextLine;
    }));
  }

  function addRow() {
    setLines((current) => [...current, { ...blankLine }]);
  }

  function removeRow(index) {
    setLines((current) => (current.length === 1 ? [{ ...blankLine }] : current.filter((_, lineIndex) => lineIndex !== index)));
  }

  function mergeProductIntoLine(line, product) {
    if (!product) return line;

    return {
      ...line,
      product: normalizeOcrProductName(product.product_name || line.product),
      barcode: product.barcode || line.barcode,
      hsn_code: line.hsn_code || product.hsn_code || '',
      gst_percent: normalizeGstPercent(line.gst_percent || product.gst_percent || 0),
      mrp: line.mrp || String(product.mrp || 0),
      price: line.price || String(product.sale_price || product.mrp || 0)
    };
  }

  function getProductSearchQueries(line) {
    const query = line.barcode || line.product;
    if (!query || query.trim().length < 3) return [];

    const normalized = normalizeOcrProductName(query);
    const withoutPack = normalized.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    const compactPack = normalized.replace(/\*/g, ' ');
    return Array.from(new Set([query.trim(), normalized, compactPack, withoutPack].filter((item) => item.length >= 3)));
  }

  async function findProductForLine(line) {
    const queries = getProductSearchQueries(line);
    for (const query of queries) {
      const results = await searchProducts(query);
      if (results[0]) return results[0];
    }
    return null;
  }

  async function hydrateImportedProducts(importedRows) {
    const settledRows = await Promise.all(importedRows.map(async (line) => {
      try {
        const product = await findProductForLine(line);
        return { line: mergeProductIntoLine(line, product), matched: Boolean(product) };
      } catch (err) {
        return { line, matched: false };
      }
    }));

    return {
      rows: settledRows.map((row) => row.line),
      matchedCount: settledRows.filter((row) => row.matched).length
    };
  }

  async function fillProduct(index) {
    const line = lines[index];
    if (!getProductSearchQueries(line).length) {
      setErrorMessage('Enter at least 3 letters or barcode digits before product lookup.');
      return;
    }

    try {
      const product = await findProductForLine(line);
      if (!product) {
        setErrorMessage('Product not found. It will be created from this inward line if saved.');
        return;
      }

      setLines((current) => current.map((currentLine, lineIndex) => (
        lineIndex === index ? mergeProductIntoLine(currentLine, product) : currentLine
      )));
      setErrorMessage('');
    } catch (err) {
      setErrorMessage('Unable to lookup product.');
    }
  }

  async function handleSave() {
    setStatusMessage('');
    setErrorMessage('');
    setIsSaving(true);

    try {
      const result = await saveInwardEntry({
        supplier,
        tax_type: taxType,
        payment_mode: paymentMode,
        lines: lines.map((line) => ({
          ...line,
          discount_type: discountType,
          scheme_type: schemeType
        }))
      });
      setStatusMessage(`Inward S.No ${result.serial_no || result.id} (${result.inward_no}) saved. Stock updated for ${result.item_count} products.`);
      setSupplier(blankSupplier);
      setPaymentMode('Credit');
      setLines([{ ...blankLine }]);
      await loadRecentInwards();
      if (result.id || result.inward_no) await handleViewInward(result);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save inward entry.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleInvoiceImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatusMessage('');
    setErrorMessage('');
    setOcrProgress('Preparing OCR...');
    setIsOcrRunning(true);

    try {
      const worker = await createWorker('eng', 1, {
        logger: (message) => {
          if (message.status) {
            const percent = message.progress ? ` ${Math.round(message.progress * 100)}%` : '';
            setOcrProgress(`${message.status}${percent}`);
          }
        }
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: '1'
      });
      const { data } = await worker.recognize(file);
      await worker.terminate();

      const text = data?.text || '';
      setInvoiceImportText(text);
      const rows = parseInvoiceRows(text);
      if (rows.length) {
        setOcrProgress('Matching products...');
        const { rows: hydratedRows, matchedCount } = await hydrateImportedProducts(rows);
        setLines(hydratedRows);
        setStatusMessage(`${rows.length} rows read from invoice image. ${matchedCount} matched with product table. Review all fields before Save Inward.`);
      } else {
        setErrorMessage('OCR completed, but rows could not be detected. Check the extracted text and adjust/paste CSV-style rows if needed.');
      }
    } catch (err) {
      setErrorMessage('Unable to read invoice image. Use a clearer photo, crop to the item table, or use CSV/text import.');
    } finally {
      setIsOcrRunning(false);
      setOcrProgress('');
      event.target.value = '';
    }
  }

  return (
    <div className="form-stack">
      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">New Inward Entry (Purchase)</h2></div>
        <div className="panel-body form-stack">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}

          <div className="customer-grid">
            {Object.entries({
              name: 'Sundry Creditor Name',
              address: 'Address',
              gstin: 'GST Number',
              phone: 'Phone Number',
              invoice_no: 'Supplier Invoice No',
              invoice_date: 'Invoice Date'
            }).map(([field, label]) => (
              <label key={field}>
                <span className="field-label">{label}</span>
                <input
                  className="field"
                  type={field === 'invoice_date' ? 'date' : 'text'}
                  value={supplier[field]}
                  onChange={(event) => updateSupplier(field, field === 'gstin' ? event.target.value.toUpperCase() : event.target.value)}
                />
              </label>
            ))}
          </div>

          <div className="summary-band">
            <div className="segmented two">
              <button type="button" className={taxType === 'LOCAL' ? 'active' : ''} onClick={() => setTaxType('LOCAL')}>GST Local</button>
              <button type="button" className={taxType === 'INTERSTATE' ? 'active' : ''} onClick={() => setTaxType('INTERSTATE')}>IGST Bill</button>
            </div>
            <div className="segmented two">
              <button type="button" className={paymentMode === 'Credit' ? 'active' : ''} onClick={() => setPaymentMode('Credit')}>Credit</button>
              <button type="button" className={paymentMode === 'Cash' ? 'active' : ''} onClick={() => setPaymentMode('Cash')}>Cash</button>
            </div>
            <span className="muted">
              {paymentMode === 'Credit' ? 'Credit purchase posts to supplier ledger.' : 'Cash purchase posts as cash purchase, not supplier outstanding.'}
            </span>
          </div>

          <section className="bulk-edit-box">
            <div className="bulk-edit-toolbar">
              <label className="secondary-button file-button">
                Scan Invoice Image
                <input type="file" accept="image/*" onChange={handleInvoiceImage} />
              </label>
            </div>
            {isOcrRunning && <div className="change-box">Reading invoice image... {ocrProgress}</div>}
            <div className="muted">
              Review before saving. Scanned rows only fill the purchase table; stock updates happen only after Save Inward.
            </div>
          </section>

          <div className="inward-table-wrap">
            <table className="product-table inward-entry-table">
              <thead>
                <tr>
                  <th>S.No</th><th>Barcode</th><th>Product<br />Name</th><th>HSN</th><th>MRP</th><th>Purchase<br />Rate</th>
                  <th>Batch<br />No</th><th>Expiry<br />Date</th>
                  <th>
                    <div className="column-mode-header">
                      <span>Discount</span>
                      <select className="select mini-select" value={discountType} onChange={(event) => setDiscountType(event.target.value)}>
                        <option value="PERCENT">%</option>
                        <option value="VALUE">Rs</option>
                      </select>
                    </div>
                  </th>
                  <th>
                    <div className="column-mode-header">
                      <span>Scheme</span>
                      <select className="select mini-select" value={schemeType} onChange={(event) => setSchemeType(event.target.value)}>
                        <option value="PERCENT">%</option>
                        <option value="VALUE">Rs</option>
                      </select>
                    </div>
                  </th>
                  <th>Free<br />Qty</th><th>Qty</th><th>GST%</th>
                  {taxType === 'LOCAL' && <><th>CGST<br />Amount</th><th>SGST<br />Amount</th></>}
                  {taxType === 'INTERSTATE' && <th>IGST<br />Amount</th>}
                  <th>Taxable<br />Amount</th><th>Total<br />Amount</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  const calculated = calculateInwardLine(line, taxType, discountType, schemeType);

                  return (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>
                        <div className="inline-field-action">
                          <input className="field" value={line.barcode} onChange={(event) => updateLine(index, 'barcode', event.target.value.toUpperCase())} />
                          <button className="secondary-button" type="button" onClick={() => fillProduct(index)}>Find</button>
                        </div>
                      </td>
                      <td><input className="field" value={line.product} onChange={(event) => updateLine(index, 'product', event.target.value)} /></td>
                      <td><input className="field compact-number-field" value={line.hsn_code} onChange={(event) => updateLine(index, 'hsn_code', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.mrp} onChange={(event) => updateLine(index, 'mrp', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.price} onChange={(event) => updateLine(index, 'price', event.target.value)} /></td>
                      <td><input className="field compact-number-field" value={line.batch_no} onChange={(event) => updateLine(index, 'batch_no', event.target.value.toUpperCase())} /></td>
                      <td><input className="field compact-number-field" type="date" value={line.expiry_date} onChange={(event) => updateLine(index, 'expiry_date', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.discount} onChange={(event) => updateLine(index, 'discount', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.scheme} onChange={(event) => updateLine(index, 'scheme', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.free} onChange={(event) => updateLine(index, 'free', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={line.qty} onChange={(event) => updateLine(index, 'qty', event.target.value)} /></td>
                      <td>
                        <select className="select gst-select" value={normalizeGstPercent(line.gst_percent)} onChange={(event) => updateLine(index, 'gst_percent', event.target.value)}>
                          <option value="0">0%</option>
                          <option value="3">3%</option>
                          <option value="5">5%</option>
                          <option value="12">12%</option>
                          <option value="18">18%</option>
                          <option value="28">28%</option>
                          <option value="40">40%</option>
                        </select>
                      </td>
                      {taxType === 'LOCAL' && <><td>{formatMoney(calculated.cgst)}</td><td>{formatMoney(calculated.sgst)}</td></>}
                      {taxType === 'INTERSTATE' && <td>{formatMoney(calculated.igst)}</td>}
                      <td>
                        <input
                          className="field compact-number-field"
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.last_amount_input === 'TAXABLE' && line.taxable_amount !== '' ? line.taxable_amount : calculated.taxable.toFixed(2)}
                          onChange={(event) => updateLine(index, 'taxable_amount', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="field compact-number-field"
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.last_amount_input === 'TOTAL' && line.total_amount !== '' ? line.total_amount : calculated.amount.toFixed(2)}
                          onChange={(event) => updateLine(index, 'total_amount', event.target.value)}
                        />
                      </td>
                      <td><button className="danger-button" onClick={() => removeRow(index)}>Del</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="summary-band">
            <span>Items: <strong>{lines.length}</strong></span>
            <span>Total Qty: <strong>{totals.qty}</strong></span>
            <span>Discount + Scheme: <strong>{formatMoney(totals.discount)}</strong></span>
            <span>Taxable: <strong>{formatMoney(totals.taxable)}</strong></span>
            {taxType === 'LOCAL' && <><span>CGST: <strong>{formatMoney(totals.cgst)}</strong></span><span>SGST: <strong>{formatMoney(totals.sgst)}</strong></span></>}
            {taxType === 'INTERSTATE' && <span>IGST: <strong>{formatMoney(totals.igst)}</strong></span>}
            <span>Grand Total: <strong>{formatMoney(totals.total)}</strong></span>
            <button className="secondary-button" onClick={addRow}>Add Row</button>
            <button className="primary-button compact-primary" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save Inward'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header green"><h2 className="panel-title">Inward Bills Ledger</h2></div>
        <div className="panel-body form-stack">
          <form className="history-search-row inward-history-filters" onSubmit={(event) => { event.preventDefault(); loadRecentInwards(); }}>
            <label>
              <span className="field-label">From</span>
              <input className="field" type="date" value={historyFilters.from} onChange={(event) => updateHistoryFilter('from', event.target.value)} />
            </label>
            <label>
              <span className="field-label">To</span>
              <input className="field" type="date" value={historyFilters.to} onChange={(event) => updateHistoryFilter('to', event.target.value)} />
            </label>
            <label>
              <span className="field-label">Supplier</span>
              <input className="field" value={historyFilters.supplier} onChange={(event) => updateHistoryFilter('supplier', event.target.value)} />
            </label>
            <label>
              <span className="field-label">Invoice / Inward No</span>
              <input className="field" value={historyFilters.invoice} onChange={(event) => updateHistoryFilter('invoice', event.target.value)} />
            </label>
            <button className="primary-button compact-primary" type="submit">Search</button>
            <button className="secondary-button" type="button" onClick={resetHistoryDatesToToday}>Today</button>
            <button className="secondary-button" type="button" onClick={clearHistoryFilters}>Clear</button>
          </form>
          <table className="history-table">
            <thead>
              <tr><th>S.No</th><th>Inward No</th><th>Supplier</th><th>Invoice</th><th>Payment</th><th>Tax Type</th><th>Items</th><th>Qty</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Total</th><th>Created</th><th>Action</th></tr>
            </thead>
            <tbody>
              {recentInwards.length === 0 ? (
                <tr><td colSpan="15">No inward entries found.</td></tr>
              ) : (
                recentInwards.map((entry) => (
                  <tr key={entry.id || entry.inward_no}>
                    <td><strong>{entry.id}</strong></td>
                    <td className="mono">{entry.inward_no}</td>
                    <td>
                      <button className="link-button" type="button" disabled={isLoadingInward} onClick={() => handleViewInward(entry)}>
                        {entry.supplier_name}
                      </button>
                    </td>
                    <td>{entry.supplier_invoice_no || '-'}</td>
                    <td>{entry.payment_mode || 'Credit'}</td>
                    <td>{entry.tax_type === 'INTERSTATE' ? 'IGST' : 'GST Local'}</td>
                    <td>{entry.item_count}</td>
                    <td>{entry.total_qty}</td>
                    <td>{formatMoney(entry.taxable_total)}</td>
                    <td>{formatMoney(entry.total_cgst)}</td>
                    <td>{formatMoney(entry.total_sgst)}</td>
                    <td>{formatMoney(entry.total_igst)}</td>
                    <td><strong>{formatMoney(entry.grand_total)}</strong></td>
                    <td>{formatDateTime(entry.created_at)}</td>
                    <td>
                      <button className="secondary-button" type="button" disabled={isLoadingInward} onClick={() => handleViewInward(entry)}>
                        View / Print
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {viewedInward && (
        <div className="modal-backdrop">
          <div className="modal inward-view-modal">
            <div className="panel-header green">
              <h2 className="panel-title">Inward Bill S.No {viewedInward.entry.id}</h2>
              <div className="actions-row">
                <button className="secondary-button" type="button" onClick={handlePrintInward}>Print</button>
                <button className="secondary-button" type="button" onClick={() => setViewedInward(null)}>Close</button>
              </div>
            </div>
            <div className="panel-body">
              <InwardPrintSheet inward={viewedInward} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InwardPrintSheet({ inward }) {
  const { entry, items } = inward;
  const isInterstate = entry.tax_type === 'INTERSTATE';

  return (
    <div className="inward-print-area">
      <div className="inward-print-title">
        <h1>Purchase Inward Bill</h1>
        <strong>{isInterstate ? 'IGST Purchase' : 'GST Local Purchase'}</strong>
      </div>
      <div className="inward-print-meta">
        <div>
          <strong>S.No: {entry.id}</strong>
          <span>Inward No: {entry.inward_no}</span>
          <span>Created: {formatDateTime(entry.created_at)}</span>
          <span>Entered By: {entry.created_by || '-'}</span>
        </div>
        <div>
          <strong>Supplier</strong>
          <span>{entry.supplier_name}</span>
          <span>{entry.supplier_address || '-'}</span>
          <span>GSTIN: {entry.supplier_gstin || '-'}</span>
          <span>Phone: {entry.supplier_phone || '-'}</span>
        </div>
        <div>
          <strong>Supplier Invoice</strong>
          <span>No: {entry.supplier_invoice_no || '-'}</span>
          <span>Date: {formatDate(entry.supplier_invoice_date)}</span>
          <span>Payment: {entry.payment_mode || 'Credit'}</span>
          <span>Tax Type: {isInterstate ? 'IGST' : 'CGST + SGST'}</span>
        </div>
      </div>
      <table className="inward-print-table">
        <thead>
          <tr>
            <th>S.No</th><th>Barcode</th><th>Product</th><th>HSN</th><th>MRP</th><th>Rate</th><th>Batch</th><th>Expiry</th><th>Disc</th><th>Scheme</th><th>Free</th><th>Qty</th><th>GST%</th>
            {isInterstate ? <th>IGST</th> : <><th>CGST</th><th>SGST</th></>}
            <th>Taxable</th><th>Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id}>
              <td>{index + 1}</td>
              <td>{item.barcode}</td>
              <td>{item.product_name}</td>
              <td>{item.hsn_code || '-'}</td>
              <td>{formatMoney(item.mrp)}</td>
              <td>{formatMoney(item.purchase_price)}</td>
              <td>{item.batch_no || '-'}</td>
              <td>{formatDate(item.expiry_date)}</td>
              <td>{formatMoney(item.discount_amount)}</td>
              <td>{formatMoney(item.scheme_amount)}</td>
              <td>{item.free_qty}</td>
              <td>{item.quantity}</td>
              <td>{toNumber(item.gst_percent).toFixed(2)}%</td>
              {isInterstate ? <td>{formatMoney(item.igst_amount)}</td> : <><td>{formatMoney(item.cgst_amount)}</td><td>{formatMoney(item.sgst_amount)}</td></>}
              <td>{formatMoney(item.taxable_amount)}</td>
              <td><strong>{formatMoney(item.total_amount)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inward-print-summary">
        <span>Items: <strong>{entry.item_count}</strong></span>
        <span>Total Qty: <strong>{entry.total_qty}</strong></span>
        <span>Taxable: <strong>{formatMoney(entry.taxable_total)}</strong></span>
        {!isInterstate && <span>CGST: <strong>{formatMoney(entry.total_cgst)}</strong></span>}
        {!isInterstate && <span>SGST: <strong>{formatMoney(entry.total_sgst)}</strong></span>}
        {isInterstate && <span>IGST: <strong>{formatMoney(entry.total_igst)}</strong></span>}
        <span>Grand Total: <strong>{formatMoney(entry.grand_total)}</strong></span>
      </div>
      <div className="inward-print-signatures">
        <span>Checked By</span>
        <span>Store Incharge Signature</span>
        <span>Authorised Signature</span>
      </div>
    </div>
  );
}
