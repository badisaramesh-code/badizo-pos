import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  approveSensitiveBillingMode,
  checkout,
  createSalesReturn,
  deleteHeldBill,
  fetchHeldBills,
  fetchInvoiceDetails,
  fetchInvoiceHistory,
  fetchNextInvoice,
  fetchSettings,
  getStoredUser,
  holdBill,
  lookupCustomer,
  recordInvoiceReprint,
  saveCustomer,
  voidInvoice,
  searchProducts
} from '../api/client';
import { amountInWords, formatMoney, toNumber } from '../utils/money';
import PrintableInvoice from './PrintableInvoice';

const BILLING_MODES = {
  RETAIL_LOCAL: {
    label: 'GST Retail',
    shortLabel: 'GST Retail',
    tier: 'RETAIL',
    taxType: 'LOCAL',
    transactionType: 'B2C'
  },
  WHOLESALE_LOCAL: {
    label: 'GST Wholesale',
    shortLabel: 'GST Whole',
    tier: 'WHOLESALE',
    taxType: 'LOCAL',
    transactionType: 'B2C'
  },
  RETAIL_IGST: {
    label: 'IGST Retail',
    shortLabel: 'IGST Retail',
    tier: 'RETAIL',
    taxType: 'INTERSTATE',
    transactionType: 'B2C'
  },
  WHOLESALE_IGST: {
    label: 'IGST Wholesale',
    shortLabel: 'IGST Whole',
    tier: 'WHOLESALE',
    taxType: 'INTERSTATE',
    transactionType: 'B2B'
  }
};

const RETAIL_MODE = 'RETAIL_LOCAL';

function getUnitPrice(item, mode) {
  if (BILLING_MODES[mode]?.tier === 'WHOLESALE') {
    return toNumber(item.wholesale_price || item.sale_price || item.mrp);
  }
  return toNumber(item.sale_price || item.mrp);
}

function isSensitiveBillingMode(mode) {
  const config = BILLING_MODES[mode] || {};
  return config.tier === 'WHOLESALE' || config.taxType === 'INTERSTATE';
}

function isBusinessBillingMode(mode) {
  return BILLING_MODES[mode]?.transactionType === 'B2B';
}

function isSensitivePrintMode(mode) {
  return mode === 'A4';
}

function normalizeBillingMode(mode) {
  if (mode === 'BUSINESS_IGST') return 'WHOLESALE_IGST';
  return BILLING_MODES[mode] ? mode : RETAIL_MODE;
}

function composeBillingMode(saleMode, taxMode) {
  if (saleMode === 'WHOLESALE' && taxMode === 'IGST') return 'WHOLESALE_IGST';
  if (saleMode === 'WHOLESALE') return 'WHOLESALE_LOCAL';
  if (taxMode === 'IGST') return 'RETAIL_IGST';
  return RETAIL_MODE;
}

function getHeldBillMode(heldBill) {
  try {
    const savedState = typeof heldBill.saved_state === 'string'
      ? JSON.parse(heldBill.saved_state)
      : heldBill.saved_state;
    return normalizeBillingMode(savedState?.billingMode);
  } catch (err) {
    return RETAIL_MODE;
  }
}

