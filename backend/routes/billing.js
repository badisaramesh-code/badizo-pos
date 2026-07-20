const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { writeAuditLog } = require('../services/auditService');
const {
  allocateInvoiceNo,
  ensureSequenceRow,
  formatInvoiceNo,
  getCounterCount,
  getFinancialYear,
  normalizeCounterNo
} = require('../services/invoiceNumberService');
const { normalizePaymentMode, normalizePaymentSplits } = require('../services/paymentService');
const { sendBillSms } = require('../services/smsService');
const { sendBillWhatsApp } = require('../services/whatsappService');
const { logError, logInfo } = require('../services/logger');
const { normalizePhone, parseMoney } = require('../utils/formatters');
const { moneyToPaise, paiseToMoney, parseCurrency } = require('../utils/money');

function formatReturnNo() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');
  return `SR-${stamp}`;
}

function nextIsoDate(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateText;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + 1
  ));
  return date.toISOString().slice(0, 10);
}

async function getLoyaltySettings(connection) {
  const defaults = {
    earnSaleAmount: 100,
    earnPoints: 10,
    redeemPoints: 10,
    redeemAmount: 0.5
  };
  const [rows] = await connection.query(
    `SELECT setting_key, setting_value
     FROM app_settings
     WHERE setting_key IN ('loyalty_enabled', 'loyalty_earn_sale_amount', 'loyalty_earn_points', 'loyalty_redeem_points', 'loyalty_redeem_amount')`
  );
  const settings = rows.reduce((acc, row) => {
    acc[row.setting_key] = Number(row.setting_value);
    return acc;
  }, {});
  return {
    enabled: Number(settings.loyalty_enabled || 0) === 1,
    earnSaleAmount: settings.loyalty_earn_sale_amount > 0 ? settings.loyalty_earn_sale_amount : defaults.earnSaleAmount,
    earnPoints: settings.loyalty_earn_points > 0 ? settings.loyalty_earn_points : defaults.earnPoints,
    redeemPoints: settings.loyalty_redeem_points > 0 ? settings.loyalty_redeem_points : defaults.redeemPoints,
    redeemAmount: settings.loyalty_redeem_amount > 0 ? settings.loyalty_redeem_amount : defaults.redeemAmount
  };
}

function calculateEarnedLoyaltyPoints(grandTotal, loyaltySettings) {
  const amount = parseMoney(grandTotal);
  if (amount <= 0 || loyaltySettings.earnSaleAmount <= 0 || loyaltySettings.earnPoints <= 0) return 0;
  return Math.floor(amount / loyaltySettings.earnSaleAmount) * loyaltySettings.earnPoints;
}

function calculateLoyaltyRedeemAmount(points, loyaltySettings) {
  const redeemPoints = Math.floor(parseMoney(points));
  if (redeemPoints <= 0 || loyaltySettings.redeemPoints <= 0 || loyaltySettings.redeemAmount <= 0) return 0;
  return (redeemPoints / loyaltySettings.redeemPoints) * loyaltySettings.redeemAmount;
}

async function awardLoyaltyPoints(connection, invoiceNo, customerName, customerPhone, grandTotal, user, loyaltySettings) {
  const phone = normalizePhone(customerPhone);
  if (!phone || phone.length < 10) return null;

  const points = loyaltySettings.enabled ? calculateEarnedLoyaltyPoints(grandTotal, loyaltySettings) : 0;
  await connection.query(
    `INSERT INTO customers (customer_name, phone, loyalty_points, total_spent, visit_count, last_visit_at)
     VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       customer_name = VALUES(customer_name),
       loyalty_points = loyalty_points + VALUES(loyalty_points),
       total_spent = total_spent + VALUES(total_spent),
       visit_count = visit_count + 1,
       last_visit_at = CURRENT_TIMESTAMP`,
    [customerName || 'Walk-in Customer', phone, points, parseMoney(grandTotal)]
  );

  const [rows] = await connection.query(`SELECT id, loyalty_points FROM customers WHERE phone = ? LIMIT 1`, [phone]);
  const customerId = rows[0]?.id;
  if (customerId && points > 0) {
    await connection.query(
      `INSERT INTO loyalty_transactions (customer_id, invoice_no, points_delta, transaction_type, note)
       VALUES (?, ?, ?, 'EARN', ?)`,
      [customerId, invoiceNo, points, `Earned on invoice ${invoiceNo}`]
    );
  }

  await writeAuditLog({
    user,
    action: 'LOYALTY_POINTS_EARNED',
    entityType: 'CUSTOMER',
    entityId: phone,
    details: { invoiceNo, points, grandTotal: parseMoney(grandTotal) },
    connection
  });

  return { phone, points, balance: Number(rows[0]?.loyalty_points || 0) };
}

async function redeemLoyaltyPoints(connection, invoiceNo, customerPhone, requestedPoints, payableBeforeRedeem, loyaltySettings) {
  const phone = normalizePhone(customerPhone);
  const points = Math.floor(parseMoney(requestedPoints));
  if (!loyaltySettings.enabled) return { phone, points: 0, amount: 0 };
  if (!phone || phone.length < 10 || points <= 0) return { phone, points: 0, amount: 0 };

  const [rows] = await connection.query(
    `SELECT id, loyalty_points
     FROM customers
     WHERE phone = ?
     LIMIT 1
     FOR UPDATE`,
    [phone]
  );
  const customer = rows[0];
  if (!customer) throw new Error('Customer loyalty account not found for redemption.');

  const currentPoints = Math.floor(parseMoney(customer.loyalty_points));
  if (points > currentPoints) {
    throw new Error(`Only ${currentPoints} loyalty points available.`);
  }

  const amount = Math.min(calculateLoyaltyRedeemAmount(points, loyaltySettings), parseMoney(payableBeforeRedeem));
  if (amount <= 0) return { phone, points: 0, amount: 0, balance: currentPoints };

  await connection.query(
    `UPDATE customers
     SET loyalty_points = loyalty_points - ?
     WHERE id = ? AND loyalty_points >= ?`,
    [points, customer.id, points]
  );
  await connection.query(
    `INSERT INTO loyalty_transactions (customer_id, invoice_no, points_delta, transaction_type, note)
     VALUES (?, ?, ?, 'REDEEM', ?)`,
    [customer.id, invoiceNo, -points, `Redeemed on invoice ${invoiceNo}`]
  );

  return { phone, points, amount, balance: currentPoints - points };
}

function requestedCounterForUser(user, requestedCounterNo) {
  if (user?.role === 'COUNTER') {
    return user.counter_no || 1;
  }
  return requestedCounterNo;
}

function billingCounterLabel(user, counterNo) {
  const normalizedCounter = Number.parseInt(counterNo, 10) || 1;
  const username = String(user?.username || '').trim().toLowerCase();
  const usernameSystemMatch = username.match(/^counter([1-6])$/);
  const systemNo = Number.parseInt(user?.system_no || user?.login_counter_no || usernameSystemMatch?.[1], 10) || 0;
  if (user?.role === 'COUNTER' && systemNo > 0) {
    return `S${systemNo}/Counter${normalizedCounter}`;
  }
  if (username === 'server' || user?.role === 'SERVER') {
    return `SER/Counter${normalizedCounter}`;
  }
  const adminMatch = username.match(/^admin(\d+)$/);
  if (adminMatch) {
    return `AD${adminMatch[1]}/Counter${normalizedCounter}`;
  }
  if (username === 'admin' || user?.role === 'ADMIN') {
    return `AD/Counter${normalizedCounter}`;
  }
  return `Counter ${normalizedCounter}`;
}

function billingCounterMatches(savedCounter, counterNo) {
  const text = String(savedCounter || '').trim().toLowerCase();
  const normalizedCounter = Number.parseInt(counterNo, 10) || 1;
  return !text || text === `counter ${normalizedCounter}` || text === `counter${normalizedCounter}` || text.endsWith(`/counter${normalizedCounter}`);
}

function enforceSavedStateCounter(user, savedState, counterNo) {
  if (user?.role !== 'COUNTER') return savedState;
  return { ...savedState, counterNo };
}