export default function BillingTerminalView() {
  const currentUser = getStoredUser();
  const [invoiceNo, setInvoiceNo] = useState('Loading...');
  const [liveTime, setLiveTime] = useState(new Date());
  const [counterNo, setCounterNo] = useState(1);
  const [counterCount, setCounterCount] = useState(6);
  const [shopSettings, setShopSettings] = useState({
    shop_name: 'Hyper Fresh Mart LLP',
    gst_number: '36AAJFH7790R1ZB',
    address: 'Sathupally - Khammam(dt) - 507303',
    phone: '08761 295000'
  });
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [cart, setCart] = useState([]);
  const [billingMode, setBillingMode] = useState('RETAIL_LOCAL');
  const [approvalDialog, setApprovalDialog] = useState(null);
  const [approvalUsername, setApprovalUsername] = useState(currentUser?.role === 'SERVER' || currentUser?.role === 'ADMIN' ? currentUser.username : '');
  const [approvalPassword, setApprovalPassword] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [isApprovingMode, setIsApprovingMode] = useState(false);
  const [customerName, setCustomerName] = useState('Walk-in Customer');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [customerGstin, setCustomerGstin] = useState('');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [printMode, setPrintMode] = useState('Thermal');
  const [cashReceived, setCashReceived] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [invoiceHistory, setInvoiceHistory] = useState([]);
  const [heldBills, setHeldBills] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [printableInvoice, setPrintableInvoice] = useState(null);
  const [loyaltyCustomer, setLoyaltyCustomer] = useState(null);
  const [returnInvoice, setReturnInvoice] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState('');
  const [refundMode, setRefundMode] = useState('Cash');
  const scannerRef = useRef(null);
  const billingTableRef = useRef(null);
  const canManageInvoice = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const activeMode = BILLING_MODES[billingMode];
  const activeSaleMode = activeMode.tier === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
  const activeTaxMode = activeMode.taxType === 'INTERSTATE' ? 'IGST' : 'GST';

  useEffect(() => {
    scannerRef.current?.focus();
    loadSettings();
    refreshHistory(false);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setLiveTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshInvoicePreview(counterNo);
    refreshHeldBills(counterNo);
  }, [counterNo]);

  useEffect(() => {
    if (!billingTableRef.current) return;
    billingTableRef.current.scrollTop = billingTableRef.current.scrollHeight;
  }, [cart.length]);

  useEffect(() => {
    const run = async () => {
      const cleaned = query.trim();
      if (cleaned.length < 3) {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }

      try {
        const results = await searchProducts(cleaned);
        setSuggestions(results.slice(0, 5));
        setSelectedSuggestion(0);
      } catch (err) {
        setSuggestions([]);
      }
    };

    const timer = window.setTimeout(run, 160);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.key === 'F9') {
        event.preventDefault();
        scannerRef.current?.focus();
      }

      if (event.key === 'F8') {
        event.preventDefault();
        refreshHistory(true);
      }

      if (event.key === 'F10') {
        event.preventDefault();
        submitCheckout('Card');
      }

      if (event.key === 'F11') {
        event.preventDefault();
        submitCheckout('UPI');
      }

      if (event.key === 'F12') {
        event.preventDefault();
        submitCheckout('Cash');
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const totals = useMemo(() => {
    let taxable = 0;
    let tax = 0;
    let discount = 0;

    cart.forEach((item) => {
      const quantity = toNumber(item.quantity, 1);
      const unitPrice = getUnitPrice(item, billingMode);
      const lineTotal = unitPrice * quantity;
      const gstPercent = toNumber(item.gst_percent);
      const rowTax = lineTotal * (gstPercent / (100 + gstPercent));

      taxable += lineTotal - rowTax;
      tax += rowTax;
      discount += Math.max(toNumber(item.mrp) - unitPrice, 0) * quantity;
    });

    const isInterstate = BILLING_MODES[billingMode].taxType === 'INTERSTATE';
    return {
      taxable,
      tax,
      discount,
      grand: taxable + tax,
      cgst: isInterstate ? 0 : tax / 2,
      sgst: isInterstate ? 0 : tax / 2,
      igst: isInterstate ? tax : 0
    };
  }, [cart, billingMode]);

  const changeDue = Math.max(toNumber(cashReceived) - totals.grand, 0);
  const cashReceivedAmount = toNumber(cashReceived);
  const isCashReady = paymentMode !== 'Cash' || cashReceivedAmount >= totals.grand;
  const isExternalPaymentReady = paymentMode === 'Cash' || paymentConfirmed;
  const canCompleteSale = cart.length > 0 && isCashReady && isExternalPaymentReady && !cart.some((item) => item.isUnknown);
  const hasUnknownLine = cart.some((item) => item.isUnknown);
  const latestInvoice = invoiceHistory[0];
  const invoiceDate = useMemo(() => {
    const now = new Date();
    return {
      date: now.toLocaleDateString('en-IN'),
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };
  }, [invoiceNo]);
  const printableDraft = useMemo(() => {
    const isInterstate = BILLING_MODES[billingMode].taxType === 'INTERSTATE';
    const roundedGrand = Math.round(totals.grand);

    return {
      invoiceNo,
      counterNo,
      date: invoiceDate.date,
      time: invoiceDate.time,
      shop: shopSettings,
      customerName: isBusinessBillingMode(billingMode) ? companyName : customerName,
      customerAddress,
      customerPhone,
      customerGstin,
      paymentMode,
      taxType: BILLING_MODES[billingMode].taxType,
      itemCount: cart.reduce((sum, item) => sum + toNumber(item.quantity, 1), 0),
      items: cart.map((item) => {
        const unitPrice = getUnitPrice(item, billingMode);
        const quantity = toNumber(item.quantity, 1);
        const gstPercent = toNumber(item.gst_percent);
        const lineTotal = unitPrice * quantity;
        const taxableRate = unitPrice / (1 + gstPercent / 100);

        return {
          ...item,
          unitPrice,
          quantity,
          gst_percent: gstPercent,
          lineTotal,
          taxableRate,
          taxAmount: lineTotal - taxableRate * quantity
        };
      }),
      totals: {
        ...totals,
        grand: roundedGrand,
        roundOff: roundedGrand - totals.grand,
        cgst: isInterstate ? 0 : totals.tax / 2,
        sgst: isInterstate ? 0 : totals.tax / 2,
        igst: isInterstate ? totals.tax : 0
      }
    };
  }, [billingMode, cart, companyName, counterNo, customerAddress, customerGstin, customerName, customerPhone, invoiceDate, invoiceNo, paymentMode, shopSettings, totals]);

  function invoiceDetailsToPrintable(details, duplicate = false) {
    const invoice = details.invoice;
    const isInterstate = invoice.tax_type === 'INTERSTATE';
    const items = details.items.map((item) => {
      const unitPrice = toNumber(item.sale_price);
      const quantity = toNumber(item.quantity);
      const gstPercent = toNumber(item.gst_percent);
      const lineTotal = unitPrice * quantity;
      const taxableRate = unitPrice / (1 + gstPercent / 100);

      return {
        ...item,
        unitPrice,
        quantity,
        gst_percent: gstPercent,
        lineTotal,
        taxableRate,
        taxAmount: lineTotal - taxableRate * quantity
      };
    });

    return {
      invoiceNo: `${invoice.invoice_no}${duplicate ? ' - DUPLICATE COPY' : ''}`,
      counterNo: String(invoice.billing_counter || '').replace(/\D/g, '') || 1,
      date: invoice.created_at ? new Date(invoice.created_at).toLocaleDateString('en-IN') : '',
      time: invoice.created_at ? new Date(invoice.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '',
      shop: shopSettings,
      customerName: invoice.customer_name,
      customerAddress: '',
      customerPhone: invoice.customer_phone,
      customerGstin: invoice.customer_gstin,
      paymentMode: invoice.payment_mode,
      taxType: invoice.tax_type,
      itemCount: items.reduce((sum, item) => sum + toNumber(item.quantity), 0),
      items,
      totals: {
        taxable: toNumber(invoice.sub_total),
        tax: toNumber(invoice.gst_total),
        discount: 0,
        grand: Math.round(toNumber(invoice.grand_total)),
        roundOff: Math.round(toNumber(invoice.grand_total)) - toNumber(invoice.grand_total),
        cgst: isInterstate ? 0 : toNumber(invoice.gst_total) / 2,
        sgst: isInterstate ? 0 : toNumber(invoice.gst_total) / 2,
        igst: isInterstate ? toNumber(invoice.gst_total) : 0
      }
    };
  }

  useEffect(() => {
    if (!hasUnknownLine && errorMessage.includes('Unknown barcode/product')) {
      setErrorMessage('');
    }
  }, [hasUnknownLine, errorMessage]);

  useEffect(() => {
    if (isCashReady && errorMessage.includes('Cash received')) {
      setErrorMessage('');
    }
  }, [isCashReady, errorMessage]);

  async function loadSettings() {
    try {
      const settings = await fetchSettings();
      setShopSettings(settings);
      setPrintMode(settings.default_print_mode || 'Thermal');
      const nextCounterCount = Number(settings.counter_count || 6);
      setCounterCount(nextCounterCount);
      setCounterNo((current) => Math.min(current, nextCounterCount));
    } catch (err) {
      setCounterCount(6);
    }
  }

  async function handleCustomerLookup() {
    if (!customerPhone || customerPhone.replace(/\D/g, '').length < 10) {
      setErrorMessage('Enter customer phone number for loyalty lookup.');
      return;
    }

    try {
      const customer = await lookupCustomer(customerPhone);
      setLoyaltyCustomer(customer);
      setCustomerName(customer.customer_name || customerName);
      setCustomerAddress(customer.address || customerAddress);
      setCustomerGstin(customer.gstin || customerGstin);
      setStatusMessage(`Loyalty customer loaded. Points: ${customer.loyalty_points}`);
    } catch (err) {
      setLoyaltyCustomer(null);
      setStatusMessage('New loyalty customer. Complete bill or save customer to start points.');
    }
  }

  async function handleCustomerSave() {
    if (!customerPhone || customerPhone.replace(/\D/g, '').length < 10) {
      setErrorMessage('Enter valid customer phone number before saving loyalty customer.');
      return;
    }

    try {
      const customer = await saveCustomer({
        customer_name: isBusinessBillingMode(billingMode) ? companyName : customerName,
        phone: customerPhone,
        gstin: customerGstin,
        address: customerAddress
      });
      setLoyaltyCustomer(customer);
      setStatusMessage(`Customer saved. Loyalty points: ${customer.loyalty_points}`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save customer.');
    }
  }

  async function refreshInvoicePreview(activeCounterNo = counterNo) {
    try {
      const nextInvoice = await fetchNextInvoice(activeCounterNo);
      setInvoiceNo(nextInvoice.invoice_no || 'Draft');
    } catch (err) {
      setInvoiceNo('Draft');
    }
  }

  function addProduct(product) {
    setCart((current) => {
      const existingIndex = current.findIndex((item) => item.barcode === product.barcode);
      if (existingIndex >= 0) {
        return current.map((item, index) => (
          index === existingIndex ? { ...item, quantity: toNumber(item.quantity, 1) + 1 } : item
        ));
      }

      return [
        ...current,
        {
          ...product,
          quantity: 1,
          sale_price: toNumber(product.sale_price || product.mrp),
          wholesale_price: toNumber(product.wholesale_price || product.sale_price || product.mrp),
          mrp: toNumber(product.mrp),
          gst_percent: toNumber(product.gst_percent),
          stock_qty: toNumber(product.stock_qty)
        }
      ];
    });

    setQuery('');
    setSuggestions([]);
    setErrorMessage('');
    setStatusMessage(`${product.product_name} added to bill.`);
    scannerRef.current?.focus();
  }

  async function handleSearchKeyDown(event) {
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault();
      setSelectedSuggestion((current) => Math.min(current + 1, suggestions.length - 1));
    }

    if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault();
      setSelectedSuggestion((current) => Math.max(current - 1, 0));
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const cleaned = query.trim();

      if (suggestions[selectedSuggestion]) {
        addProduct(suggestions[selectedSuggestion]);
        return;
      }

      if (cleaned.length < 3) {
        setErrorMessage('Enter at least 3 letters or barcode digits.');
        return;
      }

      try {
        const results = await searchProducts(cleaned);
        if (results.length === 1) addProduct(results[0]);
        if (results.length > 1) setSuggestions(results.slice(0, 5));
        if (results.length === 0) {
          setCart((current) => [
            ...current,
            {
              barcode: cleaned,
              product_name: 'Unknown product',
              hsn_code: '',
              gst_percent: 0,
              mrp: 0,
              sale_price: 0,
              wholesale_price: 0,
              quantity: 1,
              isUnknown: true
            }
          ]);
          setErrorMessage('Unknown barcode/product. The line is marked red and cannot be billed until corrected.');
          setQuery('');
        }
      } catch (err) {
        setErrorMessage(err.response?.data?.error || 'Product lookup failed.');
      }
    }
  }

  function updateQuantity(index, quantity) {
    setErrorMessage('');
    setCart((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, quantity: Math.max(toNumber(quantity), 0) } : item
    )));
  }

  function removeLine(index) {
    setErrorMessage('');
    setCart((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function closeApprovalDialog() {
    setApprovalDialog(null);
    setApprovalPassword('');
    setApprovalError('');
    setIsApprovingMode(false);
    scannerRef.current?.focus();
  }

  function requestBillingMode(targetMode) {
    setErrorMessage('');
    setStatusMessage('');
    setApprovalError('');

    if (targetMode === billingMode) {
      scannerRef.current?.focus();
      return;
    }

    if (targetMode === RETAIL_MODE) {
      setBillingMode(RETAIL_MODE);
      setStatusMessage('Billing mode reset to Retail.');
      scannerRef.current?.focus();
      return;
    }

    setApprovalDialog({
      action: 'MODE',
      targetMode,
      title: `Approve ${BILLING_MODES[targetMode].label} bill`,
      message: `${BILLING_MODES[targetMode].label} is allowed for this bill only. After complete sale or hold, POS will return to Retail.`
    });
  }

  function requestPrintMode(targetPrintMode) {
    setErrorMessage('');
    setStatusMessage('');
    setApprovalError('');

    if (targetPrintMode === printMode) {
      scannerRef.current?.focus();
      return;
    }

    if (!isSensitivePrintMode(targetPrintMode)) {
      setPrintMode('Thermal');
      setStatusMessage('Print format reset to Thermal.');
      scannerRef.current?.focus();
      return;
    }

    setApprovalDialog({
      action: 'PRINT_MODE',
      targetPrintMode,
      targetMode: billingMode,
      title: 'Approve A4 print',
      message: 'A4 print is allowed for this bill only. After complete sale, hold, or reset, POS will return to Thermal.'
    });
  }

  async function applyHeldBill(savedState, holdToken) {
    setInvoiceNo(savedState.invoiceNo || 'Draft');
    setCounterNo(savedState.counterNo || 1);
    setCart(savedState.cart || []);
    setBillingMode(normalizeBillingMode(savedState.billingMode));
    setCustomerName(savedState.customerName || 'Walk-in Customer');
    setCustomerAddress(savedState.customerAddress || '');
    setCustomerPhone(savedState.customerPhone || '');
    setCompanyName(savedState.companyName || '');
    setCustomerGstin(savedState.customerGstin || '');
    setPaymentMode(savedState.paymentMode || 'Cash');
    setPaymentReference(savedState.paymentReference || '');
    setPaymentConfirmed(Boolean(savedState.paymentConfirmed));
    setPrintMode(savedState.printMode || 'Thermal');
    setCashReceived(savedState.cashReceived || '');
    await deleteHeldBill(holdToken);
    refreshHeldBills(savedState.counterNo || counterNo);
    scannerRef.current?.focus();
  }

  async function submitModeApproval(event) {
    event.preventDefault();
    if (!approvalDialog) return;

    setErrorMessage('');
    setStatusMessage('');
    setIsApprovingMode(true);

    try {
      const result = await approveSensitiveBillingMode({
        username: approvalUsername,
        password: approvalPassword,
        reason: approvalDialog.action === 'RESUME'
          ? `Resume held ${BILLING_MODES[approvalDialog.targetMode].label} bill`
          : `Start ${BILLING_MODES[approvalDialog.targetMode].label} bill`
      });

      if (approvalDialog.action === 'RESUME') {
        await applyHeldBill(approvalDialog.savedState, approvalDialog.holdToken);
        setStatusMessage(`${BILLING_MODES[approvalDialog.targetMode].label} held bill resumed. Approved by ${result.approved_by}.`);
      } else if (approvalDialog.action === 'PRINT_MODE') {
        setPrintMode(approvalDialog.targetPrintMode);
        setStatusMessage(`${approvalDialog.targetPrintMode} enabled for this bill. Approved by ${result.approved_by}.`);
        scannerRef.current?.focus();
      } else {
        setBillingMode(approvalDialog.targetMode);
        setStatusMessage(`${BILLING_MODES[approvalDialog.targetMode].label} enabled for this bill. Approved by ${result.approved_by}.`);
        scannerRef.current?.focus();
      }

      closeApprovalDialog();
    } catch (err) {
      setApprovalError(err.response?.data?.error || 'Supervisor approval failed.');
      setIsApprovingMode(false);
    }
  }

  function resetBill() {
    setCart([]);
    setBillingMode(RETAIL_MODE);
    setCustomerName('Walk-in Customer');
    setCustomerAddress('');
    setCustomerPhone('');
    setCompanyName('');
    setCustomerGstin('');
    setCashReceived('');
    setPaymentMode('Cash');
    setPaymentReference('');
    setPaymentConfirmed(false);
    setPrintMode('Thermal');
    scannerRef.current?.focus();
    refreshInvoicePreview(counterNo);
  }

  function printBill(invoice = printableDraft) {
    if (!invoice.items.length) {
      setErrorMessage('Add at least one item before printing.');
      return;
    }

    setPrintableInvoice(invoice);
    window.setTimeout(() => window.print(), 80);
  }

  async function refreshHistory(openModal) {
    try {
      const rows = await fetchInvoiceHistory();
      setInvoiceHistory(rows);
      if (openModal) setShowHistory(true);
    } catch (err) {
      if (openModal) setShowHistory(true);
    }
  }

  async function refreshHeldBills(activeCounterNo = counterNo) {
    try {
      setHeldBills(await fetchHeldBills(activeCounterNo));
    } catch (err) {
      setHeldBills([]);
    }
  }

  async function holdCurrentBill() {
    if (cart.length === 0) {
      setErrorMessage('Add at least one item before holding a bill.');
      return;
    }

    const holdToken = window.prompt('Hold name or token:', `HOLD-${Date.now().toString().slice(-4)}`);
    if (!holdToken) return;

    try {
      const savedState = {
        invoiceNo,
        counterNo,
        cart,
        billingMode,
        customerName,
        customerAddress,
        customerPhone,
        companyName,
        customerGstin,
        paymentMode,
        paymentReference,
        paymentConfirmed,
        printMode,
        cashReceived
      };
      await holdBill(holdToken, savedState, {
        counter_no: counterNo,
        customer_name: isBusinessBillingMode(billingMode) ? companyName : customerName,
        customer_phone: customerPhone,
        bill_total: totals.grand.toFixed(2),
        item_count: cart.length
      });
      setStatusMessage(`Bill held as ${holdToken}.`);
      resetBill();
      refreshHeldBills(counterNo);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to hold bill.');
    }
  }

  async function resumeHeldBill(heldBill) {
    try {
      const savedState = typeof heldBill.saved_state === 'string'
        ? JSON.parse(heldBill.saved_state)
        : heldBill.saved_state;

      const heldMode = normalizeBillingMode(savedState.billingMode);
      savedState.billingMode = heldMode;
      if (isSensitiveBillingMode(heldMode)) {
        setApprovalError('');
        setApprovalDialog({
          action: 'RESUME',
          targetMode: heldMode,
          savedState,
          holdToken: heldBill.hold_token,
          title: `Approve held ${BILLING_MODES[heldMode].label} bill`,
          message: `This held bill was saved as ${BILLING_MODES[heldMode].label}. Supervisor approval is required again before resuming.`
        });
        return;
      }

      await applyHeldBill(savedState, heldBill.hold_token);
    } catch (err) {
      setErrorMessage('Unable to resume held bill.');
    }
  }

  async function deleteHeldBillSafely(heldBill) {
    const confirmed = window.confirm(`Delete held bill ${heldBill.hold_token}?`);
    if (!confirmed) return;

    try {
      await deleteHeldBill(heldBill.hold_token);
      setStatusMessage(`Held bill ${heldBill.hold_token} deleted.`);
      refreshHeldBills(counterNo);
    } catch (err) {
      setErrorMessage('Unable to delete held bill.');
    }
  }

  async function handleReprint(invoiceNoForReprint) {
    try {
      const details = await fetchInvoiceDetails(invoiceNoForReprint);
      await recordInvoiceReprint(invoiceNoForReprint);
      setPrintableInvoice(invoiceDetailsToPrintable(details, true));
      window.setTimeout(() => window.print(), 80);
      refreshHistory(false);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to reprint invoice.');
    }
  }

  async function handleVoidInvoice(invoiceNoForVoid) {
    const reason = window.prompt(`Cancel invoice ${invoiceNoForVoid}. Enter reason:`);
    if (!reason) return;

    try {
      await voidInvoice(invoiceNoForVoid, reason);
      setStatusMessage(`Invoice ${invoiceNoForVoid} cancelled and stock restored.`);
      refreshHistory(true);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to cancel invoice.');
    }
  }

  async function openReturnInvoice(invoiceNoForReturn) {
    try {
      const details = await fetchInvoiceDetails(invoiceNoForReturn);
      const quantities = {};
      details.items.forEach((item) => {
        const available = Math.max(toNumber(item.quantity) - toNumber(item.returned_qty), 0);
        quantities[item.id] = available > 0 ? String(available) : '';
      });
      setReturnInvoice(details);
      setReturnQuantities(quantities);
      setReturnReason('');
      setRefundMode('Cash');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load invoice for return.');
    }
  }

  async function submitSalesReturn() {
    if (!returnInvoice) return;

    const items = returnInvoice.items
      .map((item) => ({
        invoice_item_id: item.id,
        quantity: toNumber(returnQuantities[item.id])
      }))
      .filter((item) => item.quantity > 0);

    try {
      const result = await createSalesReturn({
        invoice_no: returnInvoice.invoice.invoice_no,
        reason: returnReason,
        refund_mode: refundMode,
        items
      });
      setStatusMessage(`Return ${result.return_no} saved. Refund: ${formatMoney(result.refund_total)}`);
      setReturnInvoice(null);
      refreshHistory(true);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save sales return.');
    }
  }

  async function submitCheckout(forcedMode) {
    const activePaymentMode = forcedMode || paymentMode;
    setErrorMessage('');
    setStatusMessage('');

    if (cart.length === 0) {
      setErrorMessage('Cart is empty.');
      return;
    }

    if (cart.some((item) => item.isUnknown)) {
      setErrorMessage('Remove or correct unknown red product lines before billing.');
      return;
    }

    if (isBusinessBillingMode(billingMode) && (!companyName.trim() || !customerGstin.trim())) {
      setErrorMessage('Company name and GSTIN are required for B2B IGST Wholesale bills.');
      return;
    }

    const received = activePaymentMode === 'Cash' ? toNumber(cashReceived) : totals.grand;
    if (activePaymentMode === 'Cash' && received < totals.grand) {
      setErrorMessage('Cash received must be equal to or greater than the bill total.');
      return;
    }

    if (activePaymentMode !== 'Cash' && !paymentConfirmed) {
      setErrorMessage(`Confirm ${activePaymentMode} payment before completing the sale.`);
      return;
    }

    const mode = BILLING_MODES[billingMode];

    try {
      const checkoutResult = await checkout({
        counter_no: counterNo,
        customer_name: isBusinessBillingMode(billingMode) ? companyName : customerName,
        customer_phone: customerPhone,
        items: cart.map((item) => ({
          ...item,
          sale_price: getUnitPrice(item, billingMode)
        })),
        sub_total: totals.taxable.toFixed(2),
        gst_total: totals.tax.toFixed(2),
        grand_total: totals.grand.toFixed(2),
        payment_mode: activePaymentMode,
        payment_status: 'PAID',
        payment_reference: activePaymentMode === 'Cash' ? null : paymentReference,
        cash_received: received.toFixed(2),
        change_returned: Math.max(received - totals.grand, 0).toFixed(2),
        transaction_type: mode.transactionType,
        billing_tier: mode.tier,
        tax_type: mode.taxType,
        customer_company_name: isBusinessBillingMode(billingMode) ? companyName : null,
        customer_gstin: mode.taxType === 'INTERSTATE' ? customerGstin : null,
        total_cgst: totals.cgst.toFixed(2),
        total_sgst: totals.sgst.toFixed(2),
        total_igst: totals.igst.toFixed(2),
        print_mode: printMode
      });

      setPrintableInvoice({
        ...printableDraft,
        invoiceNo: checkoutResult.invoice_no || invoiceNo,
        paymentMode: activePaymentMode,
        totals: {
          ...printableDraft.totals,
          grand: Math.round(totals.grand),
          roundOff: Math.round(totals.grand) - totals.grand
        }
      });
      setStatusMessage(`Invoice ${checkoutResult.invoice_no || invoiceNo} saved. Change due: ${formatMoney(Math.max(received - totals.grand, 0))}`);
      resetBill();
      refreshHistory(false);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Checkout failed.');
    }
  }

  return (
    <div className={`billing-grid ${isSensitiveBillingMode(billingMode) ? 'sensitive-billing-active' : ''}`}>
      <section className="panel billing-main-panel">
        <div className="panel-header billing-store-banner">
          <div>
            <h2 className="panel-title">{shopSettings.shop_name}</h2>
            <div className="muted">GST: {shopSettings.gst_number} | {shopSettings.address} | Ph: {shopSettings.phone}</div>
          </div>
          <div className="billing-header-meta">
            <span className="live-time-chip">{liveTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</span>
            <span className="invoice-chip">Invoice {invoiceNo}</span>
          </div>
        </div>

        <div className="panel-body billing-panel-body">
          <div className="billing-topline">
            <div className="mode-toggle-group">
              <div className="mode-toggle">
                <span className="mode-toggle-label">Sale Mode</span>
                <div className="mode-option-group" aria-label="Sale mode">
                  <button className={activeSaleMode === 'RETAIL' ? 'mode-option active retail-active' : 'mode-option'} onClick={() => requestBillingMode(composeBillingMode('RETAIL', activeTaxMode))}>Retail</button>
                  <button className={activeSaleMode === 'WHOLESALE' ? 'mode-option active sensitive-active' : 'mode-option'} onClick={() => requestBillingMode(composeBillingMode('WHOLESALE', activeTaxMode))}>Wholesale</button>
                </div>
              </div>
              <div className="mode-toggle">
                <span className="mode-toggle-label">Tax Mode</span>
                <div className="mode-option-group" aria-label="Tax mode">
                  <button className={activeTaxMode === 'GST' ? 'mode-option active retail-active' : 'mode-option'} onClick={() => requestBillingMode(composeBillingMode(activeSaleMode, 'GST'))}>GST</button>
                  <button className={activeTaxMode === 'IGST' ? 'mode-option active sensitive-active' : 'mode-option'} onClick={() => requestBillingMode(composeBillingMode(activeSaleMode, 'IGST'))}>IGST</button>
                </div>
              </div>
            </div>
            <div className="billing-top-controls">
              <span className={`billing-mode-pill ${isSensitiveBillingMode(billingMode) ? 'warning' : ''}`}>
                {activeMode.shortLabel || activeMode.label}
              </span>
              <label className="top-control-field">
                <span>Counter</span>
                <select aria-label="Counter" value={counterNo} onChange={(event) => setCounterNo(Number(event.target.value))}>
                  {Array.from({ length: counterCount }, (_, index) => index + 1).map((number) => (
                    <option key={number} value={number}>Counter {number}</option>
                  ))}
                </select>
              </label>
              <label className="top-control-field print-control-field">
                <span>Print</span>
                <select aria-label="Print format" value={printMode} onChange={(event) => requestPrintMode(event.target.value)}>
                  <option value="Thermal">Thermal</option>
                  <option value="A4">A4</option>
                </select>
              </label>
            </div>
          </div>

          {isSensitiveBillingMode(billingMode) && (
            <div className="sensitive-bill-warning">
              {activeMode.label} active for this bill only. Complete, Hold, or Reset will return to Retail.
            </div>
          )}

          <div className="scanner-row billing-scanner-row">
            <span className="status-chip">F9 Focus Scanner</span>
            <div className="search-wrap">
              <input
                ref={scannerRef}
                className="field search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Type at least 3 letters or barcode digits"
              />
              {suggestions.length > 0 && (
                <div className="suggestions">
                  {suggestions.map((product, index) => (
                    <button
                      key={product.barcode}
                      className={`suggestion-row ${index === selectedSuggestion ? 'active' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addProduct(product)}
                    >
                      <span className="mono muted">{product.barcode}</span>
                      <strong>{product.product_name}</strong>
                      <span>{formatMoney(product.sale_price)}</span>
                      <span className={toNumber(product.stock_qty) <= toNumber(product.min_stock_alert, 10) ? 'stock-low' : ''}>
                        {product.stock_qty} in stock
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {errorMessage && <div className="alert-box" style={{ marginTop: 12 }}>{errorMessage}</div>}
          {statusMessage && <div className="change-box" style={{ marginTop: 12 }}>{statusMessage}</div>}

          <div className="billing-table-wrap" ref={billingTableRef}>
            <table className="product-table billing-product-table">
              <thead>
                <tr>
                  <th>Barcode</th>
                  <th>Product</th>
                  <th>HSN</th>
                  <th>MRP</th>
                  <th>Disc</th>
                  <th>Rate</th>
                  <th>Qty</th>
                  <th>GST</th>
                  <th>Line Total</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cart.length === 0 ? (
                  <tr>
                    <td colSpan="10">
                      <div className="empty-state">Scan a barcode or search a product name to start a bill.</div>
                    </td>
                  </tr>
                ) : (
                  cart.map((item, index) => {
                    const unitPrice = getUnitPrice(item, billingMode);
                    return (
                      <tr key={`${item.barcode}-${index}`} className={item.isUnknown ? 'unknown-row' : ''}>
                        <td className="mono muted">{item.barcode}</td>
                        <td><strong className="billing-product-name" title={item.product_name}>{item.product_name}</strong></td>
                        <td>{item.hsn_code || '-'}</td>
                        <td className="muted">{formatMoney(item.mrp)}</td>
                        <td>{formatMoney(Math.max(toNumber(item.mrp) - unitPrice, 0))}</td>
                        <td><strong>{formatMoney(unitPrice)}</strong></td>
                        <td>
                          <input
                            className="field qty-input"
                            type="number"
                            min="0"
                            value={item.quantity}
                            onChange={(event) => updateQuantity(index, event.target.value)}
                          />
                        </td>
                        <td>{item.gst_percent}%</td>
                        <td><strong>{formatMoney(unitPrice * toNumber(item.quantity, 1))}</strong></td>
                        <td><button className="danger-button" onClick={() => removeLine(index)}>Del</button></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <aside className="sidebar">
        {latestInvoice && (
          <section className="panel last-bill-panel">
            <details>
              <summary>
                <span>Last Bill</span>
                <strong className="mono">{latestInvoice.invoice_no}</strong>
              </summary>
              <div className="panel-body">
              <div className="summary-line"><span>Bill No:</span><strong className="mono">{latestInvoice.invoice_no}</strong></div>
              <div className="summary-line"><span>Amount:</span><strong>{formatMoney(latestInvoice.grand_total)}</strong></div>
              <div className="summary-line"><span>Cash Given:</span><strong>{formatMoney(latestInvoice.cash_received)}</strong></div>
              <div className="summary-line"><span>Change Returned:</span><strong className="stock-low">{formatMoney(latestInvoice.change_returned)}</strong></div>
              </div>
            </details>
          </section>
        )}

        <section className="panel customer-side-panel">
          <details className="billing-customer-details">
            <summary>
              <span>{isBusinessBillingMode(billingMode) ? companyName || 'Business customer' : customerName || 'Walk-in Customer'}</span>
              <span>{loyaltyCustomer ? `${loyaltyCustomer.loyalty_points} pts` : 'Customer'}</span>
            </summary>
            <div className="customer-grid billing-customer-grid">
              <div className="billing-loyalty-inline">
                <span>Loyalty: {loyaltyCustomer ? `${loyaltyCustomer.loyalty_points} pts` : 'None'}</span>
                <button className="secondary-button" onClick={handleCustomerLookup}>Lookup</button>
                <button className="secondary-button" onClick={handleCustomerSave}>Save</button>
              </div>
              <label>
                <span className="field-label">{isBusinessBillingMode(billingMode) ? 'Company name' : 'Customer name'}</span>
                <input className="field" value={isBusinessBillingMode(billingMode) ? companyName : customerName} onChange={(event) => (isBusinessBillingMode(billingMode) ? setCompanyName(event.target.value) : setCustomerName(event.target.value))} />
              </label>
              <label>
                <span className="field-label">Phone No</span>
                <input className="field" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Optional" />
              </label>
              <label>
                <span className="field-label">GST No</span>
                <input className="field" maxLength={15} value={customerGstin} onChange={(event) => setCustomerGstin(event.target.value.toUpperCase())} placeholder={activeMode.taxType === 'INTERSTATE' ? 'Required for B2B' : 'Optional'} />
              </label>
              <label>
                <span className="field-label">Address</span>
                <input className="field" value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} placeholder="Customer address" />
              </label>
            </div>
          </details>
        </section>

        <section className="panel payment-panel">
          <div className="panel-header">
            <h2 className="panel-title">Payment</h2>
          </div>
          <div className="panel-body">
            <div className="summary-line"><span>Taxable</span><strong>{formatMoney(totals.taxable)}</strong></div>
            <div className="summary-line"><span>CGST</span><strong>{formatMoney(totals.cgst)}</strong></div>
            <div className="summary-line"><span>SGST</span><strong>{formatMoney(totals.sgst)}</strong></div>
            <div className="summary-line"><span>IGST</span><strong>{formatMoney(totals.igst)}</strong></div>
            <div className="summary-line"><span>Discount</span><strong>{formatMoney(totals.discount)}</strong></div>

            <div className="total-box">
              <span className="total-label">Net payable</span>
              <span className="total-value">{formatMoney(totals.grand)}</span>
              <span className="amount-words">{amountInWords(totals.grand)}</span>
            </div>

            <div className="form-stack">
              <label>
                <span className="field-label">Payment method</span>
                <select
                  className="select"
                  value={paymentMode}
                  onChange={(event) => {
                    setPaymentMode(event.target.value);
                    setPaymentReference('');
                    setPaymentConfirmed(false);
                  }}
                >
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Card">Card</option>
                </select>
              </label>

              {paymentMode === 'Cash' && (
                <>
                  <label>
                    <span className="field-label">Cash received</span>
                    <input
                      className="field"
                      type="number"
                      min="0"
                      value={cashReceived}
                      onChange={(event) => {
                        setCashReceived(event.target.value);
                        if (errorMessage.includes('Cash received')) setErrorMessage('');
                      }}
                    />
                  </label>
                  <div className="change-box">Change due: {formatMoney(changeDue)}</div>
                  {!isCashReady && <div className="alert-box">Enter customer cash before completing sale.</div>}
                </>
              )}

              {paymentMode !== 'Cash' && (
                <>
                  <label>
                    <span className="field-label">{paymentMode} reference</span>
                    <input
                      className="field"
                      value={paymentReference}
                      onChange={(event) => setPaymentReference(event.target.value)}
                      placeholder={paymentMode === 'UPI' ? 'UPI transaction ID / last 4 digits' : 'Card approval code / terminal slip no'}
                    />
                  </label>
                  <label className="change-box">
                    <input
                      type="checkbox"
                      checked={paymentConfirmed}
                      onChange={(event) => setPaymentConfirmed(event.target.checked)}
                    /> Payment received on {paymentMode}
                  </label>
                  {!paymentConfirmed && <div className="alert-box">Confirm {paymentMode} payment before completing sale.</div>}
                </>
              )}

              <button className="primary-button" disabled={!canCompleteSale} onClick={() => submitCheckout(paymentMode)}>Complete Sale</button>
              <div className="quick-actions">
                <button className="secondary-button" onClick={() => submitCheckout('Cash')}>F12 Cash</button>
                <button className="secondary-button" onClick={() => submitCheckout('UPI')}>F11 UPI</button>
                <button className="secondary-button" onClick={() => submitCheckout('Card')}>F10 Card</button>
                <button className="secondary-button" onClick={() => refreshHistory(true)}>F8 History</button>
                <button className="secondary-button" onClick={holdCurrentBill}>Hold Bill</button>
                <button className="secondary-button" onClick={() => printBill(printableInvoice || printableDraft)}>Print</button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Held Bills</h2>
            <span className="status-chip">{heldBills.length}</span>
          </div>
          <div className="panel-body hold-list">
            {heldBills.length === 0 ? (
              <span className="muted">No bills on hold.</span>
            ) : (
              heldBills.map((heldBill) => (
                <div key={heldBill.hold_token} className="hold-card">
                  <div>
                    <strong>{heldBill.hold_token}</strong>
                    <div className="muted">Counter {heldBill.counter_no} | {heldBill.customer_name || 'Walk-in Customer'}</div>
                    <div className="muted">{heldBill.item_count} items | {formatMoney(heldBill.bill_total)}</div>
                    {isSensitiveBillingMode(getHeldBillMode(heldBill)) && (
                      <div className="hold-mode-warning">{BILLING_MODES[getHeldBillMode(heldBill)].label} | approval required</div>
                    )}
                    <div className="muted">{heldBill.updated_at ? new Date(heldBill.updated_at).toLocaleString() : '-'}</div>
                  </div>
                  <div className="hold-actions">
                    <button className="secondary-button" onClick={() => resumeHeldBill(heldBill)}>Resume</button>
                    <button className="danger-button" onClick={() => deleteHeldBillSafely(heldBill)}>Delete</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

      </aside>

      {showHistory && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="panel-header">
              <h2 className="panel-title">Recent Invoices</h2>
              <button className="secondary-button" onClick={() => setShowHistory(false)}>Close</button>
            </div>
            <div className="panel-body">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Customer</th>
                    <th>Total</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceHistory.length === 0 ? (
                    <tr><td colSpan="7">No invoices found.</td></tr>
                  ) : (
                    invoiceHistory.map((invoice) => (
                      <tr key={invoice.invoice_no}>
                        <td className="mono">{invoice.invoice_no}</td>
                        <td>{invoice.customer_name || 'Walk-in Customer'}</td>
                        <td><strong>{formatMoney(invoice.grand_total)}</strong></td>
                        <td>{invoice.payment_mode}</td>
                        <td>{invoice.invoice_status || 'PAID'}</td>
                        <td>{invoice.created_at ? new Date(invoice.created_at).toLocaleString() : '-'}</td>
                        <td>
                          <div className="table-actions">
                            <button className="secondary-button" onClick={() => handleReprint(invoice.invoice_no)}>Reprint</button>
                            {canManageInvoice && invoice.invoice_status !== 'CANCELLED' && invoice.invoice_status !== 'RETURNED' && (
                              <button className="secondary-button" onClick={() => openReturnInvoice(invoice.invoice_no)}>Return</button>
                            )}
                            {canManageInvoice && invoice.invoice_status === 'PAID' && (
                              <button className="danger-button" onClick={() => handleVoidInvoice(invoice.invoice_no)}>Void</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {returnInvoice && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="panel-header">
              <h2 className="panel-title">Sales Return - {returnInvoice.invoice.invoice_no}</h2>
              <button className="secondary-button" onClick={() => setReturnInvoice(null)}>Close</button>
            </div>
            <div className="panel-body form-stack">
              <div className="customer-grid">
                <label>
                  <span className="field-label">Refund Mode</span>
                  <select className="select" value={refundMode} onChange={(event) => setRefundMode(event.target.value)}>
                    <option value="Cash">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="Card">Card</option>
                    <option value="Store Credit">Store Credit</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">Return Reason</span>
                  <input className="field" value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="Damaged / exchange / customer return" />
                </label>
              </div>
              <table className="history-table">
                <thead>
                  <tr><th>Product</th><th>Barcode</th><th>Sold</th><th>Already Returned</th><th>Return Qty</th><th>Refund</th></tr>
                </thead>
                <tbody>
                  {returnInvoice.items.map((item) => {
                    const available = Math.max(toNumber(item.quantity) - toNumber(item.returned_qty), 0);
                    const qty = Math.min(toNumber(returnQuantities[item.id]), available);
                    return (
                      <tr key={item.id}>
                        <td>{item.product_name}</td>
                        <td className="mono">{item.barcode}</td>
                        <td>{item.quantity}</td>
                        <td>{item.returned_qty}</td>
                        <td>
                          <input
                            className="field qty-input"
                            type="number"
                            min="0"
                            max={available}
                            step="0.01"
                            value={returnQuantities[item.id] || ''}
                            onChange={(event) => setReturnQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                          />
                        </td>
                        <td><strong>{formatMoney(qty * toNumber(item.sale_price))}</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="primary-button" onClick={submitSalesReturn}>Save Return</button>
            </div>
          </div>
        </div>
      )}

      {approvalDialog && (
        <div className="modal-backdrop">
          <form className="modal supervisor-approval-modal" onSubmit={submitModeApproval}>
            <div className="panel-header">
              <h2 className="panel-title">{approvalDialog.title}</h2>
              <button className="secondary-button" type="button" onClick={closeApprovalDialog}>Cancel</button>
            </div>
            <div className="panel-body form-stack">
              <div className="sensitive-bill-warning">{approvalDialog.message}</div>
              {approvalError && <div className="alert-box">{approvalError}</div>}
              <label>
                <span className="field-label">Supervisor username</span>
                <input
                  className="field"
                  value={approvalUsername}
                  onChange={(event) => setApprovalUsername(event.target.value)}
                  autoFocus
                  required
                />
              </label>
              <label>
                <span className="field-label">Supervisor password</span>
                <input
                  className="field"
                  type="password"
                  value={approvalPassword}
                  onChange={(event) => setApprovalPassword(event.target.value)}
                  required
                />
              </label>
              <button className="primary-button sensitive-approval-button" type="submit" disabled={isApprovingMode}>
                {isApprovingMode ? 'Verifying...' : `Approve ${approvalDialog.action === 'PRINT_MODE' ? approvalDialog.targetPrintMode : BILLING_MODES[approvalDialog.targetMode].label}`}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="print-area" aria-hidden="true">
        <PrintableInvoice invoice={printableInvoice || printableDraft} mode={printMode} />
      </div>
    </div>
  );
}