async function consumeBatchStock(connection, invoiceItemId, invoiceNo, barcode, quantity) {
  let remaining = parseMoney(quantity);
  const allocations = [];
  if (remaining <= 0) return allocations;

  const [batches] = await connection.query(
    `SELECT id, batch_no, expiry_date, quantity_available
     FROM product_batches
     WHERE barcode = ? AND quantity_available > 0
     ORDER BY
       CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
       expiry_date ASC,
       id ASC
     FOR UPDATE`,
    [barcode]
  );

  for (const batch of batches) {
    if (remaining <= 0) break;
    const available = parseMoney(batch.quantity_available);
    const deductQty = Math.min(available, remaining);
    if (deductQty <= 0) continue;

    await connection.query(
      `UPDATE product_batches
       SET quantity_available = quantity_available - ?
       WHERE id = ? AND quantity_available >= ?`,
      [deductQty, batch.id, deductQty]
    );
    await connection.query(
      `INSERT INTO invoice_item_batches
       (invoice_item_id, invoice_no, barcode, batch_no, expiry_date, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [invoiceItemId, invoiceNo, barcode, batch.batch_no || '', batch.expiry_date || null, deductQty]
    );
    allocations.push({
      barcode,
      batch_no: batch.batch_no || '',
      expiry_date: batch.expiry_date || null,
      quantity: deductQty
    });
    remaining -= deductQty;
  }

  return allocations;
}

async function applyBatchFreeOffers(connection, invoiceNo, batchAllocations) {
  const freeLines = [];

  for (const allocation of batchAllocations) {
    const saleQty = parseMoney(allocation.quantity);
    if (!allocation.barcode || saleQty <= 0) continue;

    const [offers] = await connection.query(
      `SELECT id, free_barcode, free_product_name, free_qty_per_sale, free_qty_remaining
       FROM batch_free_offers
       WHERE trigger_barcode = ?
         AND trigger_batch_no = ?
         AND (trigger_expiry_date <=> ?)
         AND is_active = 1
         AND free_qty_remaining > 0
       ORDER BY id ASC
       FOR UPDATE`,
      [allocation.barcode, allocation.batch_no || '', allocation.expiry_date || null]
    );

    for (const offer of offers) {
      if (!String(offer.free_product_name || '').trim()) continue;
      const perSale = Math.max(parseMoney(offer.free_qty_per_sale), 0);
      const intendedQty = perSale * saleQty;
      const freeQty = Math.min(intendedQty, parseMoney(offer.free_qty_remaining));
      if (freeQty <= 0) continue;

      await connection.query(
        `UPDATE batch_free_offers
         SET free_qty_remaining = free_qty_remaining - ?,
             is_active = CASE WHEN free_qty_remaining - ? <= 0 THEN 0 ELSE is_active END
         WHERE id = ? AND free_qty_remaining >= ?`,
        [freeQty, freeQty, offer.id, freeQty]
      );

      const [freeItemResult] = await connection.query(
        `INSERT INTO invoice_items
         (invoice_no, barcode, product_name, quantity, sale_price, gst_percent, cgst_amount, sgst_amount, igst_amount, is_free_bonus, free_offer_id)
         VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 1, ?)`,
        [invoiceNo, offer.free_barcode, offer.free_product_name, freeQty, offer.id]
      );

      freeLines.push({
        barcode: offer.free_barcode,
        product_name: offer.free_product_name,
        quantity: freeQty,
        sale_price: 0,
        gst_percent: 0,
        is_free_bonus: true,
        trigger_barcode: allocation.barcode,
        trigger_batch_no: allocation.batch_no || ''
      });
    }
  }

  return freeLines;
}

async function applyProductFreePromotions(connection, invoiceNo, soldItems) {
  const freeLines = [];

  for (const sold of soldItems) {
    const saleQty = parseMoney(sold.quantity);
    if (!sold.barcode || saleQty <= 0) continue;

    const [promoRows] = await connection.query(
      `SELECT barcode, free_promo_enabled, free_promo_name, free_promo_qty_per_sale,
              free_promo_total_qty, free_promo_remaining_qty
       FROM products
       WHERE barcode = ?
       FOR UPDATE`,
      [sold.barcode]
    );
    const promo = promoRows[0];
    if (!promo?.free_promo_enabled || !String(promo.free_promo_name || '').trim()) continue;

    const perSale = Math.max(parseMoney(promo.free_promo_qty_per_sale), 0);
    const intendedQty = perSale * saleQty;
    if (intendedQty <= 0) continue;

    const hasLimit = parseMoney(promo.free_promo_total_qty) > 0;
    const freeQty = hasLimit ? Math.min(intendedQty, parseMoney(promo.free_promo_remaining_qty)) : intendedQty;
    if (freeQty <= 0) continue;

    if (hasLimit) {
      await connection.query(
        `UPDATE products
         SET free_promo_remaining_qty = free_promo_remaining_qty - ?,
             free_promo_enabled = CASE WHEN free_promo_remaining_qty - ? <= 0 THEN 0 ELSE free_promo_enabled END
         WHERE barcode = ? AND free_promo_remaining_qty >= ?`,
        [freeQty, freeQty, sold.barcode, freeQty]
      );
    }

    await connection.query(
      `INSERT INTO invoice_items
       (invoice_no, barcode, product_name, quantity, sale_price, gst_percent, cgst_amount, sgst_amount, igst_amount, is_free_bonus, free_offer_id)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 1, NULL)`,
      [invoiceNo, sold.barcode, promo.free_promo_name, freeQty]
    );

    freeLines.push({
      barcode: sold.barcode,
      product_name: promo.free_promo_name,
      quantity: freeQty,
      sale_price: 0,
      gst_percent: 0,
      is_free_bonus: true,
      trigger_barcode: sold.barcode
    });
  }

  return freeLines;
}

async function restoreBatchStock(connection, invoiceItemId, quantity) {
  let remaining = parseMoney(quantity);
  if (remaining <= 0) return;

  const [batchRows] = await connection.query(
    `SELECT id, barcode, batch_no, expiry_date, quantity, returned_qty
     FROM invoice_item_batches
     WHERE invoice_item_id = ? AND returned_qty < quantity
     ORDER BY id DESC
     FOR UPDATE`,
    [invoiceItemId]
  );

  for (const row of batchRows) {
    if (remaining <= 0) break;
    const restoreQty = Math.min(parseMoney(row.quantity) - parseMoney(row.returned_qty), remaining);
    if (restoreQty <= 0) continue;

    await connection.query(
      `UPDATE product_batches
       SET quantity_available = quantity_available + ?
       WHERE barcode = ? AND batch_no = ? AND (expiry_date <=> ?)`,
      [restoreQty, row.barcode, row.batch_no || '', row.expiry_date || null]
    );
    await connection.query(
      `UPDATE invoice_item_batches
       SET returned_qty = returned_qty + ?
       WHERE id = ?`,
      [restoreQty, row.id]
    );
    remaining -= restoreQty;
  }
}

async function restoreFreeOfferQuantity(connection, invoiceItemId, quantity) {
  const [rows] = await connection.query(
    `SELECT free_offer_id, is_free_bonus
     FROM invoice_items
     WHERE id = ?
     LIMIT 1`,
    [invoiceItemId]
  );
  const item = rows[0];
  if (!item?.is_free_bonus || !item.free_offer_id) return;

  await connection.query(
    `UPDATE batch_free_offers
     SET free_qty_remaining = free_qty_remaining + ?,
         is_active = 1
     WHERE id = ?`,
    [parseMoney(quantity), item.free_offer_id]
  );
}

async function restoreProductFreePromotionQuantity(connection, invoiceItemId, quantity) {
  const [rows] = await connection.query(
    `SELECT barcode, free_offer_id, is_free_bonus
     FROM invoice_items
     WHERE id = ?
     LIMIT 1`,
    [invoiceItemId]
  );
  const item = rows[0];
  if (!item?.is_free_bonus || item.free_offer_id) return;

  await connection.query(
    `UPDATE products
     SET free_promo_remaining_qty = free_promo_remaining_qty + ?,
         free_promo_enabled = CASE WHEN free_promo_total_qty > 0 THEN 1 ELSE free_promo_enabled END
     WHERE barcode = ? AND free_promo_total_qty > 0`,
    [parseMoney(quantity), item.barcode]
  );
}

function createCheckoutTimer() {
  const start = Date.now();
  let last = start;
  const steps = [];

  return {
    mark(label) {
      const now = Date.now();
      steps.push({ label, ms: now - last, totalMs: now - start });
      last = now;
    },
    totalMs() {
      return Date.now() - start;
    },
    steps
  };
}

router.get('/invoice/next', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const counterCount = await getCounterCount();
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, req.query.counter_no), counterCount);
    const financialYear = getFinancialYear();

    await ensureSequenceRow(db, financialYear, 0);
    const [rows] = await db.query(
      `SELECT next_number
       FROM invoice_sequences
       WHERE financial_year = ? AND counter_no = 0`,
      [financialYear]
    );

    const sequenceNo = Number(rows[0]?.next_number || 1);
    res.json({
      invoice_no: formatInvoiceNo(financialYear, counterNo, sequenceNo),
      financial_year: financialYear,
      counter_no: counterNo,
      counter_count: counterCount,
      sequence_no: sequenceNo,
      preview: true
    });
  } catch (err) {
    console.error('Invoice preview failed:', err.message);
    res.status(500).json({ error: 'Unable to preview invoice number.' });
  }
});

router.post('/checkout', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const connection = await db.getConnection();
  const checkoutTimer = createCheckoutTimer();
  let invoiceNo = '';

  try {
    await connection.query('SET SESSION innodb_lock_wait_timeout = 5');
    checkoutTimer.mark('set-lock-timeout');

    const {
      counter_no,
      customer_name,
      customer_address,
      customer_phone,
      items,
      sub_total,
      gst_total,
      grand_total,
      payment_mode,
      payment_status,
      payment_reference,
      payment_splits,
      cash_received,
      change_returned,
      transaction_type,
      billing_tier,
      tax_type,
      customer_company_name,
      customer_gstin,
      total_cgst,
      total_sgst,
      total_igst,
      exchange_items,
      exchange_total,
      loyalty_base_total,
      loyalty_redeem_points,
      checkout_request_id
    } = req.body;

    const checkoutRequestId = String(checkout_request_id || '').trim();
    if (checkoutRequestId && !/^[A-Za-z0-9_-]{12,64}$/.test(checkoutRequestId)) {
      return res.status(400).json({ error: 'A valid checkout request ID is required.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart must contain at least one item.' });
    }

    const [existingCheckoutRows] = checkoutRequestId
      ? await connection.query(
        `SELECT invoice_no, grand_total, billing_counter
         FROM invoices
         WHERE checkout_request_id = ?
         LIMIT 1`,
        [checkoutRequestId]
      )
      : [[]];
    if (existingCheckoutRows.length) {
      const existing = existingCheckoutRows[0];
      const requestedTotal = Math.round(parseCurrency(grand_total));
      if (Math.abs(moneyToPaise(existing.grand_total) - moneyToPaise(requestedTotal)) > 1) {
        return res.status(409).json({ error: 'This checkout was already saved with a different total.' });
      }
      return res.json({
        success: true,
        duplicate_prevented: true,
        message: 'Invoice was already committed successfully.',
        invoice_no: existing.invoice_no,
        free_items: []
      });
    }

    await connection.beginTransaction();
    checkoutTimer.mark('begin-transaction');
    const counterCount = await getCounterCount(connection);
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, counter_no), counterCount);
    const counterLabel = billingCounterLabel(req.user, counterNo);
    const allocatedInvoice = await allocateInvoiceNo(connection, counterNo);
    invoiceNo = allocatedInvoice.invoiceNo;
    checkoutTimer.mark('invoice-allocated');
    const normalizedExchangeItems = Array.isArray(exchange_items)
      ? exchange_items
        .map((item) => ({
          barcode: String(item.barcode || '').trim(),
          product_name: String(item.product_name || '').trim(),
          hsn_code: String(item.hsn_code || '').trim(),
          quantity: parseMoney(item.quantity) || 0,
          sale_price: parseMoney(item.sale_price),
          gst_percent: parseMoney(item.gst_percent),
          line_total: (parseMoney(item.sale_price) * (parseMoney(item.quantity) || 0))
        }))
        .filter((item) => item.barcode && item.quantity > 0)
      : [];
    const exchangeTotal = normalizedExchangeItems.reduce((total, item) => total + item.line_total, 0) || parseMoney(exchange_total);
    const loyaltySettings = await getLoyaltySettings(connection);
    checkoutTimer.mark('loyalty-settings');
    const saleGrandBeforeRedeem = parseCurrency(loyalty_base_total || grand_total);
    const loyaltyRedeemResult = await redeemLoyaltyPoints(
      connection,
      invoiceNo,
      customer_phone || '',
      loyalty_redeem_points,
      saleGrandBeforeRedeem,
      loyaltySettings
    );
    checkoutTimer.mark('loyalty-redeem');
    const normalizedPaymentMode = normalizePaymentMode(payment_mode);
    const grandTotal = Math.round(parseCurrency(saleGrandBeforeRedeem - loyaltyRedeemResult.amount));
    const paymentSplits = normalizePaymentSplits(normalizedPaymentMode, payment_splits, grandTotal, payment_reference);
    const paidTotalPaise = paymentSplits.reduce((sum, row) => sum + moneyToPaise(row.amount), 0);
    const tenderTotalPaise = normalizedPaymentMode === 'Mixed' ? moneyToPaise(cash_received || paiseToMoney(paidTotalPaise)) : paidTotalPaise;
    const grandTotalPaise = moneyToPaise(grandTotal);
    if (normalizedPaymentMode === 'Cash' && moneyToPaise(cash_received) < grandTotalPaise) {
      throw new Error('Cash received must be equal to or greater than the bill total.');
    }
    const changeReturned = paiseToMoney(Math.max(tenderTotalPaise - grandTotalPaise, 0));
    const referenceText = normalizedPaymentMode === 'Mixed'
      ? paymentSplits
        .filter((row) => row.payment_reference)
        .map((row) => `${row.payment_mode}:${row.payment_reference}`)
        .join(' | ') || null
      : payment_reference || null;

    await connection.query(
      `INSERT INTO invoices
       (invoice_no, checkout_request_id, customer_name, customer_address, customer_phone, sub_total, gst_total, grand_total,
        cash_received, change_returned, payment_mode, payment_status, payment_reference, billing_counter, transaction_type, billing_tier, tax_type,
        customer_company_name, customer_gstin, total_cgst, total_sgst, total_igst, exchange_total, exchange_items_json,
        loyalty_redeemed_points, loyalty_redeemed_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
       [
         invoiceNo,
         checkoutRequestId || null,
         customer_name || 'Walk-in Customer',
        customer_address || null,
        customer_phone || '',
        parseCurrency(sub_total),
        parseCurrency(gst_total),
        grandTotal,
        normalizedPaymentMode === 'Cash' ? parseCurrency(cash_received) : paiseToMoney(tenderTotalPaise),
        normalizedPaymentMode === 'Cash' ? parseCurrency(change_returned) : changeReturned,
        normalizedPaymentMode,
        payment_status || 'PAID',
        referenceText,
        counterLabel,
        transaction_type || 'B2C',
        billing_tier || 'RETAIL',
        tax_type || 'LOCAL',
        customer_company_name || null,
        customer_gstin || null,
        parseCurrency(total_cgst),
        parseCurrency(total_sgst),
        parseCurrency(total_igst),
        parseCurrency(exchangeTotal),
        normalizedExchangeItems.length ? JSON.stringify(normalizedExchangeItems) : null,
        loyaltyRedeemResult.points,
        parseCurrency(loyaltyRedeemResult.amount)
      ]
    );
    checkoutTimer.mark('invoice-inserted');

    for (const payment of paymentSplits) {
      await connection.query(
        `INSERT INTO invoice_payments (invoice_no, payment_mode, amount, payment_reference)
         VALUES (?, ?, ?, ?)`,
        [invoiceNo, payment.payment_mode, payment.amount, payment.payment_reference || null]
      );
    }
    checkoutTimer.mark('payments-inserted');

    const soldBatchAllocations = [];
    const soldItemsForPromotions = [];

    for (const item of items) {
      const quantity = parseMoney(item.quantity) || 1;
      const salePrice = parseMoney(item.sale_price);
      const gstPercent = parseMoney(item.gst_percent);

      if (!item.barcode || quantity <= 0) {
        throw new Error('Every bill line needs a valid barcode and quantity.');
      }

      const lineGrossTotal = salePrice * quantity;
      const taxFactor = gstPercent / (100 + gstPercent);
      const rowTaxValue = lineGrossTotal * taxFactor;
      const isInterstate = (tax_type || 'LOCAL') === 'INTERSTATE';
      const cgst = isInterstate ? 0 : rowTaxValue / 2;
      const sgst = isInterstate ? 0 : rowTaxValue / 2;
      const igst = isInterstate ? rowTaxValue : 0;

      const [stockResult] = await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty - ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [quantity, item.barcode]
      );

      if (stockResult.affectedRows !== 1) {
        throw new Error(`Missing product for barcode ${item.barcode}.`);
      }

      const [invoiceItemResult] = await connection.query(
        `INSERT INTO invoice_items
         (invoice_no, barcode, product_name, hsn_code, quantity, sale_price, gst_percent, cgst_amount, sgst_amount, igst_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceNo,
          item.barcode,
          item.product_name || '',
          String(item.hsn_code || '').trim(),
          quantity,
          salePrice,
          gstPercent,
          cgst,
          sgst,
          igst
        ]
      );

      const allocations = await consumeBatchStock(connection, invoiceItemResult.insertId, invoiceNo, item.barcode, quantity);
      soldBatchAllocations.push(...allocations);
      soldItemsForPromotions.push({ barcode: item.barcode, quantity });
      checkoutTimer.mark(`item-${item.barcode}`);
    }

    const productPromotionFreeItems = await applyProductFreePromotions(connection, invoiceNo, soldItemsForPromotions);
    checkoutTimer.mark('product-promotions');
    const batchFreeItems = await applyBatchFreeOffers(connection, invoiceNo, soldBatchAllocations);
    checkoutTimer.mark('batch-free-offers');
    const freeItems = [...productPromotionFreeItems, ...batchFreeItems];

    for (const item of normalizedExchangeItems) {
      const [stockResult] = await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [item.quantity, item.barcode]
      );

      if (stockResult.affectedRows !== 1) {
        throw new Error(`Exchange product not found for barcode ${item.barcode}.`);
      }
    }
    checkoutTimer.mark('exchange-items');

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_CREATED',
      entityType: 'INVOICE',
      entityId: invoiceNo,
      details: {
        counterNo,
        paymentMode: payment_mode || 'Cash',
        grandTotal,
        itemCount: items.length,
        freeItemCount: freeItems.length,
        exchangeTotal,
        exchangeItemCount: normalizedExchangeItems.length,
        loyaltyRedeemedPoints: loyaltyRedeemResult.points,
        loyaltyRedeemedAmount: loyaltyRedeemResult.amount
      },
      connection
    });
    checkoutTimer.mark('invoice-audit');

    const loyaltyResult = await awardLoyaltyPoints(
      connection,
      invoiceNo,
      customer_name || 'Walk-in Customer',
      customer_phone || '',
      grandTotal,
      req.user,
      loyaltySettings
    );
    checkoutTimer.mark('loyalty-award');

    await connection.commit();
    checkoutTimer.mark('commit');
    if (checkoutTimer.totalMs() > 2000) {
      logInfo('Slow checkout completed', {
        invoiceNo,
        counterNo,
        totalMs: checkoutTimer.totalMs(),
        steps: checkoutTimer.steps
      });
    }
    const notificationDetails = {
      invoiceNo,
      customerName: customer_name || customer_company_name || 'Customer',
      phone: customer_phone || '',
      grandTotal,
      paymentMode: normalizedPaymentMode,
      itemCount: items.length,
      loyalty: loyaltyResult
    };
    Promise.allSettled([
      sendBillSms(notificationDetails),
      sendBillWhatsApp(notificationDetails)
    ]).then(([smsResult, whatsappResult]) => {
      logInfo('Bill notification processed', {
        invoiceNo,
        sms: smsResult.status === 'fulfilled' ? smsResult.value : { sent: false, error: smsResult.reason?.message || String(smsResult.reason || '') },
        whatsapp: whatsappResult.status === 'fulfilled' ? whatsappResult.value : { sent: false, error: whatsappResult.reason?.message || String(whatsappResult.reason || '') }
      });
    }).catch((notificationError) => {
      logError('Bill notification failed', notificationError, { invoiceNo });
    });

    res.json({
      success: true,
      message: 'Invoice committed successfully.',
      invoice_no: invoiceNo,
      financial_year: allocatedInvoice.financialYear,
      counter_no: counterNo,
      sequence_no: allocatedInvoice.sequenceNo,
      free_items: freeItems,
      notifications: { queued: true }
    });
  } catch (err) {
    await connection.rollback();
    checkoutTimer.mark('rollback');
    if (err?.code === 'ER_DUP_ENTRY') {
      const checkoutRequestId = String(req.body?.checkout_request_id || '').trim();
      if (checkoutRequestId) {
        const [savedRows] = await connection.query(
          `SELECT invoice_no FROM invoices WHERE checkout_request_id = ? LIMIT 1`,
          [checkoutRequestId]
        );
        if (savedRows.length) {
          return res.json({
            success: true,
            duplicate_prevented: true,
            message: 'Invoice was already committed successfully.',
            invoice_no: savedRows[0].invoice_no,
            free_items: []
          });
        }
      }
    }
    logError('Checkout rollback', err, {
      invoiceNo,
      totalMs: checkoutTimer.totalMs(),
      steps: checkoutTimer.steps
    });
    console.error('Checkout rollback:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    connection.release();
  }
});

router.get('/invoice/details', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const invoiceNo = String(req.query.invoice_no || '').trim();
  const checkoutRequestId = String(req.query.checkout_request_id || '').trim();
  if (!invoiceNo && !checkoutRequestId) {
    return res.status(400).json({ error: 'Invoice number or checkout request ID is required.' });
  }

  try {
    const [invoiceRows] = checkoutRequestId
      ? await db.query(
        `SELECT *
         FROM invoices
         WHERE checkout_request_id = ?
         LIMIT 1`,
        [checkoutRequestId]
      )
      : await db.query(
        `SELECT *
         FROM invoices
         WHERE invoice_no = ?
         LIMIT 1`,
        [invoiceNo]
      );

    if (!invoiceRows.length) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const [itemRows] = await db.query(
      `SELECT ii.id, ii.invoice_no, ii.barcode, ii.product_name, ii.quantity, ii.sale_price, ii.gst_percent,
              ii.cgst_amount, ii.sgst_amount, ii.igst_amount, ii.is_free_bonus, ii.free_offer_id, ii.returned_qty,
              COALESCE(p.mrp, 0) AS mrp,
              COALESCE(NULLIF(ii.hsn_code, ''), NULLIF(p.hsn_code, ''), '') AS hsn_code,
              COALESCE(p.unit_type, '') AS unit_type
       FROM invoice_items ii
       LEFT JOIN products p ON p.barcode = ii.barcode
       WHERE ii.invoice_no = ?
       ORDER BY ii.id ASC`,
      [invoiceRows[0].invoice_no]
    );

    const [paymentRows] = await db.query(
      `SELECT payment_mode, amount, payment_reference
       FROM invoice_payments
       WHERE invoice_no = ?
       ORDER BY id ASC`,
      [invoiceRows[0].invoice_no]
    );

    res.json({
      invoice: invoiceRows[0],
      items: itemRows,
      payments: paymentRows
    });
  } catch (err) {
    console.error('Invoice details failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch invoice details.' });
  }
});

router.post('/invoice/reprint', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  const printMode = req.body?.print_mode === 'A4' ? 'A4' : 'Thermal';
  if (!invoiceNo) {
    return res.status(400).json({ error: 'Invoice number is required.' });
  }

  try {
    const [result] = await db.query(
      `UPDATE invoices
       SET reprint_count = reprint_count + 1
       WHERE invoice_no = ?`,
      [invoiceNo]
    );

    if (result.affectedRows !== 1) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_REPRINTED',
      entityType: 'INVOICE',
      entityId: invoiceNo,
      details: { print_mode: printMode }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Invoice reprint audit failed:', err.message);
    res.status(500).json({ error: 'Unable to record reprint.' });
  }
});

router.post('/invoice/void', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  const reason = String(req.body?.reason || '').trim();

  if (!invoiceNo || !reason) {
    return res.status(400).json({ error: 'Invoice number and cancel reason are required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [invoiceRows] = await connection.query(
      `SELECT invoice_no, invoice_status, exchange_items_json
       FROM invoices
       WHERE invoice_no = ?
       FOR UPDATE`,
      [invoiceNo]
    );

    const invoice = invoiceRows[0];
    if (!invoice) {
      await connection.rollback();
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    if (invoice.invoice_status === 'CANCELLED') {
      await connection.rollback();
      return res.status(400).json({ error: 'Invoice is already cancelled.' });
    }

    if (invoice.invoice_status === 'RETURNED' || invoice.invoice_status === 'PARTIALLY_RETURNED') {
      await connection.rollback();
      return res.status(400).json({ error: 'Return has already been recorded. Use return report instead of void.' });
    }

    const [items] = await connection.query(
      `SELECT id, barcode, quantity, is_free_bonus, free_offer_id
       FROM invoice_items
       WHERE invoice_no = ?`,
      [invoiceNo]
    );

    for (const item of items) {
      if (!item.is_free_bonus) {
        await connection.query(
          `UPDATE products SET stock_qty = stock_qty + ?, updated_at = CURRENT_TIMESTAMP WHERE barcode = ?`,
          [parseMoney(item.quantity), item.barcode]
        );
        await restoreBatchStock(connection, item.id, item.quantity);
      }
      await restoreFreeOfferQuantity(connection, item.id, item.quantity);
      await restoreProductFreePromotionQuantity(connection, item.id, item.quantity);
    }

    let exchangeItems = [];
    try {
      exchangeItems = Array.isArray(invoice.exchange_items_json)
        ? invoice.exchange_items_json
        : JSON.parse(invoice.exchange_items_json || '[]');
    } catch (err) {
      exchangeItems = [];
    }

    for (const item of exchangeItems) {
      const quantity = parseMoney(item.quantity);
      const barcode = String(item.barcode || '').trim();
      if (!barcode || quantity <= 0) continue;
      await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty - ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [quantity, barcode]
      );
    }

    await connection.query(
      `UPDATE invoices
       SET invoice_status = 'CANCELLED',
           cancel_reason = ?,
           cancelled_by = ?,
           cancelled_at = CURRENT_TIMESTAMP
       WHERE invoice_no = ?`,
      [reason, req.user.username, invoiceNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'INVOICE_CANCELLED',
      entityType: 'INVOICE',
      entityId: invoiceNo,
      details: { reason, restoredLines: items.length },
      connection
    });

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    console.error('Invoice void failed:', err.message);
    res.status(500).json({ error: 'Unable to cancel invoice.' });
  } finally {
    connection.release();
  }
});

router.post('/return', authenticate, authorize('SERVER', 'ADMIN'), async (req, res) => {
  const invoiceNo = String(req.body?.invoice_no || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const refundMode = ['Cash', 'UPI', 'Card', 'Store Credit'].includes(req.body?.refund_mode) ? req.body.refund_mode : 'Cash';
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!invoiceNo || !reason || requestedItems.length === 0) {
    return res.status(400).json({ error: 'Invoice number, return reason, and return items are required.' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    const [invoiceRows] = await connection.query(
      `SELECT invoice_no, invoice_status
       FROM invoices
       WHERE invoice_no = ?
       FOR UPDATE`,
      [invoiceNo]
    );
    const invoice = invoiceRows[0];

    if (!invoice) {
      await connection.rollback();
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    if (invoice.invoice_status === 'CANCELLED' || invoice.invoice_status === 'RETURNED') {
      await connection.rollback();
      return res.status(400).json({ error: `Invoice is ${invoice.invoice_status.toLowerCase()} and cannot be returned.` });
    }

    const returnNo = formatReturnNo();
    let taxableTotal = 0;
    let gstTotal = 0;
    let refundTotal = 0;

    await connection.query(
      `INSERT INTO sales_returns
       (return_no, invoice_no, reason, refund_mode, taxable_total, gst_total, refund_total, created_by)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?)`,
      [returnNo, invoiceNo, reason, refundMode, req.user.username]
    );

    for (const requested of requestedItems) {
      const invoiceItemId = Number.parseInt(requested.invoice_item_id, 10);
      const returnQty = parseMoney(requested.quantity);

      if (!invoiceItemId || returnQty <= 0) continue;

      const [itemRows] = await connection.query(
        `SELECT id, barcode, product_name, quantity, sale_price, gst_percent, returned_qty, is_free_bonus
         FROM invoice_items
         WHERE id = ? AND invoice_no = ?
         FOR UPDATE`,
        [invoiceItemId, invoiceNo]
      );
      const item = itemRows[0];

      if (!item) {
        throw new Error(`Invoice item ${invoiceItemId} not found.`);
      }

      if (item.is_free_bonus) {
        throw new Error('Free counter items cannot be returned in POS return billing.');
      }

      const availableQty = parseMoney(item.quantity) - parseMoney(item.returned_qty);
      if (returnQty > availableQty) {
        throw new Error(`Return quantity for ${item.product_name} cannot exceed ${availableQty}.`);
      }

      const gross = parseMoney(item.sale_price) * returnQty;
      const gstPercent = parseMoney(item.gst_percent);
      const taxable = gross / (1 + gstPercent / 100);
      const gst = gross - taxable;

      taxableTotal += taxable;
      gstTotal += gst;
      refundTotal += gross;

      await connection.query(
        `INSERT INTO sales_return_items
         (return_no, invoice_item_id, barcode, product_name, quantity, sale_price, gst_percent,
          taxable_amount, gst_amount, refund_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnNo,
          invoiceItemId,
          item.barcode,
          item.product_name,
          returnQty,
          item.sale_price,
          item.gst_percent,
          taxable,
          gst,
          gross
        ]
      );

      await connection.query(
        `UPDATE invoice_items
         SET returned_qty = returned_qty + ?
         WHERE id = ?`,
        [returnQty, invoiceItemId]
      );

      await connection.query(
        `UPDATE products
         SET stock_qty = stock_qty + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE barcode = ?`,
        [returnQty, item.barcode]
      );
      await restoreBatchStock(connection, invoiceItemId, returnQty);
    }

    if (refundTotal <= 0) {
      throw new Error('No valid return quantity was entered.');
    }

    await connection.query(
      `UPDATE sales_returns
       SET taxable_total = ?, gst_total = ?, refund_total = ?
       WHERE return_no = ?`,
      [taxableTotal, gstTotal, refundTotal, returnNo]
    );

    const [remainingRows] = await connection.query(
      `SELECT COUNT(*) AS remaining
       FROM invoice_items
       WHERE invoice_no = ? AND is_free_bonus = 0 AND returned_qty < quantity`,
      [invoiceNo]
    );
    const nextStatus = Number(remainingRows[0]?.remaining || 0) === 0 ? 'RETURNED' : 'PARTIALLY_RETURNED';

    await connection.query(
      `UPDATE invoices
       SET invoice_status = ?
       WHERE invoice_no = ?`,
      [nextStatus, invoiceNo]
    );

    await writeAuditLog({
      user: req.user,
      action: 'SALES_RETURN_CREATED',
      entityType: 'SALES_RETURN',
      entityId: returnNo,
      details: { invoiceNo, reason, refundMode, refundTotal },
      connection
    });

    await connection.commit();
    res.json({
      success: true,
      return_no: returnNo,
      invoice_status: nextStatus,
      taxable_total: taxableTotal,
      gst_total: gstTotal,
      refund_total: refundTotal
    });
  } catch (err) {
    await connection.rollback();
    console.error('Sales return failed:', err.message);
    res.status(500).json({ error: err.message || 'Unable to save sales return.' });
  } finally {
    connection.release();
  }
});

router.get('/hold/list', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const search = String(req.query.search || '').trim();
    const paymentMode = String(req.query.payment_mode || '').trim();
    const hasDateRange = from && to;
    const where = [];
    const params = [];

    if (hasDateRange) {
      const start = from <= to ? from : to;
      const end = from <= to ? to : from;
      where.push('DATE(created_at) >= ? AND DATE(created_at) <= ?');
      params.push(start, end);
    }

    if (search) {
      where.push(`(
        invoice_no LIKE ?
        OR customer_name LIKE ?
        OR customer_phone LIKE ?
        OR payment_mode LIKE ?
      )`);
      const searchLike = `%${search}%`;
      params.push(searchLike, searchLike, searchLike, searchLike);
    }

    if (paymentMode === 'Exchange') {
      where.push('exchange_total > 0');
    } else if (['Cash', 'UPI', 'Card', 'Mixed'].includes(paymentMode)) {
      where.push('payment_mode = ?');
      params.push(paymentMode);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = hasDateRange ? 'LIMIT 500' : 'LIMIT 25';
    const [rows] = await db.query(
      `SELECT invoice_no, customer_name, customer_phone, grand_total, cash_received, change_returned, billing_counter,
              payment_status, payment_reference, exchange_total,
              payment_mode, transaction_type, billing_tier, tax_type, invoice_status, reprint_count,
              einvoice_status, einvoice_irn, einvoice_ack_no, ewaybill_status, ewaybill_no, created_at
       FROM invoices
       ${whereSql}
       ORDER BY created_at DESC
       ${limitSql}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('Invoice history fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch invoice history.' });
  }
});

router.post('/hold', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  const {
    hold_token,
    saved_state,
    counter_no,
    customer_name,
    customer_phone,
    bill_total,
    item_count,
    overwrite
  } = req.body;

  if (!hold_token || !saved_state) {
    return res.status(400).json({ error: 'Hold token and saved state are required.' });
  }

  try {
    const counterCount = await getCounterCount();
    const counterNo = normalizeCounterNo(requestedCounterForUser(req.user, counter_no || saved_state.counterNo), counterCount);
    const finalSavedState = enforceSavedStateCounter(req.user, saved_state, counterNo);
    const holdToken = hold_token.trim();
    const [existingRows] = await db.query(
      `SELECT hold_token FROM held_bills WHERE hold_token = ? LIMIT 1`,
      [holdToken]
    );

    if (existingRows.length > 0 && !overwrite) {
      return res.status(409).json({ error: 'A held bill with this token already exists.' });
    }

    await db.query(
      `INSERT INTO held_bills
       (hold_token, counter_no, customer_name, customer_phone, bill_total, item_count, saved_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         counter_no = VALUES(counter_no),
         customer_name = VALUES(customer_name),
         customer_phone = VALUES(customer_phone),
         bill_total = VALUES(bill_total),
         item_count = VALUES(item_count),
         saved_state = VALUES(saved_state),
         updated_at = CURRENT_TIMESTAMP`,
      [
        holdToken,
        counterNo,
        customer_name || finalSavedState.customerName || 'Walk-in Customer',
        customer_phone || finalSavedState.customerPhone || '',
        parseMoney(bill_total),
        Number.parseInt(item_count, 10) || (Array.isArray(finalSavedState.cart) ? finalSavedState.cart.length : 0),
        JSON.stringify(finalSavedState)
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Hold save failed:', err.message);
    res.status(500).json({ error: 'Unable to hold bill.' });
  }
});

router.get('/holds', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    const counterNo = req.user.role === 'COUNTER'
      ? Number(req.user.counter_no || 1)
      : (req.query.counter_no ? Number.parseInt(req.query.counter_no, 10) : null);
    const values = [];
    let whereSql = '';

    if (counterNo) {
      whereSql = 'WHERE counter_no = ?';
      values.push(counterNo);
    }

    const [rows] = await db.query(
      `SELECT hold_token, counter_no, customer_name, customer_phone, bill_total, item_count, saved_state, created_at, updated_at
       FROM held_bills
       ${whereSql}
       ORDER BY updated_at DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    console.error('Hold list fetch failed:', err.message);
    res.status(500).json({ error: 'Unable to fetch held bills.' });
  }
});

router.delete('/hold/:token', authenticate, authorize('SERVER', 'ADMIN', 'COUNTER'), async (req, res) => {
  try {
    await db.query(`DELETE FROM held_bills WHERE hold_token = ?`, [req.params.token]);
    res.json({ success: true });
  } catch (err) {
    console.error('Hold delete failed:', err.message);
    res.status(500).json({ error: 'Unable to remove held bill.' });
  }
});

module.exports = router;
