import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  approveSensitiveBillingMode,
  checkout,
  createSalesReturn,
  deleteHeldBill,
  fetchHeldBills,
  fetchCounterSaleSlip,
  fetchInvoiceDetails,
  fetchInvoiceHistory,
  fetchNextInvoice,
  fetchCustomers,
  fetchSettings,
  getStoredUser,
  holdBill,
  lookupExactProduct,
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
const POS_DRAFT_KEY = 'badizo_pos_active_draft';
const EMPTY_MIXED_PAYMENT = { cash: '', upi: '', card: '', upi_reference: '', card_reference: '' };
const SCANNER_BARCODE_PATTERN = /^[A-Z0-9._-]+$/i;
const SCANNER_SETTLE_MS = 650;
const SCANNER_FAST_KEY_MS = 90;
const TYPED_SEARCH_DEBOUNCE_MS = 160;

function readActivePosDraft(username) {
  try {
    const raw = window.localStorage.getItem(POS_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (draft.username && username && draft.username !== username) return null;
    const hasBillLines = Array.isArray(draft.cart) && draft.cart.length > 0;
    const hasExchangeLines = Array.isArray(draft.exchangeItems) && draft.exchangeItems.length > 0;
    if (!hasBillLines && !hasExchangeLines) {
      window.localStorage.removeItem(POS_DRAFT_KEY);
      return null;
    }
    return { ...draft, cashReceived: '' };
  } catch (err) {
    return null;
  }
}

function clearActivePosDraft() {
  try {
    window.localStorage.removeItem(POS_DRAFT_KEY);
  } catch (err) {
    // Ignore storage failures; billing state still works in memory.
  }
}

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

function isDigitalPaymentContactReady(value) {
  const text = String(value || '').trim();
  return text.toUpperCase() === 'NO' || text.replace(/\D/g, '').length === 10;
}

function isExchangeCustomerNameReady(value) {
  const text = String(value || '').trim();
  return text.length > 0 && text.toLowerCase() !== 'walk-in customer';
}

function isTenDigitPhoneReady(value) {
  return String(value || '').replace(/\D/g, '').length === 10;
}

function formatSlipAmount(value) {
  return toNumber(value).toFixed(2);
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getThermalFeedMarginMm(settings) {
  const parsed = Number(settings?.thermal_feed_margin_mm ?? 4);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 30) : 4;
}

function buildHoldToken({ invoiceNo, counterNo, customerLabel }) {
  const billLabel = String(invoiceNo || '').trim();
  const stableBillLabel = billLabel && billLabel !== 'Loading...'
    ? billLabel
    : `HOLD-C${counterNo}-${Date.now()}`;
  const customerText = String(customerLabel || '').trim() || 'WALK-IN';
  return `${stableBillLabel} - ${customerText.toUpperCase()}`.slice(0, 80);
}

function CounterSaleSlip({ slip, shop, printedAt }) {
  const printedDate = printedAt.toLocaleDateString('en-IN');
  const printedTime = printedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const counter = slip?.counter || {};
  const allCounters = slip?.allCounters || {};

  return (
    <div className="counter-sale-slip">
      <div className="counter-sale-slip-title">
        <strong>{shop.shop_name}</strong>
        <span>{printedDate} | {printedTime}</span>
      </div>
      <div className="counter-sale-slip-rule" />
      <div className="counter-sale-slip-heading">COUNTER SALE</div>
      <div className="counter-sale-slip-line"><span>Counter Detail</span><strong>Counter {slip?.counterNo || '-'}</strong></div>
      <div className="counter-sale-slip-rule counter-detail-rule" />
      <div className="counter-sale-slip-line"><span>Bills</span><strong>{Number(counter.billCount || 0)}</strong></div>
      <div className="counter-sale-slip-line"><span>UPI Sale</span><strong>{formatSlipAmount(counter.upiSale)}</strong></div>
      <div className="counter-sale-slip-line"><span>Card Sale</span><strong>{formatSlipAmount(counter.cardSale)}</strong></div>
      <div className="counter-sale-slip-line"><span>Cash Sale</span><strong>{formatSlipAmount(counter.cashSale)}</strong></div>
      <div className="counter-sale-slip-total"><span>Total Sale</span><strong>{formatSlipAmount(counter.totalSale)}</strong></div>
      <div className="counter-sale-slip-rule" />
      <div className="counter-sale-slip-total all-sale"><span>All Counter Sale</span><strong>{formatSlipAmount(allCounters.totalSale)}</strong></div>
      <div className="counter-sale-slip-line"><span>Net Sale</span><strong>{formatSlipAmount(allCounters.totalSale)}</strong></div>
      <div className="counter-sale-slip-rule" />
      <div className="counter-sale-slip-footer">Cash handover slip</div>
    </div>
  );
}

export default function BillingTerminalView({ isActive = true }) {
  const currentUser = getStoredUser();
  const initialDraft = readActivePosDraft(currentUser?.username);
  const [invoiceNo, setInvoiceNo] = useState(initialDraft?.invoiceNo || 'Loading...');
  const [liveTime, setLiveTime] = useState(new Date());
  const [counterNo, setCounterNo] = useState(Number(initialDraft?.counterNo || 1));
  const [counterCount, setCounterCount] = useState(6);
  const [shopSettings, setShopSettings] = useState({
    shop_name: 'Hyper Fresh Mart LLP',
    gst_number: '36AAJFH7790R1ZB',
    address: 'Sathupally - Khammam(dt) - 507303',
    phone: '08761 295000',
    bank_name: 'HDFC BANK',
    bank_account_name: 'Hyper Fresh Mart LLP',
    bank_account_no: '59209440987345',
    bank_ifsc: 'HDFC0004047',
    bank_branch: 'Sathupally',
    thermal_receipt_width_mm: 80,
    thermal_feed_margin_mm: 4
  });
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [cart, setCart] = useState(initialDraft?.cart || []);
  const [selectedCartIndex, setSelectedCartIndex] = useState(
    initialDraft?.cart?.length ? initialDraft.cart.length - 1 : -1
  );
  const [exchangeMode, setExchangeMode] = useState(Boolean(initialDraft?.exchangeMode));
  const [exchangeQuery, setExchangeQuery] = useState('');
  const [exchangeItems, setExchangeItems] = useState(initialDraft?.exchangeItems || []);
  const [billingMode, setBillingMode] = useState(normalizeBillingMode(initialDraft?.billingMode));
  const [approvalDialog, setApprovalDialog] = useState(null);
  const [approvalUsername, setApprovalUsername] = useState(currentUser?.role === 'SERVER' || currentUser?.role === 'ADMIN' ? currentUser.username : '');
  const [approvalPassword, setApprovalPassword] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [isApprovingMode, setIsApprovingMode] = useState(false);
  const [customerName, setCustomerName] = useState(initialDraft?.customerName || '');
  const [customerAddress, setCustomerAddress] = useState(initialDraft?.customerAddress || '');
  const [customerPhone, setCustomerPhone] = useState(initialDraft?.customerPhone || '');
  const [companyName, setCompanyName] = useState(initialDraft?.companyName || '');
  const [customerGstin, setCustomerGstin] = useState(initialDraft?.customerGstin || '');
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [isCustomerLookupOpen, setIsCustomerLookupOpen] = useState(false);
  const [isCustomerSuggestionLoading, setIsCustomerSuggestionLoading] = useState(false);
  const [paymentMode, setPaymentMode] = useState(initialDraft?.paymentMode || 'Cash');
  const [mixedPayment, setMixedPayment] = useState(initialDraft?.mixedPayment || EMPTY_MIXED_PAYMENT);
  const [paymentReference, setPaymentReference] = useState(initialDraft?.paymentReference || '');
  const [paymentConfirmed, setPaymentConfirmed] = useState(Boolean(initialDraft?.paymentConfirmed));
  const [isCheckoutSubmitting, setIsCheckoutSubmitting] = useState(false);
  const [holdBillDialogOpen, setHoldBillDialogOpen] = useState(false);
  const [holdCustomerName, setHoldCustomerName] = useState('');
  const [digitalContactModal, setDigitalContactModal] = useState(null);
  const [digitalContactDraft, setDigitalContactDraft] = useState({ name: '', phone: '' });
  const [digitalContactError, setDigitalContactError] = useState('');
  const [printMode, setPrintMode] = useState(initialDraft?.printMode || 'Thermal');
  const [cashReceived, setCashReceived] = useState('');
  const [cashReceivedFlashToken, setCashReceivedFlashToken] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [invoiceHistory, setInvoiceHistory] = useState([]);
  const [historySearch, setHistorySearch] = useState('');
  const [historyDate, setHistoryDate] = useState('');
  const [heldBills, setHeldBills] = useState([]);
  const [isLastBillOpen, setIsLastBillOpen] = useState(false);
  const [isHeldBillsOpen, setIsHeldBillsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPriceCheck, setShowPriceCheck] = useState(false);
  const [priceCheckQuery, setPriceCheckQuery] = useState('');
  const [priceCheckProduct, setPriceCheckProduct] = useState(null);
  const [priceCheckError, setPriceCheckError] = useState('');
  const [isCheckingPrice, setIsCheckingPrice] = useState(false);
  const [printableInvoice, setPrintableInvoice] = useState(null);
  const [loyaltyCustomer, setLoyaltyCustomer] = useState(null);
  const [returnInvoice, setReturnInvoice] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState('');
  const [refundMode, setRefundMode] = useState('Cash');
  const scannerRef = useRef(null);
  const exactProductCacheRef = useRef(new Map());
  const scannerKeyTimesRef = useRef([]);
  const scannerAutoAddTimerRef = useRef(null);
  const scannerInputModeRef = useRef('keyboard');
  const suppressSuggestionsUntilKeyboardInputRef = useRef(false);
  const scannerScanTokenRef = useRef(0);
  const scannerReadQueueRef = useRef([]);
  const isScannerReadQueueProcessingRef = useRef(false);
  const scannerBufferRef = useRef('');
  const scannerBufferLastKeyAtRef = useRef(0);
  const scannerBufferTimerRef = useRef(null);
  const searchFocusTimerRef = useRef(null);
  const exchangeScannerBufferRef = useRef('');
  const exchangeScannerBufferLastKeyAtRef = useRef(0);
  const exchangeScannerBufferTimerRef = useRef(null);
  const exchangeScannerInputModeRef = useRef('keyboard');
  const holdBillShortcutKeysRef = useRef({ ctrl: false, alt: false });
  const holdBillShortcutPressedRef = useRef(false);
  const checkoutInFlightRef = useRef(false);
  const previousExchangeModeRef = useRef(exchangeMode);
  const priceCheckKeyTimesRef = useRef([]);
  const lastPriceCheckScanRef = useRef('');
  const exchangeScannerRef = useRef(null);
  const billingTableRef = useRef(null);
  const lastBillDetailsRef = useRef(null);
  const heldBillsDetailsRef = useRef(null);
  const priceCheckInputRef = useRef(null);
  const customerNameRef = useRef(null);
  const cashReceivedRef = useRef(null);
  const mixedCashRef = useRef(null);
  const mixedUpiRef = useRef(null);
  const mixedCardRef = useRef(null);
  const holdCustomerNameRef = useRef(null);
  const customerPhoneRef = useRef(null);
  const customerGstinRef = useRef(null);
  const customerAddressRef = useRef(null);
  const paymentReferenceRef = useRef(null);
  const digitalContactNameRef = useRef(null);
  const digitalContactPhoneRef = useRef(null);
  const canManageInvoice = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const canSelectCounter = ['SERVER', 'ADMIN'].includes(currentUser?.role);
  const activeMode = BILLING_MODES[billingMode];
  const activeSaleMode = activeMode.tier === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL';
  const activeTaxMode = activeMode.taxType === 'INTERSTATE' ? 'IGST' : 'GST';

  useEffect(() => {
    if (!canSelectCounter && currentUser?.counter_no) {
      setCounterNo(Number(currentUser.counter_no));
    }
    scannerRef.current?.focus();
    loadSettings();
    refreshHistory(false);
  }, []);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = window.setTimeout(() => {
      scannerRef.current?.focus();
      scannerRef.current?.select?.();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;

    const shouldPauseSearchFocus = () => (
      Boolean(approvalDialog)
      || Boolean(digitalContactModal)
      || holdBillDialogOpen
      || showHistory
      || showPriceCheck
      || Boolean(returnInvoice)
    );

    const focusSearchInput = () => {
      if (!isActive || shouldPauseSearchFocus()) return;
      if (!document.hasFocus()) return;
      const scanner = scannerRef.current;
      if (!scanner || document.activeElement === scanner) return;
      const activeElement = document.activeElement;
      const isEditableTarget = activeElement?.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement?.tagName);
      if (isEditableTarget) return;
      scanner.focus();
      scanner.select?.();
    };

    const delayedFocus = () => {
      if (searchFocusTimerRef.current) window.clearTimeout(searchFocusTimerRef.current);
      searchFocusTimerRef.current = window.setTimeout(() => {
        searchFocusTimerRef.current = null;
        focusSearchInput();
      }, 1200);
    };
    const interval = window.setInterval(focusSearchInput, 1800);
    delayedFocus();

    window.addEventListener('focus', focusSearchInput);
    document.addEventListener('focusin', delayedFocus);

    return () => {
      if (searchFocusTimerRef.current) {
        window.clearTimeout(searchFocusTimerRef.current);
        searchFocusTimerRef.current = null;
      }
      window.clearInterval(interval);
      window.removeEventListener('focus', focusSearchInput);
      document.removeEventListener('focusin', delayedFocus);
    };
  }, [approvalDialog, digitalContactModal, holdBillDialogOpen, isActive, returnInvoice, showHistory, showPriceCheck]);

  useEffect(() => {
    const wasExchangeMode = previousExchangeModeRef.current;
    previousExchangeModeRef.current = exchangeMode;
    if (!isActive || !exchangeMode || wasExchangeMode) return undefined;

    const timer = window.setTimeout(() => {
      exchangeScannerRef.current?.focus();
      exchangeScannerRef.current?.select?.();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [exchangeMode, isActive]);

  useEffect(() => {
    const hasBillLines = cart.length > 0 || exchangeItems.length > 0;
    const hasDraft = hasBillLines && (
      exchangeMode
      || billingMode !== RETAIL_MODE
      || customerName
      || customerAddress
      || customerPhone
      || companyName
      || customerGstin
      || paymentMode !== 'Cash'
      || Object.values(mixedPayment).some(Boolean)
      || paymentReference
      || paymentConfirmed
      || printMode !== 'Thermal'
      || cart.length > 0
      || exchangeItems.length > 0
    );

    if (!hasDraft) {
      clearActivePosDraft();
      return;
    }

    try {
      window.localStorage.setItem(POS_DRAFT_KEY, JSON.stringify({
        username: currentUser?.username,
        invoiceNo,
        counterNo,
        cart,
        exchangeMode,
        exchangeItems,
        billingMode,
        customerName,
        customerAddress,
        customerPhone,
        companyName,
        customerGstin,
        paymentMode,
        mixedPayment,
        paymentReference,
        paymentConfirmed,
        printMode,
        savedAt: new Date().toISOString()
      }));
    } catch (err) {
      // Keep billing usable even if browser storage is unavailable.
    }
  }, [billingMode, cart, cashReceived, companyName, counterNo, currentUser?.username, customerAddress, customerGstin, customerName, customerPhone, exchangeItems, exchangeMode, invoiceNo, mixedPayment, paymentConfirmed, paymentMode, paymentReference, printMode]);

  useEffect(() => {
    if (!isActive) return undefined;
    setLiveTime(new Date());
    const timer = window.setInterval(() => setLiveTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);

  useEffect(() => {
    refreshInvoicePreview(counterNo);
    refreshHeldBills(counterNo);
  }, [counterNo]);

  useEffect(() => {
    if (!billingTableRef.current) return;
    billingTableRef.current.scrollTop = billingTableRef.current.scrollHeight;
  }, [cart.length]);

  useEffect(() => {
    setSelectedCartIndex((current) => {
      if (cart.length === 0) return -1;
      if (current < 0) return cart.length - 1;
      return Math.min(current, cart.length - 1);
    });
  }, [cart.length]);

  useEffect(() => {
    const run = async () => {
      const { search: cleaned } = parseQuantitySearch(query);
      if (cleaned.length < 3) {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }

      if (suppressSuggestionsUntilKeyboardInputRef.current) {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }

      if (scannerInputModeRef.current !== 'keyboard') {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }

      if (isLikelyScannerInput(cleaned, scannerKeyTimesRef)) {
        setSuggestions([]);
        setSelectedSuggestion(0);
        return;
      }

      try {
        const results = await searchProducts(cleaned);
        if (suppressSuggestionsUntilKeyboardInputRef.current || scannerInputModeRef.current !== 'keyboard') {
          setSuggestions([]);
          setSelectedSuggestion(0);
          return;
        }
        setSuggestions(results.slice(0, 5));
        setSelectedSuggestion(0);
      } catch (err) {
        setSuggestions([]);
      }
    };

    const timer = window.setTimeout(run, TYPED_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const { search: cleaned, quantity } = parseQuantitySearch(query);
    if (!cleaned || !SCANNER_BARCODE_PATTERN.test(cleaned)) return undefined;
    if (scannerInputModeRef.current !== 'keyboard' || suppressSuggestionsUntilKeyboardInputRef.current) return undefined;

    const timer = window.setTimeout(async () => {
      if (scannerInputModeRef.current !== 'keyboard' || suppressSuggestionsUntilKeyboardInputRef.current) return;
      if (scannerBufferRef.current || scannerBufferTimerRef.current) return;
      try {
        const exactProduct = await findExactProductFast(cleaned);
        if (!exactProduct) return;
        if (String(scannerRef.current?.value || '').trim().toUpperCase() !== cleaned.toUpperCase()) return;
        addProduct(exactProduct, quantity);
      } catch (err) {
        setErrorMessage(err.response?.data?.error || 'Product lookup failed.');
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => () => {
    if (scannerAutoAddTimerRef.current) {
      window.clearTimeout(scannerAutoAddTimerRef.current);
    }
    if (scannerBufferTimerRef.current) {
      window.clearTimeout(scannerBufferTimerRef.current);
    }
    if (exchangeScannerBufferTimerRef.current) {
      window.clearTimeout(exchangeScannerBufferTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return undefined;

    const resetHoldBillShortcut = () => {
      holdBillShortcutKeysRef.current = { ctrl: false, alt: false };
      holdBillShortcutPressedRef.current = false;
    };

    const handleShortcut = (event) => {
      const keyName = event.key || '';
      if (keyName === 'Control') holdBillShortcutKeysRef.current.ctrl = true;
      if (keyName === 'Alt') holdBillShortcutKeysRef.current.alt = true;
      holdBillShortcutKeysRef.current = {
        ctrl: holdBillShortcutKeysRef.current.ctrl || event.ctrlKey,
        alt: holdBillShortcutKeysRef.current.alt || event.altKey
      };
      const isHoldBillShortcut = (event.ctrlKey && event.altKey)
        || (holdBillShortcutKeysRef.current.ctrl && holdBillShortcutKeysRef.current.alt);

      if (isHoldBillShortcut && !holdBillShortcutPressedRef.current) {
        event.preventDefault();
        event.stopPropagation();
        holdBillShortcutPressedRef.current = true;
        openHoldBillDialog();
        return;
      }

      if (event.key === 'Delete') {
        const target = event.target;
        const isScannerInputWithText = target === scannerRef.current && String(query || '').length > 0;
        const isEditableTarget = target?.isContentEditable
          || ['TEXTAREA', 'SELECT'].includes(target?.tagName)
          || (target?.tagName === 'INPUT' && target !== scannerRef.current)
          || isScannerInputWithText;

        if (!isEditableTarget && cart.length > 0) {
          event.preventDefault();
          removeLine(selectedCartIndex >= 0 ? selectedCartIndex : cart.length - 1);
        }
      }

      const keyCode = event.keyCode || event.which;
      const isF9 = keyName === 'F9' || event.code === 'F9' || keyCode === 120;
      const isF8 = keyName === 'F8' || event.code === 'F8' || keyCode === 119;
      const isF6 = keyName === 'F6' || event.code === 'F6' || keyCode === 117;
      const isF10 = keyName === 'F10' || event.code === 'F10' || keyCode === 121;
      const isF11 = keyName === 'F11' || event.code === 'F11' || keyCode === 122;
      const isF12 = keyName === 'F12' || event.code === 'F12' || keyCode === 123;

      if (isF9) {
        event.preventDefault();
        event.stopPropagation();
        closeBillingActivityPanels();
        scannerRef.current?.focus();
      }

      if (isF8) {
        event.preventDefault();
        event.stopPropagation();
        setIsLastBillOpen(false);
        setIsHeldBillsOpen(false);
        refreshHistory(true);
      }

      if (isF6) {
        event.preventDefault();
        event.stopPropagation();
        setShowHistory(false);
        setIsLastBillOpen(false);
        setIsHeldBillsOpen((current) => !current);
        refreshHeldBills(counterNo);
      }

      if (isF10) {
        event.preventDefault();
        event.stopPropagation();
        preparePayment('Card', true);
      }

      if (isF11) {
        event.preventDefault();
        event.stopPropagation();
        preparePayment('UPI', true);
      }

      if (isF12) {
        event.preventDefault();
        event.stopPropagation();
        prepareExactCashPayment();
      }
    };

    const handleShortcutKeyUp = (event) => {
      if (event.key === 'Control' || !event.ctrlKey) holdBillShortcutKeysRef.current.ctrl = false;
      if (event.key === 'Alt' || !event.altKey) holdBillShortcutKeysRef.current.alt = false;
      if (!event.ctrlKey || !event.altKey) {
        holdBillShortcutPressedRef.current = false;
      }
    };

    window.addEventListener('keydown', handleShortcut, true);
    window.addEventListener('keyup', handleShortcutKeyUp);
    window.addEventListener('blur', resetHoldBillShortcut);
    document.addEventListener('visibilitychange', resetHoldBillShortcut);
    return () => {
      window.removeEventListener('keydown', handleShortcut, true);
      window.removeEventListener('keyup', handleShortcutKeyUp);
      window.removeEventListener('blur', resetHoldBillShortcut);
      document.removeEventListener('visibilitychange', resetHoldBillShortcut);
    };
  });

  useEffect(() => {
    if (!showPriceCheck) return undefined;
    const cleaned = String(priceCheckQuery || '').trim();
    if (!/^[A-Z0-9._-]{6,}$/i.test(cleaned)) return undefined;
    const timer = window.setTimeout(() => autoRunScannedPriceCheck(cleaned), 70);
    return () => window.clearTimeout(timer);
  }, [priceCheckQuery, showPriceCheck]);

  useEffect(() => {
    if (!isActive || (!isLastBillOpen && !isHeldBillsOpen)) return undefined;

    const closeActivityPanelsOnOutsideClick = (event) => {
      const target = event.target;
      if (isLastBillOpen && lastBillDetailsRef.current && !lastBillDetailsRef.current.contains(target)) {
        setIsLastBillOpen(false);
      }
      if (isHeldBillsOpen && heldBillsDetailsRef.current && !heldBillsDetailsRef.current.contains(target)) {
        setIsHeldBillsOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeActivityPanelsOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeActivityPanelsOnOutsideClick);
  }, [isActive, isHeldBillsOpen, isLastBillOpen]);

  useEffect(() => {
    const { search: cleaned } = parseQuantitySearch(exchangeQuery);
    if (!exchangeMode || !cleaned || !SCANNER_BARCODE_PATTERN.test(cleaned)) return undefined;
    if (exchangeScannerInputModeRef.current !== 'keyboard') return undefined;

    const timer = window.setTimeout(async () => {
      if (exchangeScannerInputModeRef.current !== 'keyboard') return;
      if (exchangeScannerBufferRef.current || exchangeScannerBufferTimerRef.current) return;
      if (String(exchangeScannerRef.current?.value || '').trim().toUpperCase() !== cleaned.toUpperCase()) return;
      await addExchangeProductByExactScan(cleaned);
    }, 650);

    return () => window.clearTimeout(timer);
  }, [exchangeMode, exchangeQuery]);

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

    const saleGrand = taxable + tax;
    const exchangeTotal = exchangeItems.reduce((sum, item) => {
      const quantity = toNumber(item.quantity, 1);
      return sum + toNumber(item.unitPrice || item.sale_price || item.mrp) * quantity;
    }, 0);
    const netGrand = Math.max(saleGrand - exchangeTotal, 0);
    const isInterstate = BILLING_MODES[billingMode].taxType === 'INTERSTATE';
    return {
      taxable,
      tax,
      discount,
      saleGrand,
      exchangeTotal,
      grand: netGrand,
      cgst: isInterstate ? 0 : tax / 2,
      sgst: isInterstate ? 0 : tax / 2,
      igst: isInterstate ? tax : 0
    };
  }, [cart, billingMode, exchangeItems]);

  const mixedPaidTotal = toNumber(mixedPayment.cash) + toNumber(mixedPayment.upi) + toNumber(mixedPayment.card);
  const mixedPaymentModeCount = [mixedPayment.cash, mixedPayment.upi, mixedPayment.card]
    .filter((amount) => toNumber(amount) > 0).length;
  const mixedHasDigital = toNumber(mixedPayment.upi) > 0 || toNumber(mixedPayment.card) > 0;
  const changeDue = Math.max((paymentMode === 'Mixed' ? mixedPaidTotal : toNumber(cashReceived)) - totals.grand, 0);
  const cashReceivedAmount = toNumber(cashReceived);
  const isCashReady = paymentMode === 'Mixed'
    ? mixedPaymentModeCount >= 2 && mixedPaidTotal >= totals.grand
    : paymentMode !== 'Cash' || cashReceivedAmount >= totals.grand;
  const canCompleteSale = cart.length > 0 && isCashReady && !cart.some((item) => item.isUnknown) && !isCheckoutSubmitting;
  const hasUnknownLine = cart.some((item) => item.isUnknown);
  const latestInvoice = invoiceHistory[0];
  const filteredInvoiceHistory = useMemo(() => {
    const search = historySearch.trim().toLowerCase();

    return invoiceHistory.filter((invoice) => {
      const createdAt = invoice.created_at ? new Date(invoice.created_at) : null;
      const hasValidDate = createdAt && !Number.isNaN(createdAt.getTime());
      const isoDate = hasValidDate ? createdAt.toISOString().slice(0, 10) : '';
      const displayDate = hasValidDate ? createdAt.toLocaleString().toLowerCase() : '';
      const searchableText = [
        invoice.invoice_no,
        invoice.customer_name,
        invoice.payment_mode,
        invoice.invoice_status,
        displayDate
      ].filter(Boolean).join(' ').toLowerCase();

      return (!search || searchableText.includes(search)) && (!historyDate || isoDate === historyDate);
    });
  }, [historyDate, historySearch, invoiceHistory]);
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
      paymentReference,
      paymentSplits: paymentMode === 'Mixed' ? [
        { mode: 'Cash', amount: toNumber(mixedPayment.cash) },
        { mode: 'UPI', amount: toNumber(mixedPayment.upi), reference: mixedPayment.upi_reference },
        { mode: 'Card', amount: toNumber(mixedPayment.card), reference: mixedPayment.card_reference }
      ].filter((row) => row.amount > 0) : [],
      cashReceived: paymentMode === 'Mixed' ? mixedPaidTotal : toNumber(cashReceived),
      changeReturned: changeDue,
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
      exchangeItems: exchangeItems.map((item) => ({
        ...item,
        quantity: toNumber(item.quantity, 1),
        unitPrice: toNumber(item.unitPrice || item.sale_price || item.mrp),
        lineTotal: toNumber(item.unitPrice || item.sale_price || item.mrp) * toNumber(item.quantity, 1)
      })),
      totals: {
        ...totals,
        grand: roundedGrand,
        roundOff: roundedGrand - totals.grand,
        cgst: isInterstate ? 0 : totals.tax / 2,
        sgst: isInterstate ? 0 : totals.tax / 2,
        igst: isInterstate ? totals.tax : 0
      }
    };
  }, [billingMode, cart, cashReceived, changeDue, companyName, counterNo, customerAddress, customerGstin, customerName, customerPhone, exchangeItems, invoiceDate, invoiceNo, mixedPaidTotal, mixedPayment, paymentMode, shopSettings, totals]);

  function closeBillingActivityPanels() {
    setShowHistory(false);
    setIsLastBillOpen(false);
    setIsHeldBillsOpen(false);
  }

  function invoiceDetailsToPrintable(details, duplicate = false) {
    const invoice = details.invoice;
    const isInterstate = invoice.tax_type === 'INTERSTATE';
    let exchangeItemsFromInvoice = [];
    try {
      const rawExchange = invoice.exchange_items_json;
      exchangeItemsFromInvoice = Array.isArray(rawExchange)
        ? rawExchange
        : JSON.parse(rawExchange || '[]');
    } catch (err) {
      exchangeItemsFromInvoice = [];
    }
    const items = details.items.map((item) => {
      const unitPrice = toNumber(item.sale_price);
      const quantity = toNumber(item.quantity);
      const gstPercent = toNumber(item.gst_percent);
      const lineTotal = unitPrice * quantity;
      const taxableRate = unitPrice / (1 + gstPercent / 100);

      return {
        ...item,
        is_free_bonus: Boolean(item.is_free_bonus),
        unitPrice,
        quantity,
        gst_percent: gstPercent,
        lineTotal,
        taxableRate,
        taxAmount: lineTotal - taxableRate * quantity
      };
    });

    return {
      invoiceNo: invoice.invoice_no,
      isDuplicate: duplicate,
      counterNo: String(invoice.billing_counter || '').replace(/\D/g, '') || 1,
      date: invoice.created_at ? new Date(invoice.created_at).toLocaleDateString('en-IN') : '',
      time: invoice.created_at ? new Date(invoice.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '',
      shop: shopSettings,
      customerName: invoice.customer_name,
      customerAddress: invoice.customer_address || '',
      customerPhone: invoice.customer_phone,
      customerGstin: invoice.customer_gstin,
      paymentMode: invoice.payment_mode,
      paymentReference: invoice.payment_reference || '',
      paymentSplits: (details.payments || []).map((payment) => ({
        mode: payment.payment_mode,
        amount: toNumber(payment.amount),
        reference: payment.payment_reference || ''
      })),
      cashReceived: toNumber(invoice.cash_received),
      changeReturned: toNumber(invoice.change_returned),
      taxType: invoice.tax_type,
      itemCount: items.reduce((sum, item) => sum + toNumber(item.quantity), 0),
      items,
      exchangeItems: exchangeItemsFromInvoice.map((item) => ({
        ...item,
        quantity: toNumber(item.quantity, 1),
        unitPrice: toNumber(item.sale_price || item.unitPrice),
        lineTotal: toNumber(item.line_total || item.lineTotal || (toNumber(item.sale_price || item.unitPrice) * toNumber(item.quantity, 1)))
      })),
      totals: {
        taxable: toNumber(invoice.sub_total),
        tax: toNumber(invoice.gst_total),
        discount: 0,
        saleGrand: toNumber(invoice.sub_total) + toNumber(invoice.gst_total),
        exchangeTotal: toNumber(invoice.exchange_total),
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

  useEffect(() => {
    if (isDigitalPaymentContactReady(customerPhone) && errorMessage.includes('customer phone number or type NO')) {
      setErrorMessage('');
    }
  }, [customerPhone, errorMessage]);

  useEffect(() => {
    if (!errorMessage.includes('Add at least one item before holding a bill')) return undefined;
    if (cart.length > 0) {
      setErrorMessage('');
      return undefined;
    }

    const timer = window.setTimeout(() => setErrorMessage(''), 2500);
    return () => window.clearTimeout(timer);
  }, [cart.length, errorMessage]);

  useEffect(() => {
    const query = (isBusinessBillingMode(billingMode) ? companyName : customerName).trim();
    if (query.length < 3) {
      setCustomerSuggestions([]);
      setIsCustomerLookupOpen(false);
      setIsCustomerSuggestionLoading(false);
      return undefined;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsCustomerSuggestionLoading(true);
      try {
        const rows = await fetchCustomers(query);
        if (!cancelled) {
          setCustomerSuggestions(rows.slice(0, 3));
          setIsCustomerLookupOpen(rows.length > 0);
        }
      } catch (err) {
        if (!cancelled) {
          setCustomerSuggestions([]);
          setIsCustomerLookupOpen(false);
        }
      } finally {
        if (!cancelled) setIsCustomerSuggestionLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [billingMode, companyName, customerName]);

  async function loadSettings() {
    try {
      const settings = await fetchSettings();
      setShopSettings(settings);
      setPrintMode(settings.default_print_mode || 'Thermal');
      const nextCounterCount = Number(settings.counter_count || 6);
      setCounterCount(nextCounterCount);
      setCounterNo((current) => {
        if (!canSelectCounter && currentUser?.counter_no) {
          return Math.min(Number(currentUser.counter_no), nextCounterCount);
        }
        return Math.min(current, nextCounterCount);
      });
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

  function selectCustomerSuggestion(customer) {
    const nextName = customer.customer_name || '';
    if (isBusinessBillingMode(billingMode)) {
      setCompanyName(nextName);
    } else {
      setCustomerName(nextName);
    }
    setCustomerPhone(customer.phone || '');
    setCustomerAddress(customer.address || '');
    setCustomerGstin(String(customer.gstin || '').toUpperCase());
    setLoyaltyCustomer(customer);
    setCustomerSuggestions([]);
    setIsCustomerLookupOpen(false);
    setStatusMessage(`${nextName || 'Customer'} loaded from customer master.`);
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

  async function refreshInvoicePreview(activeCounterNo = counterNo, force = false) {
    if (!force && cart.length > 0) return;
    try {
      const nextInvoice = await fetchNextInvoice(activeCounterNo);
      setInvoiceNo(nextInvoice.invoice_no || 'Draft');
    } catch (err) {
      setInvoiceNo('Draft');
    }
  }

  function parseQuantitySearch(rawValue) {
    const cleaned = String(rawValue || '').trim();
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*\*\s*(.+)$/) || cleaned.match(/^(.+?)\s*\*\s*(\d+(?:\.\d+)?)$/);
    if (!match) return { search: cleaned, quantity: 1 };

    const firstIsQuantity = /^\d+(?:\.\d+)?$/.test(match[1]);
    const quantity = toNumber(firstIsQuantity ? match[1] : match[2], 1);
    const search = String(firstIsQuantity ? match[2] : match[1]).trim();
    return {
      search,
      quantity: quantity > 0 ? quantity : 1
    };
  }

  async function findExactProductFast(searchValue) {
    const key = String(searchValue || '').trim().toUpperCase();
    if (!key) return null;
    if (exactProductCacheRef.current.has(key)) {
      return exactProductCacheRef.current.get(key);
    }
    const product = await lookupExactProduct(key);
    if (product) {
      exactProductCacheRef.current.set(key, product);
    }
    return product;
  }

  function markRapidInputKey(event, targetRef = scannerKeyTimesRef) {
    if (event.key.length !== 1) return;
    const now = Date.now();
    targetRef.current = [...targetRef.current.filter((time) => now - time < 450), now];
  }

  function isLikelyScannerInput(value, targetRef = scannerKeyTimesRef) {
    const cleaned = String(value || '').trim();
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return false;
    if (cleaned.length < 6) return false;
    const times = targetRef.current;
    if (times.length < Math.min(cleaned.length, 6)) return false;
    const first = times[0];
    const last = times[times.length - 1];
    return last - first <= 350;
  }

  function scheduleScannedBarcodeAutoAdd(rawValue, options = {}) {
    if (scannerAutoAddTimerRef.current) {
      window.clearTimeout(scannerAutoAddTimerRef.current);
    }
    const scanToken = scannerScanTokenRef.current + 1;
    scannerScanTokenRef.current = scanToken;
    scannerAutoAddTimerRef.current = window.setTimeout(() => {
      scannerAutoAddTimerRef.current = null;
      autoAddScannedBarcode(rawValue, { ...options, scanToken });
    }, SCANNER_SETTLE_MS);
  }

  function enqueueScannerRead(rawValue) {
    const { search: cleaned, quantity } = parseQuantitySearch(rawValue);
    const normalized = cleaned.toUpperCase();
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;

    scannerReadQueueRef.current.push({ barcode: normalized, quantity });
    if (scannerInputModeRef.current !== 'scan') {
      resetScannerBuffer();
    }
    scannerInputModeRef.current = 'keyboard';
    suppressSuggestionsUntilKeyboardInputRef.current = true;
    scannerKeyTimesRef.current = [];
    setQuery('');
    setSuggestions([]);
    setSelectedSuggestion(0);
    processScannerReadQueue();
  }

  function resetScannerBuffer() {
    scannerBufferRef.current = '';
    scannerBufferLastKeyAtRef.current = 0;
    if (scannerBufferTimerRef.current) {
      window.clearTimeout(scannerBufferTimerRef.current);
      scannerBufferTimerRef.current = null;
    }
  }

  function commitScannerBuffer() {
    const bufferedValue = scannerBufferRef.current;
    resetScannerBuffer();
    const { search: cleaned } = parseQuantitySearch(bufferedValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;
    enqueueScannerRead(bufferedValue);
  }

  function scheduleScannerBufferCommit() {
    if (scannerBufferTimerRef.current) {
      window.clearTimeout(scannerBufferTimerRef.current);
    }
    scannerBufferTimerRef.current = window.setTimeout(() => {
      scannerBufferTimerRef.current = null;
      if (scannerBufferRef.current.length >= 2) {
        commitScannerBuffer();
      }
    }, SCANNER_SETTLE_MS);
  }

  function bufferScannerKey(event) {
    const now = Date.now();

    if (event.key === 'Enter' || event.key === 'Tab') {
      if (scannerBufferRef.current) {
        event.preventDefault();
        commitScannerBuffer();
        return true;
      }
      return false;
    }

    if (event.key.length !== 1 || !SCANNER_BARCODE_PATTERN.test(event.key)) return false;

    const gap = now - scannerBufferLastKeyAtRef.current;
    if (!scannerBufferRef.current || gap <= SCANNER_FAST_KEY_MS || scannerInputModeRef.current === 'scan') {
      scannerBufferRef.current += event.key;
    } else {
      scannerBufferRef.current = event.key;
    }
    scannerBufferLastKeyAtRef.current = now;

    if (scannerBufferRef.current.length >= 2 && (gap <= SCANNER_FAST_KEY_MS || scannerInputModeRef.current === 'scan')) {
      scannerInputModeRef.current = 'scan';
      suppressSuggestionsUntilKeyboardInputRef.current = true;
      setSuggestions([]);
      setSelectedSuggestion(0);
      scheduleScannerBufferCommit();
    }

    return scannerInputModeRef.current === 'scan';
  }

  async function processScannerReadQueue() {
    if (isScannerReadQueueProcessingRef.current) return;
    isScannerReadQueueProcessingRef.current = true;

    try {
      while (scannerReadQueueRef.current.length > 0) {
        const scanRead = scannerReadQueueRef.current.shift();
        try {
          const exactProduct = await findExactProductFast(scanRead.barcode);
          if (exactProduct) {
            addProduct(exactProduct, scanRead.quantity);
          } else {
            setErrorMessage(`Scanned barcode ${scanRead.barcode} was not found.`);
          }
        } catch (err) {
          setErrorMessage(err.response?.data?.error || 'Product lookup failed.');
        }
      }
    } finally {
      isScannerReadQueueProcessingRef.current = false;
    }
  }

  async function autoAddScannedBarcode(rawValue, { forceExact = false, scanToken = null } = {}) {
    const { search: cleaned } = parseQuantitySearch(rawValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;
    if (!forceExact && !isLikelyScannerInput(cleaned, scannerKeyTimesRef)) return;
    if (scanToken !== null && scanToken !== scannerScanTokenRef.current) return;
    enqueueScannerRead(rawValue);
  }

  function handleSearchChange(event) {
    const nextQuery = event.target.value;
    const nativeEvent = event.nativeEvent || {};
    const insertedText = String(nativeEvent.data || '');
    const isPasteLikeInput = nativeEvent.inputType === 'insertFromPaste'
      || insertedText.length > 1
      || Math.abs(nextQuery.length - query.length) > 1;
    const { search: cleaned } = parseQuantitySearch(nextQuery);

    if (isPasteLikeInput && SCANNER_BARCODE_PATTERN.test(cleaned)) {
      scannerInputModeRef.current = 'scan';
      suppressSuggestionsUntilKeyboardInputRef.current = true;
      setQuery(nextQuery);
      setSuggestions([]);
      setSelectedSuggestion(0);
      scheduleScannedBarcodeAutoAdd(nextQuery, { forceExact: true });
      return;
    }

    scannerInputModeRef.current = 'keyboard';
    suppressSuggestionsUntilKeyboardInputRef.current = false;
    setQuery(nextQuery);

    if (isLikelyScannerInput(cleaned, scannerKeyTimesRef)) {
      scannerInputModeRef.current = 'scan';
      suppressSuggestionsUntilKeyboardInputRef.current = true;
      setSuggestions([]);
      setSelectedSuggestion(0);
    }
  }

  function handleSearchPaste(event) {
    const pastedValue = event.clipboardData?.getData('text') || '';
    const { search: cleaned } = parseQuantitySearch(pastedValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;

    event.preventDefault();
    scannerInputModeRef.current = 'scan';
    suppressSuggestionsUntilKeyboardInputRef.current = true;
    setQuery(pastedValue);
    setSuggestions([]);
    setSelectedSuggestion(0);
    scheduleScannedBarcodeAutoAdd(pastedValue, { forceExact: true });
  }

  function addProduct(product, quantityToAdd = 1) {
    const addQty = Math.max(toNumber(quantityToAdd, 1), 0.001);
    const productBarcode = String(product.barcode || '').trim().toUpperCase();
    const productCode = String(product.product_code || '').trim().toUpperCase();
    setCart((current) => {
      const existingIndex = current.findIndex((item) => {
        const itemBarcode = String(item.barcode || '').trim().toUpperCase();
        const itemCode = String(item.product_code || '').trim().toUpperCase();
        return itemBarcode === productBarcode || Boolean(productCode && itemCode === productCode);
      });
      if (existingIndex >= 0) {
        setSelectedCartIndex(existingIndex);
        return current.map((item, index) => (
          index === existingIndex ? { ...item, quantity: toNumber(item.quantity, 1) + addQty } : item
        ));
      }

      setSelectedCartIndex(current.length);
      return [
        ...current,
        {
          ...product,
          barcode: productBarcode || product.barcode,
          product_name: String(product.product_name || '').toUpperCase(),
          quantity: addQty,
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
    setStatusMessage(`${product.product_name} x ${addQty} added to bill.`);
    scannerRef.current?.focus();
  }

  function openPriceCheck() {
    setShowPriceCheck(true);
    setPriceCheckQuery('');
    setPriceCheckProduct(null);
    setPriceCheckError('');
    setIsCheckingPrice(false);
    window.setTimeout(() => priceCheckInputRef.current?.focus(), 50);
  }

  function closePriceCheck() {
    setShowPriceCheck(false);
    setPriceCheckQuery('');
    setPriceCheckProduct(null);
    setPriceCheckError('');
    setIsCheckingPrice(false);
    scannerRef.current?.focus();
  }

  function getProductOfferText(product) {
    const discountValue = toNumber(product?.discount_value);
    const bulkDiscount = toNumber(product?.bulk_discount_value);
    const discountType = product?.discount_type === 'VALUE' ? 'Rs' : '%';
    if (discountValue > 0 && bulkDiscount > 0) {
      return `${discountValue}${discountType} retail, ${bulkDiscount}% wholesale`;
    }
    if (discountValue > 0) return `${discountValue}${discountType} discount`;
    if (bulkDiscount > 0) return `${bulkDiscount}% wholesale discount`;
    const mrp = toNumber(product?.mrp);
    const salePrice = toNumber(product?.sale_price);
    if (mrp > salePrice && salePrice > 0) return `${formatMoney(mrp - salePrice)} less than MRP`;
    return 'No active offer';
  }

  async function runPriceCheck(searchValue = priceCheckQuery) {
    const cleaned = String(searchValue || '').trim();
    if (!cleaned) {
      setPriceCheckError('Scan barcode or type product name.');
      setPriceCheckProduct(null);
      return;
    }

    setIsCheckingPrice(true);
    setPriceCheckError('');
    try {
      const results = await searchProducts(cleaned);
      if (results.length === 1) {
        setPriceCheckProduct(results[0]);
        setPriceCheckError('');
        return;
      }
      if (results.length > 1) {
        const exact = results.find((product) => (
          String(product.barcode || '').toUpperCase() === cleaned.toUpperCase()
          || String(product.product_code || '').toUpperCase() === cleaned.toUpperCase()
        ));
        if (exact) {
          setPriceCheckProduct(exact);
          setPriceCheckError('');
          return;
        }
        setPriceCheckProduct(null);
        setPriceCheckError('Multiple products found. Scan exact barcode or type full product name.');
        return;
      }
      setPriceCheckProduct(null);
      setPriceCheckError('Product not found.');
    } catch (err) {
      setPriceCheckProduct(null);
      setPriceCheckError(err.response?.data?.error || 'Unable to check price.');
    } finally {
      setIsCheckingPrice(false);
    }
  }

  async function autoRunScannedPriceCheck(rawValue) {
    const cleaned = String(rawValue || '').trim();
    const normalized = cleaned.toUpperCase();
    if (!isLikelyScannerInput(cleaned, priceCheckKeyTimesRef) || lastPriceCheckScanRef.current === normalized) return;
    lastPriceCheckScanRef.current = normalized;

    try {
      const exactProduct = await findExactProductFast(cleaned);
      if (exactProduct) {
        setPriceCheckProduct(exactProduct);
        setPriceCheckError('');
        return;
      }
      await runPriceCheck(cleaned);
    } finally {
      window.setTimeout(() => {
        if (lastPriceCheckScanRef.current === normalized) lastPriceCheckScanRef.current = '';
      }, 250);
    }
  }

  function handlePriceCheckKeyDown(event) {
    markRapidInputKey(event, priceCheckKeyTimesRef);

    if (event.key === 'Enter') {
      event.preventDefault();
      runPriceCheck();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePriceCheck();
    }
  }

  async function handleSearchKeyDown(event) {
    markRapidInputKey(event, scannerKeyTimesRef);
    const handledScannerKey = event.key === 'Enter' ? false : bufferScannerKey(event);
    if (handledScannerKey && (event.key === 'Enter' || event.key === 'Tab')) return;

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
      resetScannerBuffer();
      if (scannerAutoAddTimerRef.current) {
        window.clearTimeout(scannerAutoAddTimerRef.current);
        scannerAutoAddTimerRef.current = null;
      }
      scannerInputModeRef.current = 'keyboard';
      suppressSuggestionsUntilKeyboardInputRef.current = false;
      const { search: cleaned, quantity } = parseQuantitySearch(query);

      if (!cleaned) {
        setErrorMessage('Enter barcode digits or product name.');
        return;
      }

      if (cleaned.length < 3) {
        try {
          const exactShortProduct = SCANNER_BARCODE_PATTERN.test(cleaned)
            ? await findExactProductFast(cleaned)
            : null;
          if (exactShortProduct) {
            addProduct(exactShortProduct, quantity);
            return;
          }
          setErrorMessage('Enter at least 3 letters for product search, or scan/enter an exact barcode.');
        } catch (err) {
          setErrorMessage(err.response?.data?.error || 'Product lookup failed.');
        }
        return;
      }

      if (isLikelyScannerInput(cleaned, scannerKeyTimesRef)) {
        if (scannerAutoAddTimerRef.current) {
          window.clearTimeout(scannerAutoAddTimerRef.current);
          scannerAutoAddTimerRef.current = null;
        }
        scannerInputModeRef.current = 'scan';
        autoAddScannedBarcode(query, { forceExact: true });
        return;
      }

      try {
        const exactProduct = await findExactProductFast(cleaned);
        if (exactProduct) {
          addProduct(exactProduct, quantity);
          return;
        }

        const results = await searchProducts(cleaned);
        const exactFromSearch = results.find((product) => (
          String(product.barcode || '').toUpperCase() === cleaned.toUpperCase()
          || String(product.product_code || '').toUpperCase() === cleaned.toUpperCase()
        ));
        if (exactFromSearch) {
          exactProductCacheRef.current.set(cleaned.toUpperCase(), exactFromSearch);
          addProduct(exactFromSearch, quantity);
          return;
        }
        if (results.length === 1) addProduct(results[0], quantity);
        if (results.length > 1) {
          setSuggestions(results.slice(0, 5));
          setSelectedSuggestion(0);
        }
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
    setCart((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      setSelectedCartIndex(next.length ? Math.min(index, next.length - 1) : -1);
      return next;
    });
    window.setTimeout(() => {
      scannerRef.current?.focus();
      scannerRef.current?.select?.();
    }, 50);
  }

  function addExchangeProduct(product) {
    const unitPrice = toNumber(product.sale_price || product.mrp);
    setExchangeItems((current) => {
      const existingIndex = current.findIndex((item) => item.barcode === product.barcode);
      if (existingIndex >= 0) {
        return current.map((item, index) => (
          index === existingIndex ? { ...item, quantity: toNumber(item.quantity, 1) + 1 } : item
        ));
      }

      return [
        ...current,
        {
          barcode: product.barcode,
          product_name: String(product.product_name || '').toUpperCase(),
          hsn_code: product.hsn_code || '',
          unit_type: product.unit_type || product.unit || '',
          gst_percent: toNumber(product.gst_percent),
          mrp: toNumber(product.mrp),
          sale_price: unitPrice,
          unitPrice,
          quantity: 1
        }
      ];
    });
    setExchangeQuery('');
    setErrorMessage('');
    setStatusMessage(`${product.product_name} added to exchange.`);
    window.setTimeout(() => {
      scannerRef.current?.focus();
      scannerRef.current?.select?.();
    }, 60);
  }

  async function addExchangeProductByExactScan(rawValue) {
    const { search: cleaned } = parseQuantitySearch(rawValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;
    if (exchangeScannerInputModeRef.current !== 'scan') {
      resetExchangeScannerBuffer();
    }
    exchangeScannerInputModeRef.current = 'keyboard';
    setExchangeQuery('');

    try {
      const exactProduct = await findExactProductFast(cleaned);
      if (exactProduct) {
        addExchangeProduct(exactProduct);
        return;
      }
      setErrorMessage(`Exchange barcode ${cleaned.toUpperCase()} not found.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Exchange product lookup failed.');
    }
  }

  function resetExchangeScannerBuffer() {
    exchangeScannerBufferRef.current = '';
    exchangeScannerBufferLastKeyAtRef.current = 0;
    if (exchangeScannerBufferTimerRef.current) {
      window.clearTimeout(exchangeScannerBufferTimerRef.current);
      exchangeScannerBufferTimerRef.current = null;
    }
  }

  function commitExchangeScannerBuffer() {
    const bufferedValue = exchangeScannerBufferRef.current;
    resetExchangeScannerBuffer();
    const { search: cleaned } = parseQuantitySearch(bufferedValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;
    addExchangeProductByExactScan(bufferedValue);
  }

  function scheduleExchangeScannerBufferCommit() {
    if (exchangeScannerBufferTimerRef.current) {
      window.clearTimeout(exchangeScannerBufferTimerRef.current);
    }
    exchangeScannerBufferTimerRef.current = window.setTimeout(() => {
      exchangeScannerBufferTimerRef.current = null;
      if (exchangeScannerBufferRef.current.length >= 2) {
        commitExchangeScannerBuffer();
      }
    }, SCANNER_SETTLE_MS);
  }

  function bufferExchangeScannerKey(event) {
    const now = Date.now();

    if (event.key === 'Enter' || event.key === 'Tab') {
      if (exchangeScannerBufferRef.current) {
        event.preventDefault();
        commitExchangeScannerBuffer();
        return true;
      }
      return false;
    }

    if (event.key.length !== 1 || !SCANNER_BARCODE_PATTERN.test(event.key)) return false;

    const gap = now - exchangeScannerBufferLastKeyAtRef.current;
    if (!exchangeScannerBufferRef.current || gap <= SCANNER_FAST_KEY_MS || exchangeScannerInputModeRef.current === 'scan') {
      exchangeScannerBufferRef.current += event.key;
    } else {
      exchangeScannerBufferRef.current = event.key;
    }
    exchangeScannerBufferLastKeyAtRef.current = now;

    if (exchangeScannerBufferRef.current.length >= 2 && (gap <= SCANNER_FAST_KEY_MS || exchangeScannerInputModeRef.current === 'scan')) {
      exchangeScannerInputModeRef.current = 'scan';
      scheduleExchangeScannerBufferCommit();
    }

    return exchangeScannerInputModeRef.current === 'scan';
  }

  async function handleExchangeSearchKeyDown(event) {
    const handledScannerKey = event.key === 'Enter' ? false : bufferExchangeScannerKey(event);
    if (handledScannerKey && (event.key === 'Enter' || event.key === 'Tab')) return;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    resetExchangeScannerBuffer();
    exchangeScannerInputModeRef.current = 'keyboard';
    const cleaned = exchangeQuery.trim();
    if (!cleaned) {
      setErrorMessage('Enter exchange product barcode or product name.');
      return;
    }

    try {
      if (SCANNER_BARCODE_PATTERN.test(cleaned)) {
        const exactProduct = await findExactProductFast(cleaned);
        if (exactProduct) {
          addExchangeProduct(exactProduct);
          return;
        }
      }
      if (cleaned.length < 3) {
        setErrorMessage('Enter exchange product barcode or at least 3 letters.');
        return;
      }
      const results = await searchProducts(cleaned);
      if (results.length === 0) {
        setErrorMessage('Exchange product not found.');
        return;
      }
      addExchangeProduct(results[0]);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Exchange product lookup failed.');
    }
  }

  function handleExchangeSearchChange(event) {
    const nextQuery = event.target.value;
    const nativeEvent = event.nativeEvent || {};
    const insertedText = String(nativeEvent.data || '');
    const isPasteLikeInput = nativeEvent.inputType === 'insertFromPaste'
      || insertedText.length > 1
      || Math.abs(nextQuery.length - exchangeQuery.length) > 1;
    const { search: cleaned } = parseQuantitySearch(nextQuery);

    if (isPasteLikeInput && SCANNER_BARCODE_PATTERN.test(cleaned)) {
      exchangeScannerInputModeRef.current = 'scan';
      setExchangeQuery(nextQuery);
      window.setTimeout(() => addExchangeProductByExactScan(nextQuery), 0);
      return;
    }

    exchangeScannerInputModeRef.current = 'keyboard';
    setExchangeQuery(nextQuery);
  }

  function handleExchangeSearchPaste(event) {
    const pastedValue = event.clipboardData?.getData('text') || '';
    const { search: cleaned } = parseQuantitySearch(pastedValue);
    if (!SCANNER_BARCODE_PATTERN.test(cleaned)) return;

    event.preventDefault();
    exchangeScannerInputModeRef.current = 'scan';
    setExchangeQuery(pastedValue);
    window.setTimeout(() => addExchangeProductByExactScan(pastedValue), 0);
  }

  function updateExchangeQuantity(index, quantity) {
    setExchangeItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, quantity: Math.max(toNumber(quantity), 0) } : item
    )));
  }

  function removeExchangeLine(index) {
    setExchangeItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function requestExchangeMode() {
    setErrorMessage('');
    setStatusMessage('');
    setApprovalError('');

    if (exchangeMode) {
      setExchangeMode(false);
      setExchangeItems([]);
      setStatusMessage('Exchange bill mode removed.');
      scannerRef.current?.focus();
      return;
    }

    setExchangeMode(true);
    setStatusMessage('Exchange bill enabled.');
    window.setTimeout(() => exchangeScannerRef.current?.focus(), 50);
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
    setCounterNo(canSelectCounter ? savedState.counterNo || 1 : Number(currentUser?.counter_no || counterNo));
    setCart(savedState.cart || []);
    setExchangeMode(Boolean(savedState.exchangeMode));
    setExchangeItems(savedState.exchangeItems || []);
    setBillingMode(normalizeBillingMode(savedState.billingMode));
    setCustomerName(savedState.customerName || '');
    setCustomerAddress(savedState.customerAddress || '');
    setCustomerPhone(savedState.customerPhone || '');
    setCompanyName(savedState.companyName || '');
    setCustomerGstin(savedState.customerGstin || '');
    setPaymentMode(savedState.paymentMode || 'Cash');
    setMixedPayment(savedState.mixedPayment || EMPTY_MIXED_PAYMENT);
    setPaymentReference(savedState.paymentReference || '');
    setPaymentConfirmed(Boolean(savedState.paymentConfirmed));
    setPrintMode(savedState.printMode || 'Thermal');
    setCashReceived('');
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
    clearActivePosDraft();
    setCart([]);
    setExchangeMode(false);
    setExchangeItems([]);
    setExchangeQuery('');
    setBillingMode(RETAIL_MODE);
    setCustomerName('');
    setCustomerAddress('');
    setCustomerPhone('');
    setCompanyName('');
    setCustomerGstin('');
    setCashReceived('');
    setPaymentMode('Cash');
    setMixedPayment(EMPTY_MIXED_PAYMENT);
    setPaymentReference('');
    setPaymentConfirmed(false);
    setPrintMode('Thermal');
    scannerRef.current?.focus();
    refreshInvoicePreview(counterNo, true);
  }

  function printBill(invoice = printableDraft) {
    if (!invoice.items.length) {
      setErrorMessage('Add at least one item before printing.');
      return;
    }

    setPrintableInvoice(invoice);
    schedulePrint(printMode, null, invoice);
  }

  async function printCounterSaleSlip() {
    try {
      const printedAt = new Date();
      const thermalWidthMm = Number(shopSettings.thermal_receipt_width_mm || 80) || 80;
      const defaultSlipHeightMm = 90;
      const thermalFeedMarginMm = getThermalFeedMarginMm(shopSettings);
      const slip = await fetchCounterSaleSlip({ date: localIsoDate(printedAt), counterNo });
      const slipMarkup = renderToStaticMarkup(<CounterSaleSlip slip={slip} shop={shopSettings} printedAt={printedAt} />);
      const slipPrintHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Counter Sale Slip</title>
  <style>
    html, body {
      width: ${thermalWidthMm}mm;
      min-width: ${thermalWidthMm}mm;
      max-width: ${thermalWidthMm}mm;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
      font-family: Arial, Helvetica, sans-serif;
    }
    .counter-sale-slip {
      width: ${thermalWidthMm}mm;
      box-sizing: border-box;
      padding: 3mm 5mm ${thermalFeedMarginMm}mm;
      font-size: 12px;
      line-height: 1.2;
    }
    .counter-sale-slip-title,
    .counter-sale-slip-heading,
    .counter-sale-slip-footer {
      text-align: center;
    }
    .counter-sale-slip-title strong {
      display: block;
      font-size: 15px;
      text-transform: uppercase;
    }
    .counter-sale-slip-title span {
      display: block;
      margin-top: 2px;
      font-size: 11px;
    }
    .counter-sale-slip-heading {
      margin: 4px 0;
      font-size: 14px;
      font-weight: 800;
    }
    .counter-sale-slip-rule {
      border-top: 1px dashed #000;
      margin: 5px 0;
    }
    .counter-detail-rule {
      margin: 2px 0 4px;
    }
    .counter-sale-slip-line,
    .counter-sale-slip-total {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 0;
      font-size: 12px;
    }
    .counter-sale-slip-line strong,
    .counter-sale-slip-total strong {
      text-align: right;
      white-space: nowrap;
    }
    .counter-sale-slip-total {
      border-top: 1px solid #000;
      margin-top: 3px;
      padding-top: 5px;
      font-size: 14px;
      font-weight: 800;
    }
    .counter-sale-slip-total.all-sale {
      border-top: 0;
      margin-top: 0;
    }
    .counter-sale-slip-footer {
      padding-top: 4px;
      font-size: 11px;
      font-weight: 700;
    }
    @media print {
      @page { size: ${thermalWidthMm}mm ${defaultSlipHeightMm}mm; margin: 0; }
      html, body {
        width: ${thermalWidthMm}mm !important;
        min-width: ${thermalWidthMm}mm !important;
        max-width: ${thermalWidthMm}mm !important;
        height: auto !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }
    }
  </style>
</head>
<body>${slipMarkup}</body>
</html>`;

      const printFrame = document.createElement('iframe');
      printFrame.title = 'Counter sale print frame';
      printFrame.style.position = 'fixed';
      printFrame.style.left = '-10000px';
      printFrame.style.top = '0';
      printFrame.style.width = `${thermalWidthMm}mm`;
      printFrame.style.height = `${defaultSlipHeightMm}mm`;
      printFrame.style.border = '0';
      printFrame.style.visibility = 'hidden';
      document.body.appendChild(printFrame);

      const frameDocument = printFrame.contentDocument || printFrame.contentWindow?.document;
      if (!frameDocument) {
        printFrame.remove();
        return;
      }

      frameDocument.open();
      frameDocument.write(slipPrintHtml);
      frameDocument.close();

      const cleanup = () => window.setTimeout(() => printFrame.remove(), 300);
      const frameWindow = printFrame.contentWindow;
      frameWindow?.addEventListener('afterprint', cleanup, { once: true });
      window.setTimeout(async () => {
        try {
          const slipElement = frameDocument.querySelector('.counter-sale-slip');
          const contentHeightPx = Math.max(
            slipElement?.scrollHeight || 0,
            slipElement?.getBoundingClientRect?.().height || 0,
            frameDocument.body?.scrollHeight || 0
          );
          const contentHeightMm = Math.max(45, Math.ceil((contentHeightPx * 25.4) / 96) + thermalFeedMarginMm);
          const dynamicStyle = frameDocument.createElement('style');
          dynamicStyle.textContent = `@media print { @page { size: ${thermalWidthMm}mm ${contentHeightMm}mm; margin: 0; } }`;
          frameDocument.head.appendChild(dynamicStyle);
          printFrame.style.height = `${contentHeightMm}mm`;

          if (window.badizoDesktop?.printThermalHtml) {
            await window.badizoDesktop.printThermalHtml({
              html: frameDocument.documentElement.outerHTML,
              widthMm: thermalWidthMm,
              heightMm: contentHeightMm,
              feedMarginMm: 0
            });
            cleanup();
            setStatusMessage(`Counter ${counterNo} sale slip printed.`);
            return;
          }

          frameWindow?.focus();
          frameWindow?.print();
          window.setTimeout(() => {
            if (document.body.contains(printFrame)) printFrame.remove();
          }, 120000);
        } catch (err) {
          cleanup();
          setErrorMessage(err.response?.data?.error || err.message || 'Unable to print counter sale slip.');
        }
      }, 250);
      setStatusMessage(`Counter ${counterNo} sale slip ready.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to print counter sale slip.');
    }
  }

  function schedulePrint(mode = printMode, afterPrint, invoiceForPrint = printableInvoice || printableDraft) {
    const printClass = mode === 'A4' ? 'printing-a4' : 'printing-thermal';
    const thermalWidthMm = Number(shopSettings.thermal_receipt_width_mm || 80) || 80;
    const thermalContentWidthMm = thermalWidthMm >= 76 ? 72 : Math.max(48, thermalWidthMm - 8);
    const thermalFeedMarginMm = getThermalFeedMarginMm(shopSettings);
    const canUseElectronThermalPrint = mode === 'Thermal' && typeof window !== 'undefined' && Boolean(window.badizoDesktop?.printThermalHtml);
    let cleanupTimer;
    let printFrame = null;
    let didCleanup = false;
    const cleanup = () => {
      if (didCleanup) return;
      didCleanup = true;
      window.clearTimeout(cleanupTimer);
      if (printFrame) {
        printFrame.remove();
        printFrame = null;
      }
      if (afterPrint) afterPrint();
    };

    const styleMarkup = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
      .map((node) => node.outerHTML)
      .join('\n');
    const hostClass = mode === 'A4' ? 'print-host print-host-a4' : 'print-host print-host-thermal';
    const invoiceMarkup = renderToStaticMarkup(<PrintableInvoice invoice={invoiceForPrint} mode={mode} />);

    printFrame = document.createElement('iframe');
    printFrame.title = 'Bill print frame';
    printFrame.style.position = 'fixed';
    printFrame.style.left = '-10000px';
    printFrame.style.top = '0';
    printFrame.style.width = mode === 'A4' ? '210mm' : `${thermalWidthMm}mm`;
    printFrame.style.height = mode === 'A4' ? '260mm' : '360mm';
    printFrame.style.border = '0';
    printFrame.style.visibility = 'hidden';
    document.body.appendChild(printFrame);

    const frameDocument = printFrame.contentDocument || printFrame.contentWindow?.document;
    if (!frameDocument) {
      cleanup();
      return;
    }

    frameDocument.open();
    frameDocument.write(`<!doctype html>
<html class="${printClass}">
<head>
  <meta charset="utf-8" />
  <title>Print Bill</title>
  <base href="${window.location.origin}/" />
  ${styleMarkup}
  <style>
    html.${printClass}, html.${printClass} body {
      margin: 0 !important;
      padding: 0 !important;
      background: #fff !important;
      display: block !important;
      align-items: flex-start !important;
      justify-content: flex-start !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
    }
    .print-host {
      display: block !important;
      visibility: visible !important;
      background: #fff !important;
    }
    .print-host * {
      visibility: visible !important;
    }
    .print-host-thermal {
      width: ${thermalWidthMm}mm !important;
      min-width: ${thermalWidthMm}mm !important;
      max-width: ${thermalWidthMm}mm !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }
    .print-host-a4 {
      width: 190mm !important;
      min-width: 190mm !important;
      max-width: 190mm !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: hidden !important;
    }
    html.printing-a4,
    html.printing-a4 body,
    body.printing-a4 {
      width: 210mm !important;
      min-width: 210mm !important;
      max-width: 210mm !important;
      height: 250mm !important;
      min-height: 250mm !important;
      max-height: 250mm !important;
      overflow: hidden !important;
    }
    body.printing-a4 .print-host-a4,
    body.printing-a4 .a4-paper.a4-one-page {
      height: 250mm !important;
      min-height: 0 !important;
      max-height: 250mm !important;
      page-break-before: avoid !important;
      page-break-after: avoid !important;
      page-break-inside: avoid !important;
      break-before: avoid !important;
      break-after: avoid !important;
      break-inside: avoid !important;
    }
    body.printing-a4 .a4-paper.a4-one-page {
      overflow: hidden !important;
    }
    html.printing-thermal,
    html.printing-thermal body,
    body.printing-thermal {
      width: ${thermalWidthMm}mm !important;
      min-width: ${thermalWidthMm}mm !important;
      max-width: ${thermalWidthMm}mm !important;
      box-sizing: border-box !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      display: block !important;
      align-items: flex-start !important;
      justify-content: flex-start !important;
      overflow: visible !important;
    }
    body.printing-thermal .print-host-thermal {
      display: block !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      width: ${thermalWidthMm}mm !important;
      min-width: ${thermalWidthMm}mm !important;
      max-width: ${thermalWidthMm}mm !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      page-break-before: avoid !important;
      page-break-after: auto !important;
      page-break-inside: auto !important;
      break-before: avoid !important;
      break-after: auto !important;
      break-inside: auto !important;
    }
    body.printing-thermal .thermal-paper {
      display: block !important;
      width: ${thermalContentWidthMm}mm !important;
      min-width: ${thermalContentWidthMm}mm !important;
      max-width: ${thermalContentWidthMm}mm !important;
      box-sizing: border-box !important;
      margin-left: auto !important;
      margin-right: auto !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: visible !important;
      page-break-before: avoid !important;
      page-break-after: auto !important;
      page-break-inside: auto !important;
      break-before: avoid !important;
      break-after: auto !important;
      break-inside: auto !important;
      padding: 0 1.5mm ${thermalFeedMarginMm}mm !important;
      font-size: 10px !important;
      line-height: 1.05 !important;
    }
    body.printing-thermal .thermal-logo-slot {
      height: 25mm !important;
      margin-bottom: 1mm !important;
    }
    body.printing-thermal .thermal-logo-slot img {
      width: 22mm !important;
      height: 22mm !important;
      max-height: 22mm !important;
      max-width: 22mm !important;
      object-fit: contain !important;
    }
    body.printing-thermal .print-rule {
      margin: 2px 0 !important;
    }
    body.printing-thermal .print-meta-grid,
    body.printing-thermal .thermal-customer-block {
      gap: 2px 5px !important;
      margin: 2px 0 !important;
      padding: 2px 0 !important;
    }
    body.printing-thermal .print-table th,
    body.printing-thermal .print-table td,
    body.printing-thermal .thermal-items th,
    body.printing-thermal .thermal-items td,
    body.printing-thermal .gst-summary-table th,
    body.printing-thermal .gst-summary-table td {
      padding: 1.5px 1px !important;
      font-size: 8.8px !important;
      line-height: 1.02 !important;
    }
    body.printing-thermal .thermal-total-box {
      gap: 1px !important;
      font-size: 10px !important;
    }
    body.printing-thermal .thermal-total-box strong {
      font-size: 13px !important;
    }
    body.printing-thermal .print-terms {
      gap: 2px !important;
      margin-top: 2px !important;
    }
    body.printing-thermal .thermal-bill-qr-wrap {
      gap: 0.5mm !important;
      margin-top: 0.5mm !important;
      page-break-before: avoid !important;
      page-break-after: avoid !important;
      page-break-inside: auto !important;
      break-before: avoid !important;
      break-after: avoid !important;
      break-inside: auto !important;
    }
    body.printing-thermal .thermal-bill-qr {
      width: 18mm !important;
      height: 18mm !important;
    }
    @media print {
      @page {
        size: ${mode === 'A4' ? 'A4 portrait' : `${thermalWidthMm}mm auto`};
        margin: 0;
      }
      @page thermal-receipt {
        size: ${thermalWidthMm}mm auto;
        margin: 0;
      }
      body.${printClass} {
        margin: 0 !important;
        padding: 0 !important;
      }
      html.printing-a4,
      html.printing-a4 body,
      body.printing-a4 {
        width: 210mm !important;
        min-width: 210mm !important;
        max-width: 210mm !important;
        height: 250mm !important;
        min-height: 250mm !important;
        max-height: 250mm !important;
        overflow: hidden !important;
      }
      body.${printClass} .print-host {
        display: block !important;
        position: static !important;
        visibility: visible !important;
      }
      body.printing-thermal .print-host-thermal {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
      }
      body.printing-a4 .print-host-a4,
      body.printing-a4 .a4-paper.a4-one-page {
        height: 250mm !important;
        min-height: 0 !important;
        max-height: 250mm !important;
        overflow: hidden !important;
        page-break-before: avoid !important;
        page-break-after: avoid !important;
        page-break-inside: avoid !important;
        break-before: avoid !important;
        break-after: avoid !important;
        break-inside: avoid !important;
      }
      body.${printClass} .print-host * {
        visibility: visible !important;
      }
    }
  </style>
</head>
<body class="${printClass}">
  <div class="${hostClass}">${invoiceMarkup}</div>
</body>
</html>`);
    frameDocument.close();

    cleanupTimer = window.setTimeout(cleanup, 120000);

    const waitForFrameAssets = async (doc) => {
      try {
        await doc.fonts?.ready;
      } catch (err) {
        // Printing can continue even when browser font readiness is unavailable.
      }
      const images = Array.from(doc.images || []);
      await Promise.all(images.map((image) => {
        if (image.complete) return Promise.resolve();
        return new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }));
    };

    const startPrint = async () => {
      const frameWindow = printFrame?.contentWindow;
      const doc = printFrame?.contentDocument || frameWindow?.document;
      if (!frameWindow || !doc) {
        cleanup();
        return;
      }

      await waitForFrameAssets(doc);

      if (mode === 'Thermal') {
        const printHost = doc.querySelector('.print-host-thermal');
        if (printHost) {
          const receipt = printHost.querySelector('.thermal-paper');
          const contentHeightPx = Math.max(
            receipt?.scrollHeight || 0,
            receipt?.getBoundingClientRect?.().height || 0,
            printHost.scrollHeight || 0
          );
          const contentHeightMm = Math.max(40, Math.ceil((contentHeightPx * 25.4) / 96));
          const dynamicPrintStyle = doc.createElement('style');
          dynamicPrintStyle.textContent = `
            @media print {
              @page { size: ${thermalWidthMm}mm ${contentHeightMm}mm; margin: 0; }
              @page thermal-receipt { size: ${thermalWidthMm}mm ${contentHeightMm}mm; margin: 0; }
              html.printing-thermal,
              html.printing-thermal body,
              html.printing-thermal #root {
                width: ${thermalWidthMm}mm !important;
                min-width: ${thermalWidthMm}mm !important;
                max-width: ${thermalWidthMm}mm !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
                height: auto !important;
                min-height: 0 !important;
                max-height: none !important;
                display: block !important;
                align-items: flex-start !important;
                justify-content: flex-start !important;
                overflow: visible !important;
              }
              html.printing-thermal .print-host-thermal,
              body.printing-thermal .print-host-thermal {
                position: absolute !important;
                top: 0 !important;
                left: 0 !important;
                width: ${thermalWidthMm}mm !important;
                min-width: ${thermalWidthMm}mm !important;
                max-width: ${thermalWidthMm}mm !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
                height: auto !important;
                min-height: 0 !important;
                max-height: none !important;
                overflow: visible !important;
              }
              html.printing-thermal .thermal-paper,
              body.printing-thermal .thermal-paper {
                width: ${thermalContentWidthMm}mm !important;
                min-width: ${thermalContentWidthMm}mm !important;
                max-width: ${thermalContentWidthMm}mm !important;
                margin-left: auto !important;
                margin-right: auto !important;
                box-sizing: border-box !important;
                height: auto !important;
                min-height: 0 !important;
                max-height: none !important;
                overflow: visible !important;
                padding-bottom: ${thermalFeedMarginMm}mm !important;
              }
            }
          `;
          doc.head.appendChild(dynamicPrintStyle);

          if (canUseElectronThermalPrint) {
            try {
              await waitForFrameAssets(doc);
              const receiptMarkup = receipt?.outerHTML || printHost.innerHTML;
              const printHtml = `<!doctype html>
<html class="printing-thermal">
<head>
  <meta charset="utf-8" />
  <base href="${window.location.origin}/" />
  ${styleMarkup}
  <style>
    @page { size: ${thermalWidthMm}mm ${contentHeightMm}mm; margin: 0; }
    html,
    body {
      width: ${thermalWidthMm}mm !important;
      min-width: ${thermalWidthMm}mm !important;
      max-width: ${thermalWidthMm}mm !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: visible !important;
      background: #fff !important;
      display: block !important;
      align-items: flex-start !important;
      justify-content: flex-start !important;
    }
    * {
      visibility: visible !important;
      box-sizing: border-box !important;
    }
    .thermal-paper {
      display: block !important;
      position: static !important;
      width: ${thermalContentWidthMm}mm !important;
      min-width: ${thermalContentWidthMm}mm !important;
      max-width: ${thermalContentWidthMm}mm !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      margin: 0 auto !important;
      padding: 0 1.5mm ${thermalFeedMarginMm}mm !important;
      overflow: visible !important;
      page-break-before: avoid !important;
      page-break-after: auto !important;
      page-break-inside: auto !important;
      break-before: avoid !important;
      break-after: auto !important;
      break-inside: auto !important;
      font-size: 10px !important;
      line-height: 1.05 !important;
    }
    .thermal-logo-slot {
      height: 25mm !important;
      margin-bottom: 1mm !important;
    }
    .thermal-logo-slot img {
      width: 22mm !important;
      height: 22mm !important;
      max-width: 22mm !important;
      max-height: 22mm !important;
      object-fit: contain !important;
    }
    .print-rule {
      margin: 2px 0 !important;
    }
    .print-meta-grid,
    .thermal-customer-block {
      gap: 2px 5px !important;
      margin: 2px 0 !important;
      padding: 2px 0 !important;
    }
    .print-table th,
    .print-table td,
    .thermal-items th,
    .thermal-items td,
    .gst-summary-table th,
    .gst-summary-table td {
      padding: 1.5px 1px !important;
      font-size: 8.8px !important;
      line-height: 1.02 !important;
    }
    .thermal-product-row td {
      padding-top: 2px !important;
      padding-bottom: 1px !important;
    }
    .thermal-hsn-row td {
      padding-top: 0.5px !important;
      padding-bottom: 0.5px !important;
      font-size: 8.5px !important;
    }
    .thermal-detail-row td {
      padding-top: 1px !important;
      padding-bottom: 2px !important;
      border-bottom: 1px solid #111 !important;
    }
    .thermal-product-name {
      display: block !important;
      max-height: none !important;
      overflow: visible !important;
      -webkit-line-clamp: unset !important;
      font-size: 10px !important;
      line-height: 1.1 !important;
    }
    .thermal-total-box {
      gap: 1px !important;
      font-size: 10px !important;
    }
    .thermal-total-box strong {
      font-size: 13px !important;
    }
    .print-terms {
      gap: 2px !important;
      margin-top: 2px !important;
    }
    .thermal-bill-qr-wrap {
      gap: 0.5mm !important;
      margin-top: 0.5mm !important;
      page-break-inside: auto !important;
      break-inside: auto !important;
    }
    .thermal-bill-qr {
      width: 18mm !important;
      height: 18mm !important;
    }
    table,
    thead,
    tbody,
    tr,
    th,
    td {
      page-break-inside: auto !important;
      break-inside: auto !important;
    }
  </style>
</head>
<body class="printing-thermal">${receiptMarkup}</body>
</html>`;
              await window.badizoDesktop.printThermalHtml({
                html: printHtml,
                widthMm: thermalWidthMm,
                heightMm: contentHeightMm,
                feedMarginMm: 0
              });
              cleanup();
              return;
            } catch (err) {
              console.error('Electron thermal print failed; falling back to browser print.', err);
              setErrorMessage(`Direct thermal print failed. Browser print opened instead. ${err.message || err}`);
            }
          }
        }
      }

      frameWindow.addEventListener('afterprint', cleanup, { once: true });
      frameWindow.focus();
      frameWindow.print();
    };

    window.setTimeout(startPrint, 350);
  }

  function focusInput(ref, delay = 0) {
    window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select?.();
    }, delay);
  }

  function handleCustomerFieldEnter(event, nextRef) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    focusInput(nextRef, 0);
  }

  function openDigitalContactModal(mode, submitAfter = false, options = {}) {
    setPaymentMode(mode);
    setDigitalContactError('');
    setDigitalContactDraft({
      name: (isBusinessBillingMode(billingMode) ? companyName : customerName) || '',
      phone: customerPhone || ''
    });
    setDigitalContactModal({ mode, submitAfter, ...options });
    focusInput(digitalContactNameRef, 60);
  }

  function handleDigitalContactFieldEnter(event, nextRef) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (nextRef) {
      focusInput(nextRef, 0);
      return;
    }
    confirmDigitalContactModal();
  }

  function confirmDigitalContactModal() {
    if (!digitalContactModal) return;

    const nextName = digitalContactDraft.name.trim();
    const nextPhone = digitalContactDraft.phone.trim();

    if (digitalContactModal.requireName && !isExchangeCustomerNameReady(nextName)) {
      setDigitalContactError('Exchange bill requires customer name.');
      focusInput(digitalContactNameRef, 0);
      return;
    }

    if (digitalContactModal.requireRealPhone && !isTenDigitPhoneReady(nextPhone)) {
      setDigitalContactError('Exchange bill requires exact 10 digit phone number. NO is not allowed.');
      focusInput(digitalContactPhoneRef, 0);
      return;
    }

    if (!digitalContactModal.requireRealPhone && !isDigitalPaymentContactReady(nextPhone)) {
      setDigitalContactError('Enter exactly 10 digit phone number or type NO.');
      focusInput(digitalContactPhoneRef, 0);
      return;
    }

    if (isBusinessBillingMode(billingMode)) {
      setCompanyName(nextName);
    } else {
      setCustomerName(nextName);
    }
    setCustomerPhone(nextPhone);
    setPaymentMode(digitalContactModal.mode);
    setPaymentConfirmed(true);
    setErrorMessage('');
    setDigitalContactModal(null);

    const overrides = {
      customerName: nextName,
      customerPhone: nextPhone,
      paymentReference,
      paymentConfirmed: true
    };

    if (digitalContactModal.submitAfter) {
      submitCheckout(digitalContactModal.mode, overrides);
      return;
    }

    if (digitalContactModal.mode === 'Mixed') {
      focusInput(mixedUpiRef, 50);
    } else {
      focusInput(paymentReferenceRef, 50);
    }
  }

  function selectPaymentMode(mode) {
    setPaymentMode(mode);
    setErrorMessage('');
    setStatusMessage('');
    setPaymentReference('');
    setPaymentConfirmed(false);

    if (mode === 'Cash') {
      window.setTimeout(() => {
        cashReceivedRef.current?.focus();
        cashReceivedRef.current?.select();
      }, 50);
      return;
    }

    if (mode === 'Mixed') {
      window.setTimeout(() => {
        mixedCashRef.current?.focus();
        mixedCashRef.current?.select();
      }, 50);
      return;
    }

    window.setTimeout(() => {
      if (!isDigitalPaymentContactReady(customerPhone)) {
        openDigitalContactModal(mode, false);
        return;
      }
      paymentReferenceRef.current?.focus();
      paymentReferenceRef.current?.select();
    }, 50);
  }

  function preparePayment(mode, submitAfterContact = false) {
    if (
      submitAfterContact
      && mode !== 'Cash'
      && mode !== 'Mixed'
      && cart.length > 0
      && !isDigitalPaymentContactReady(customerPhone)
    ) {
      openDigitalContactModal(mode, true);
      return;
    }

    selectPaymentMode(mode);
  }

  function prepareExactCashPayment() {
    selectPaymentMode('Cash');
    setCashReceivedFlashToken((current) => current + 1);
    window.setTimeout(() => {
      cashReceivedRef.current?.focus();
      cashReceivedRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function toggleMixedPayment(checked) {
    selectPaymentMode(checked ? 'Mixed' : 'Cash');
  }

  function handlePaymentEnter(event, mode = paymentMode) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitCheckout(mode);
  }

  function openHoldBillDialog() {
    if (cart.length === 0) {
      setErrorMessage('Add at least one item before holding a bill.');
      return;
    }

    const currentCustomerLabel = (isBusinessBillingMode(billingMode) ? companyName : customerName).trim();
    setHoldCustomerName(currentCustomerLabel);
    setHoldBillDialogOpen(true);
    setErrorMessage('');
    window.setTimeout(() => {
      holdCustomerNameRef.current?.focus();
      holdCustomerNameRef.current?.select?.();
    }, 50);
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

    const customerLabel = String(holdCustomerName || '').trim()
      || (isBusinessBillingMode(billingMode) ? companyName : customerName).trim()
      || 'Walk-in Customer';
    const holdToken = buildHoldToken({ invoiceNo, counterNo, customerLabel });

    try {
      const savedState = {
        invoiceNo,
        counterNo,
        cart,
        exchangeMode,
        exchangeItems,
        billingMode,
        customerName,
        customerAddress,
        customerPhone,
        companyName,
        customerGstin,
        paymentMode,
        mixedPayment,
        paymentReference,
        paymentConfirmed,
        printMode,
        cashReceived
      };
      await holdBill(holdToken, savedState, {
        counter_no: counterNo,
        customer_name: (isBusinessBillingMode(billingMode) ? companyName : customerName) || 'Walk-in Customer',
        customer_address: customerAddress,
        customer_phone: customerPhone,
        bill_total: totals.grand.toFixed(2),
        item_count: cart.length
      });
      setStatusMessage(`Bill held as ${holdToken}. Ready for next customer.`);
      setHoldBillDialogOpen(false);
      setHoldCustomerName('');
      resetBill();
      refreshHeldBills(counterNo);
      setIsHeldBillsOpen(true);
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

  async function handleReprint(invoiceNoForReprint, reprintMode = printMode) {
    try {
      const details = await fetchInvoiceDetails(invoiceNoForReprint);
      await recordInvoiceReprint(invoiceNoForReprint, reprintMode);
      const invoiceToPrint = invoiceDetailsToPrintable(details, true);
      setPrintableInvoice(invoiceToPrint);
      schedulePrint(reprintMode, () => refreshHistory(false), invoiceToPrint);
      setStatusMessage(`${invoiceNoForReprint} duplicate bill printing in ${reprintMode} format.`);
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

  async function submitCheckout(forcedMode, overrides = {}) {
    const activePaymentMode = forcedMode || paymentMode;
    const effectiveCustomerName = overrides.customerName ?? (isBusinessBillingMode(billingMode) ? companyName : customerName);
    const effectiveCustomerPhone = overrides.customerPhone ?? customerPhone;
    const effectivePaymentReference = overrides.paymentReference ?? paymentReference;
    const effectivePaymentConfirmed = overrides.paymentConfirmed ?? paymentConfirmed;
    const effectiveCashReceived = overrides.cashReceived ?? cashReceived;
    const effectiveMixedPayment = overrides.mixedPayment ?? mixedPayment;
    const effectiveMixedPaidTotal = toNumber(effectiveMixedPayment.cash) + toNumber(effectiveMixedPayment.upi) + toNumber(effectiveMixedPayment.card);
    const effectiveMixedPaymentModeCount = [effectiveMixedPayment.cash, effectiveMixedPayment.upi, effectiveMixedPayment.card]
      .filter((amount) => toNumber(amount) > 0).length;
    const effectiveMixedHasDigital = toNumber(effectiveMixedPayment.upi) > 0 || toNumber(effectiveMixedPayment.card) > 0;
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

    if (exchangeMode && exchangeItems.length === 0) {
      setErrorMessage('Exchange mode is active. Add at least one exchange product or remove exchange mode.');
      exchangeScannerRef.current?.focus();
      return;
    }

    if (exchangeMode && (!isExchangeCustomerNameReady(effectiveCustomerName) || !isTenDigitPhoneReady(effectiveCustomerPhone))) {
      openDigitalContactModal(activePaymentMode, true, {
        requireName: true,
        requireRealPhone: true,
        title: 'Exchange customer detail required',
        message: 'Exchange bill must have customer name and exact 10 digit phone number. NO is not allowed for exchange bills.'
      });
      return;
    }

    if (isBusinessBillingMode(billingMode) && (!effectiveCustomerName.trim() || !customerGstin.trim())) {
      setErrorMessage('Company name and GSTIN are required for B2B IGST Wholesale bills.');
      return;
    }

    const received = activePaymentMode === 'Cash'
      ? toNumber(effectiveCashReceived)
      : activePaymentMode === 'Mixed'
        ? effectiveMixedPaidTotal
        : totals.grand;
    if (activePaymentMode === 'Cash' && received < totals.grand) {
      setErrorMessage('Cash received must be equal to or greater than the bill total.');
      window.setTimeout(() => cashReceivedRef.current?.focus(), 50);
      return;
    }

    if (activePaymentMode === 'Mixed' && effectiveMixedPaymentModeCount < 2) {
      setErrorMessage('Enter amounts in any two payment modes for Mixed payment.');
      window.setTimeout(() => mixedCashRef.current?.focus(), 50);
      return;
    }

    if (activePaymentMode === 'Mixed' && received < totals.grand) {
      setErrorMessage('Mixed payment total must be equal to or greater than the bill total.');
      window.setTimeout(() => mixedCashRef.current?.focus(), 50);
      return;
    }

    if (activePaymentMode !== 'Cash' && activePaymentMode !== 'Mixed' && !isDigitalPaymentContactReady(effectiveCustomerPhone)) {
      openDigitalContactModal(activePaymentMode, true);
      return;
    }

    if (activePaymentMode === 'Mixed' && effectiveMixedHasDigital && !isDigitalPaymentContactReady(effectiveCustomerPhone)) {
      openDigitalContactModal('Mixed', true);
      return;
    }

    if (activePaymentMode !== 'Cash' && !effectivePaymentConfirmed) {
      setErrorMessage(`Confirm ${activePaymentMode} payment before completing the sale.`);
      return;
    }

    const mode = BILLING_MODES[billingMode];
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    setIsCheckoutSubmitting(true);

    try {
      const checkoutResult = await checkout({
        counter_no: counterNo,
        customer_name: effectiveCustomerName || 'Walk-in Customer',
        customer_phone: effectiveCustomerPhone,
        items: cart.map((item) => ({
          ...item,
          sale_price: getUnitPrice(item, billingMode)
        })),
        sub_total: totals.taxable.toFixed(2),
        gst_total: totals.tax.toFixed(2),
        grand_total: totals.grand.toFixed(2),
        payment_mode: activePaymentMode,
        payment_status: 'PAID',
        payment_reference: activePaymentMode === 'Cash'
          ? null
          : activePaymentMode === 'Mixed'
            ? null
            : effectivePaymentReference,
        payment_splits: activePaymentMode === 'Mixed' ? {
          cash: toNumber(effectiveMixedPayment.cash).toFixed(2),
          upi: toNumber(effectiveMixedPayment.upi).toFixed(2),
          card: toNumber(effectiveMixedPayment.card).toFixed(2),
          upi_reference: effectiveMixedPayment.upi_reference || '',
          card_reference: effectiveMixedPayment.card_reference || ''
        } : undefined,
        cash_received: received.toFixed(2),
        change_returned: Math.max(received - totals.grand, 0).toFixed(2),
        transaction_type: mode.transactionType,
        billing_tier: mode.tier,
        tax_type: mode.taxType,
        customer_company_name: isBusinessBillingMode(billingMode) ? effectiveCustomerName : null,
        customer_gstin: mode.taxType === 'INTERSTATE' ? customerGstin : null,
        total_cgst: totals.cgst.toFixed(2),
        total_sgst: totals.sgst.toFixed(2),
        total_igst: totals.igst.toFixed(2),
        exchange_total: totals.exchangeTotal.toFixed(2),
        exchange_items: exchangeItems.map((item) => ({
          barcode: item.barcode,
          product_name: item.product_name,
          hsn_code: item.hsn_code || '',
          unit_type: item.unit_type || item.unit || '',
          quantity: toNumber(item.quantity, 1),
          sale_price: toNumber(item.unitPrice || item.sale_price || item.mrp),
          gst_percent: toNumber(item.gst_percent)
        })),
        print_mode: printMode
      });

      const freeInvoiceItems = (checkoutResult.free_items || []).map((item) => ({
        ...item,
        product_name: String(item.product_name || '').toUpperCase(),
        quantity: toNumber(item.quantity, 1),
        unitPrice: 0,
        sale_price: 0,
        mrp: 0,
        unit_type: item.unit_type || item.unit || 'Nos',
        gst_percent: 0,
        lineTotal: 0,
        taxableRate: 0,
        taxAmount: 0,
        is_free_bonus: true
      }));

      const completedInvoice = {
        ...printableDraft,
        invoiceNo: checkoutResult.invoice_no || invoiceNo,
        customerName: effectiveCustomerName,
        customerPhone: effectiveCustomerPhone,
        paymentReference: activePaymentMode === 'Cash' || activePaymentMode === 'Mixed' ? '' : effectivePaymentReference,
        paymentMode: activePaymentMode,
        paymentSplits: activePaymentMode === 'Mixed' ? [
          { mode: 'Cash', amount: toNumber(effectiveMixedPayment.cash) },
          { mode: 'UPI', amount: toNumber(effectiveMixedPayment.upi), reference: effectiveMixedPayment.upi_reference || '' },
          { mode: 'Card', amount: toNumber(effectiveMixedPayment.card), reference: effectiveMixedPayment.card_reference || '' }
        ].filter((row) => row.amount > 0) : [],
        cashReceived: received,
        changeReturned: Math.max(received - totals.grand, 0),
        totals: {
          ...printableDraft.totals,
          grand: Math.round(totals.grand),
          roundOff: Math.round(totals.grand) - totals.grand
        },
        items: [...printableDraft.items, ...freeInvoiceItems],
        itemCount: printableDraft.itemCount + freeInvoiceItems.reduce((sum, item) => sum + toNumber(item.quantity), 0),
        exchangeItems: printableDraft.exchangeItems
      };
      setPrintableInvoice(completedInvoice);
      setStatusMessage(`Invoice ${checkoutResult.invoice_no || invoiceNo} saved. Change due: ${formatMoney(Math.max(received - totals.grand, 0))}`);
      setCashReceived('');
      setPaymentMode('Cash');
      setMixedPayment(EMPTY_MIXED_PAYMENT);
      setPaymentReference('');
      setPaymentConfirmed(false);
      resetBill();
      schedulePrint(printMode, () => {
        refreshHistory(false);
      }, completedInvoice);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Checkout failed.');
    } finally {
      checkoutInFlightRef.current = false;
      setIsCheckoutSubmitting(false);
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
          <button className="counter-sale-button" type="button" onClick={printCounterSaleSlip}>
            Counter Sale
          </button>
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
              <button className={exchangeMode ? 'mode-option active sensitive-active' : 'mode-option'} onClick={requestExchangeMode}>
                Exchange
              </button>
              <label className="top-control-field">
                <span>Counter</span>
                {canSelectCounter ? (
                  <select aria-label="Counter" value={counterNo} onChange={(event) => setCounterNo(Number(event.target.value))}>
                    {Array.from({ length: counterCount }, (_, index) => index + 1).map((number) => (
                      <option key={number} value={number}>Counter {number}</option>
                    ))}
                  </select>
                ) : (
                  <span className="locked-counter-chip">Counter {counterNo}</span>
                )}
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
          {exchangeMode && (
            <div className="sensitive-bill-warning exchange-bill-warning">
              Exchange bill active. Exchange amount will be deducted from this bill only. Complete, Hold, or Reset will return to normal Retail.
            </div>
          )}

          <div className="scanner-row billing-scanner-row">
            <span className="status-chip">F9 Focus Scanner</span>
            <div className="search-wrap">
              <input
                ref={scannerRef}
                className="field search-input"
                autoFocus
                value={query}
                onPointerDown={closeBillingActivityPanels}
                onChange={handleSearchChange}
                onKeyDown={handleSearchKeyDown}
                onPaste={handleSearchPaste}
                placeholder="Type at least 3 letters or barcode digits"
              />
              {suggestions.length > 0 && (
                <div className="suggestions">
                  {suggestions.map((product, index) => (
                    <button
                      key={product.barcode}
                      className={`suggestion-row ${index === selectedSuggestion ? 'active' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addProduct(product, parseQuantitySearch(query).quantity)}
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
            <button className="secondary-button price-check-button" type="button" onClick={openPriceCheck}>Price Check</button>
          </div>

          {exchangeMode && (
            <section className="exchange-panel">
              <div className="exchange-entry-row">
                <span className="status-chip">Exchange Product</span>
                <input
                  ref={exchangeScannerRef}
                  className="field search-input"
                  value={exchangeQuery}
                  onChange={handleExchangeSearchChange}
                  onKeyDown={handleExchangeSearchKeyDown}
                  onPaste={handleExchangeSearchPaste}
                  placeholder="Scan/type exchange product barcode or name"
                />
                <strong className="exchange-total-chip">Less {formatMoney(totals.exchangeTotal)}</strong>
              </div>
              {exchangeItems.length > 0 && (
                <table className="history-table exchange-table">
                  <thead><tr><th>Code</th><th>Product</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Del</th></tr></thead>
                  <tbody>
                    {exchangeItems.map((item, index) => {
                      const lineAmount = toNumber(item.unitPrice || item.sale_price || item.mrp) * toNumber(item.quantity, 1);
                      return (
                        <tr key={`${item.barcode}-${index}`}>
                          <td className="mono">{item.barcode}</td>
                          <td>{item.product_name}</td>
                          <td>
                            <input
                              className="field qty-input"
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.quantity}
                              onChange={(event) => updateExchangeQuantity(index, event.target.value)}
                            />
                          </td>
                          <td>{formatMoney(item.unitPrice || item.sale_price || item.mrp)}</td>
                          <td><strong>{formatMoney(lineAmount)}</strong></td>
                          <td><button className="danger-button" onClick={() => removeExchangeLine(index)}>Del</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          )}

          <div className="billing-activity-panel">
            <div className="activity-action-row">
              <button
                className="primary-button hold-current-button"
                type="button"
                onClick={openHoldBillDialog}
                disabled={cart.length === 0}
                title={cart.length === 0 ? 'Add items before holding a bill' : 'Hold this bill and clear POS for the next customer (Ctrl + Alt)'}
              >
                Hold Bill & New Customer
              </button>
              <button
                className="secondary-button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  setIsLastBillOpen(false);
                  setIsHeldBillsOpen(false);
                  refreshHistory(true);
                }}
              >
                Old Bills / Reprint (F8)
              </button>
              {latestInvoice ? (
                <details
                  ref={lastBillDetailsRef}
                  className="activity-details activity-last-bill-details"
                  open={isLastBillOpen}
                  onToggle={(event) => setIsLastBillOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>Last Bill</span>
                    <strong className="mono">{latestInvoice.invoice_no}</strong>
                  </summary>
                  <div className="activity-detail-grid">
                    <span>Amount</span><strong>{formatMoney(latestInvoice.grand_total)}</strong>
                    <span>Cash Given</span><strong>{formatMoney(latestInvoice.cash_received)}</strong>
                    <span>Change</span><strong className="stock-low">{formatMoney(latestInvoice.change_returned)}</strong>
                  </div>
                  <div className="activity-detail-footer">
                    <button className="close-action-button" type="button" onClick={() => setIsLastBillOpen(false)}>Close</button>
                  </div>
                </details>
              ) : (
                <button className="secondary-button" disabled>Last Bill</button>
              )}
              <details
                ref={heldBillsDetailsRef}
                className="activity-details activity-held-details"
                open={isHeldBillsOpen}
                onToggle={(event) => setIsHeldBillsOpen(event.currentTarget.open)}
              >
                <summary>
                  <span>Held Bills (F6)</span>
                  <strong>{heldBills.length}</strong>
                </summary>
                <div className="activity-held-list">
                  {heldBills.length === 0 ? (
                    <span className="muted">No held bills.</span>
                  ) : (
                    heldBills.map((heldBill) => (
                      <div key={heldBill.hold_token} className="activity-held-row">
                        <div>
                          <strong>{heldBill.hold_token}</strong>
                          <span className="held-customer-name">{heldBill.customer_name || 'Walk-in Customer'}</span>
                          <span>{heldBill.item_count} items | {formatMoney(heldBill.bill_total)}</span>
                        </div>
                        <div className="activity-held-actions">
                          <button className="secondary-button" onClick={() => resumeHeldBill(heldBill)}>Resume</button>
                          <button className="danger-button" onClick={() => deleteHeldBillSafely(heldBill)}>Delete</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="activity-detail-footer">
                  <button className="close-action-button" type="button" onClick={() => setIsHeldBillsOpen(false)}>Close</button>
                </div>
              </details>
            </div>
            {errorMessage && <div className="alert-box">{errorMessage}</div>}
            </div>

          <div className={`billing-table-wrap ${cart.length === 0 ? 'empty-cart' : ''}`} ref={billingTableRef}>
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
                      <tr
                        key={`${item.barcode}-${index}`}
                        className={`${item.isUnknown ? 'unknown-row' : ''} ${selectedCartIndex === index ? 'selected-cart-row' : ''}`}
                        onClick={() => setSelectedCartIndex(index)}
                      >
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
        <section className="panel customer-side-panel">
          <div className="panel-header compact-panel-header">
            <h2 className="panel-title">Customer</h2>
            <span className="status-chip">{loyaltyCustomer ? `${loyaltyCustomer.loyalty_points} pts` : 'Walk-in'}</span>
          </div>
          <div className="customer-grid billing-customer-grid">
            <div className="billing-loyalty-inline">
              <span>Loyalty: {loyaltyCustomer ? `${loyaltyCustomer.loyalty_points} pts` : 'None'}</span>
              <button className="secondary-button" onClick={handleCustomerLookup}>Lookup</button>
              <button className="secondary-button" onClick={handleCustomerSave}>Save</button>
            </div>
            <label className="supplier-lookup-field">
              <span className="field-label">{isBusinessBillingMode(billingMode) ? 'Company name' : 'Customer name'}</span>
              <input
                ref={customerNameRef}
                className="field"
                value={isBusinessBillingMode(billingMode) ? companyName : customerName}
                onChange={(event) => (isBusinessBillingMode(billingMode) ? setCompanyName(event.target.value) : setCustomerName(event.target.value))}
                onFocus={() => {
                  if (customerSuggestions.length) setIsCustomerLookupOpen(true);
                }}
                onBlur={() => setTimeout(() => setIsCustomerLookupOpen(false), 180)}
                onKeyDown={(event) => handleCustomerFieldEnter(event, customerPhoneRef)}
                placeholder={isBusinessBillingMode(billingMode) ? 'Company name' : 'Customer name'}
              />
              {isCustomerLookupOpen && (
                <div className="supplier-suggestions">
                  {isCustomerSuggestionLoading && <div className="supplier-suggestion-empty">Searching customers...</div>}
                  {!isCustomerSuggestionLoading && customerSuggestions.slice(0, 3).map((match) => (
                    <button
                      key={`${match.phone}-${match.customer_name}`}
                      type="button"
                      className="supplier-suggestion-row"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCustomerSuggestion(match)}
                    >
                      <strong>{match.customer_name}</strong>
                      <span>Phone: {match.phone || '-'}</span>
                      <span>GST: {match.gstin || '-'}</span>
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label>
              <span className="field-label">Phone No</span>
              <input
                ref={customerPhoneRef}
                className="field"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                onKeyDown={(event) => handleCustomerFieldEnter(event, customerGstinRef)}
                placeholder="10 digit phone or NO"
              />
            </label>
            <label>
              <span className="field-label">GST No</span>
              <input
                ref={customerGstinRef}
                className="field"
                maxLength={15}
                value={customerGstin}
                onChange={(event) => setCustomerGstin(event.target.value.toUpperCase())}
                onKeyDown={(event) => handleCustomerFieldEnter(event, customerAddressRef)}
                placeholder={activeMode.taxType === 'INTERSTATE' ? 'Required for B2B' : 'Optional'}
              />
            </label>
            <label>
              <span className="field-label">Address</span>
              <input
                ref={customerAddressRef}
                className="field"
                value={customerAddress}
                onChange={(event) => setCustomerAddress(event.target.value)}
                onKeyDown={(event) => handleCustomerFieldEnter(event, scannerRef)}
                placeholder="Customer address"
              />
            </label>
          </div>
        </section>

        <section className="panel payment-panel">
          <div className="panel-header">
            <h2 className="panel-title">Payment</h2>
          </div>
          <div className="panel-body">
            <div className="total-box">
              {totals.exchangeTotal > 0 && (
                <>
                  <div className="summary-line"><span>Sale total</span><strong>{formatMoney(totals.saleGrand)}</strong></div>
                  <div className="summary-line exchange-less-line"><span>Exchange less</span><strong>- {formatMoney(totals.exchangeTotal)}</strong></div>
                </>
              )}
              <span className="total-label">Net payable</span>
              <span className="total-value">{formatMoney(totals.grand)}</span>
              <span className="amount-words">{amountInWords(totals.grand)}</span>
              {(paymentMode === 'Cash' || paymentMode === 'Mixed') && (
                <div className="payment-change-line">
                  <span>Change due</span>
                  <strong>{formatMoney(changeDue)}</strong>
                </div>
              )}
            </div>
            <details className="tax-breakup-details">
              <summary>
                <span>Tax details</span>
                <strong>{formatMoney(totals.cgst + totals.sgst + totals.igst)}</strong>
              </summary>
              <div className="tax-breakup-body">
                <div className="summary-line"><span>Taxable</span><strong>{formatMoney(totals.taxable)}</strong></div>
                <div className="summary-line"><span>CGST</span><strong>{formatMoney(totals.cgst)}</strong></div>
                <div className="summary-line"><span>SGST</span><strong>{formatMoney(totals.sgst)}</strong></div>
                <div className="summary-line"><span>IGST</span><strong>{formatMoney(totals.igst)}</strong></div>
                <div className="summary-line"><span>Discount</span><strong>{formatMoney(totals.discount)}</strong></div>
              </div>
            </details>

            <div className="form-stack">
              <label>
                <span className="field-label">Payment method</span>
                <select
                  className="select"
                  value={paymentMode}
                  onChange={(event) => selectPaymentMode(event.target.value)}
                >
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Card">Card</option>
                  <option value="Mixed">Mixed</option>
                </select>
              </label>

              <label className="change-box mix-payment-toggle">
                <input
                  type="checkbox"
                  checked={paymentMode === 'Mixed'}
                  onChange={(event) => toggleMixedPayment(event.target.checked)}
                /> Mix payment
              </label>

              {paymentMode === 'Cash' && (
                <>
                  <label>
                    <span className="field-label">Cash received</span>
                    <input
                      ref={cashReceivedRef}
                      className={`field cash-received-input ${cashReceivedFlashToken ? 'cash-received-flash' : ''}`}
                      type="number"
                      min="0"
                      value={cashReceived}
                      onAnimationEnd={() => setCashReceivedFlashToken(0)}
                      onKeyDown={(event) => handlePaymentEnter(event, 'Cash')}
                      onChange={(event) => {
                        setCashReceived(event.target.value);
                        if (errorMessage.includes('Cash received')) setErrorMessage('');
                      }}
                    />
                  </label>
                  {!isCashReady && <div className="alert-box">Enter customer cash before completing sale.</div>}
                </>
              )}

              {paymentMode === 'Mixed' && (
                <>
                  <div className="mixed-payment-grid">
                    <label>
                      <span className="field-label">Cash</span>
                      <input
                        ref={mixedCashRef}
                        className="field"
                        type="number"
                        min="0"
                        value={mixedPayment.cash}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            mixedUpiRef.current?.focus();
                          }
                        }}
                        onChange={(event) => setMixedPayment((current) => ({ ...current, cash: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span className="field-label">UPI</span>
                      <input
                        ref={mixedUpiRef}
                        className="field"
                        type="number"
                        min="0"
                        value={mixedPayment.upi}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            mixedCardRef.current?.focus();
                          }
                        }}
                        onChange={(event) => setMixedPayment((current) => ({ ...current, upi: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span className="field-label">Card</span>
                      <input
                        ref={mixedCardRef}
                        className="field"
                        type="number"
                        min="0"
                        value={mixedPayment.card}
                        onKeyDown={(event) => handlePaymentEnter(event, 'Mixed')}
                        onChange={(event) => setMixedPayment((current) => ({ ...current, card: event.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="mixed-payment-grid mixed-payment-reference-grid">
                    <label>
                      <span className="field-label">UPI Ref</span>
                      <input
                        className="field"
                        value={mixedPayment.upi_reference}
                        onChange={(event) => setMixedPayment((current) => ({ ...current, upi_reference: event.target.value }))}
                        placeholder="UPI ID / last 4"
                      />
                    </label>
                    <label>
                      <span className="field-label">Card Ref</span>
                      <input
                        className="field"
                        value={mixedPayment.card_reference}
                        onChange={(event) => setMixedPayment((current) => ({ ...current, card_reference: event.target.value }))}
                        placeholder="Approval / slip no"
                      />
                    </label>
                  </div>
                  <div className="summary-line mixed-payment-total">
                    <span>Paid total</span>
                    <strong>{formatMoney(mixedPaidTotal)}</strong>
                  </div>
                  {mixedPaymentModeCount < 2 && <div className="alert-box">Enter amounts in any two payment modes for Mixed payment.</div>}
                  {mixedPaidTotal < totals.grand && <div className="alert-box">Mixed payment total must be equal to or greater than the bill total.</div>}
                  {mixedHasDigital && !isDigitalPaymentContactReady(customerPhone) && <div className="alert-box">UPI/Card split ki phone number 10 digits or NO required.</div>}
                  <label className="change-box">
                    <input
                      type="checkbox"
                      checked={paymentConfirmed}
                      onChange={(event) => setPaymentConfirmed(event.target.checked)}
                    /> Mixed payment received
                  </label>
                  {!paymentConfirmed && <div className="alert-box">Confirm Mixed payment before completing sale.</div>}
                </>
              )}

              {paymentMode !== 'Cash' && paymentMode !== 'Mixed' && (
                <>
                  <label>
                    <span className="field-label">{paymentMode} reference</span>
                    <input
                      ref={paymentReferenceRef}
                      className="field"
                      value={paymentReference}
                      onKeyDown={(event) => handlePaymentEnter(event, paymentMode)}
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

              <button className="primary-button" disabled={!canCompleteSale} onClick={() => submitCheckout(paymentMode)}>
                {isCheckoutSubmitting ? 'Saving...' : 'Complete Sale'}
              </button>
              <div className="quick-actions">
                <button className="secondary-button" onClick={prepareExactCashPayment} disabled={isCheckoutSubmitting}>F12 Cash</button>
                <button className="secondary-button" onClick={() => preparePayment('UPI')}>F11 UPI</button>
                <button className="secondary-button" onClick={() => preparePayment('Card')}>F10 Card</button>
                <button className="secondary-button" onClick={() => preparePayment('Mixed')}>Mixed</button>
                <button
                  className="secondary-button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setIsLastBillOpen(false);
                    setIsHeldBillsOpen(false);
                    refreshHistory(true);
                  }}
                >
                  F8 Old Bills
                </button>
                <button className="secondary-button" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
                  setShowHistory(false);
                  setIsLastBillOpen(false);
                  setIsHeldBillsOpen((current) => !current);
                  refreshHeldBills(counterNo);
                }}>F6 Held Bills</button>
                <button className="secondary-button" onClick={() => printBill(printableInvoice || printableDraft)}>Print</button>
              </div>
            </div>
          </div>
        </section>

      </aside>

      {showPriceCheck && (
        <div className="modal-backdrop">
          <div className="modal price-check-modal">
            <div className="panel-header">
              <h2 className="panel-title">Fast Price Check</h2>
              <button className="close-action-button" type="button" onClick={closePriceCheck}>Close</button>
            </div>
            <div className="panel-body form-stack">
              <div className="price-check-entry">
                <input
                  ref={priceCheckInputRef}
                  className="field search-input"
                  value={priceCheckQuery}
                  onChange={(event) => {
                    setPriceCheckQuery(event.target.value);
                    if (priceCheckError) setPriceCheckError('');
                  }}
                  onKeyDown={handlePriceCheckKeyDown}
                  placeholder="Scan barcode or type product name"
                />
                <button className="primary-button" type="button" onClick={() => runPriceCheck()} disabled={isCheckingPrice}>
                  {isCheckingPrice ? 'Checking...' : 'Check'}
                </button>
              </div>
              {priceCheckError && <div className="alert-box">{priceCheckError}</div>}
              {priceCheckProduct && (
                <div className="price-check-card">
                  <div>
                    <span className="mono muted">{priceCheckProduct.barcode}</span>
                    <h3>{String(priceCheckProduct.product_name || '').toUpperCase()}</h3>
                    <span className="muted">HSN: {priceCheckProduct.hsn_code || '-'} | GST: {toNumber(priceCheckProduct.gst_percent).toFixed(2)}%</span>
                  </div>
                  <div className="price-check-metrics">
                    <div><span>MRP</span><strong>{formatMoney(priceCheckProduct.mrp)}</strong></div>
                    <div><span>Retail Price</span><strong>{formatMoney(priceCheckProduct.sale_price)}</strong></div>
                    <div><span>Wholesale</span><strong>{formatMoney(priceCheckProduct.wholesale_price || priceCheckProduct.sale_price)}</strong></div>
                    <div className={toNumber(priceCheckProduct.stock_qty) <= toNumber(priceCheckProduct.min_stock_alert, 10) ? 'stock-low' : ''}>
                      <span>Stock</span><strong>{toNumber(priceCheckProduct.stock_qty).toFixed(2)} {priceCheckProduct.unit_type || 'Nos'}</strong>
                    </div>
                  </div>
                  <div className="price-check-offer">
                    <span>Offer / Discount</span>
                    <strong>{getProductOfferText(priceCheckProduct)}</strong>
                  </div>
                </div>
              )}
              {!priceCheckProduct && !priceCheckError && (
                <div className="price-check-empty">Product bill lo add avvakunda price, MRP, stock, offer check cheyyachu.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {holdBillDialogOpen && (
        <div className="modal-backdrop">
          <form
            className="modal hold-bill-modal"
            onSubmit={(event) => {
              event.preventDefault();
              holdCurrentBill();
            }}
          >
            <div className="panel-header">
              <h2 className="panel-title">Hold Bill</h2>
              <button
                className="close-action-button"
                type="button"
                onClick={() => {
                  setHoldBillDialogOpen(false);
                  scannerRef.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
            <div className="panel-body form-stack">
              <label>
                <span className="field-label">Customer name</span>
                <input
                  ref={holdCustomerNameRef}
                  className="field"
                  value={holdCustomerName}
                  onChange={(event) => setHoldCustomerName(event.target.value)}
                  placeholder="Customer name or bill identifier"
                />
              </label>
              <div className="summary-line">
                <span>Bill total</span>
                <strong>{formatMoney(totals.grand)}</strong>
              </div>
              <button className="primary-button" type="submit">Hold Bill & New Customer</button>
            </div>
          </form>
        </div>
      )}

      {digitalContactModal && (
        <div className="modal-backdrop">
          <form
            className="modal digital-contact-modal"
            onSubmit={(event) => {
              event.preventDefault();
              confirmDigitalContactModal();
            }}
          >
            <div className="panel-header">
              <h2 className="panel-title">{digitalContactModal.title || `${digitalContactModal.mode} customer detail required`}</h2>
              <button className="close-action-button" type="button" onClick={() => setDigitalContactModal(null)}>Cancel</button>
            </div>
            <div className="panel-body form-stack">
              <div className="alert-box">
                {digitalContactModal.message || `For ${digitalContactModal.mode} payment, enter customer phone number. If customer does not give phone number, type NO.`}
              </div>
              {digitalContactError && <div className="alert-box">{digitalContactError}</div>}
              <label>
                <span className="field-label">Customer name</span>
                <input
                  ref={digitalContactNameRef}
                  className="field"
                  value={digitalContactDraft.name}
                  onChange={(event) => setDigitalContactDraft((current) => ({ ...current, name: event.target.value }))}
                  onKeyDown={(event) => handleDigitalContactFieldEnter(event, digitalContactPhoneRef)}
                  placeholder="Customer name"
                />
              </label>
              <label>
                <span className="field-label">Phone No</span>
                <input
                  ref={digitalContactPhoneRef}
                  className="field"
                  value={digitalContactDraft.phone}
                  onChange={(event) => {
                    setDigitalContactDraft((current) => ({ ...current, phone: event.target.value }));
                    if (digitalContactError) setDigitalContactError('');
                  }}
                  onKeyDown={(event) => handleDigitalContactFieldEnter(event, null)}
                  placeholder="10 digit phone or NO"
                  required
                />
              </label>
              <button className="primary-button" type="submit">Continue Bill Print</button>
            </div>
          </form>
        </div>
      )}

      {showHistory && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowHistory(false);
          }}
        >
          <div className="modal">
            <div className="panel-header">
              <h2 className="panel-title">Recent Invoices</h2>
              <button className="close-action-button" type="button" onClick={() => setShowHistory(false)}>Close</button>
            </div>
            <div className="panel-body">
              <div className="history-search-row">
                <label>
                  <span className="field-label">Bill number / customer</span>
                  <input
                    className="field"
                    value={historySearch}
                    onChange={(event) => setHistorySearch(event.target.value)}
                    placeholder="Search invoice no, customer, payment"
                    autoFocus
                  />
                </label>
                <label>
                  <span className="field-label">Bill date</span>
                  <input
                    className="field"
                    type="date"
                    value={historyDate}
                    onChange={(event) => setHistoryDate(event.target.value)}
                  />
                </label>
                <button className="secondary-button" onClick={() => {
                  setHistorySearch('');
                  setHistoryDate('');
                }}>Clear</button>
                <span className="status-chip">{filteredInvoiceHistory.length} bills</span>
              </div>
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
                  {filteredInvoiceHistory.length === 0 ? (
                    <tr><td colSpan="7">No invoices found.</td></tr>
                  ) : (
                    filteredInvoiceHistory.map((invoice) => (
                      <tr key={invoice.invoice_no}>
                        <td className="mono">{invoice.invoice_no}</td>
                        <td>{invoice.customer_name || 'Walk-in Customer'}</td>
                        <td><strong>{formatMoney(invoice.grand_total)}</strong></td>
                        <td>{invoice.payment_mode}</td>
                        <td>{invoice.invoice_status || 'PAID'}</td>
                        <td>{invoice.created_at ? new Date(invoice.created_at).toLocaleString() : '-'}</td>
                        <td>
                          <div className="table-actions">
                            <button className="secondary-button" onClick={() => handleReprint(invoice.invoice_no, 'Thermal')}>Reprint</button>
                            <button className="secondary-button" onClick={() => handleReprint(invoice.invoice_no, 'A4')}>A4 Reprint</button>
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
              <button className="close-action-button" type="button" onClick={() => setReturnInvoice(null)}>Close</button>
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
              <button className="close-action-button" type="button" onClick={closeApprovalDialog}>Cancel</button>
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
                {isApprovingMode
                  ? 'Verifying...'
                  : `Approve ${approvalDialog.action === 'PRINT_MODE'
                    ? approvalDialog.targetPrintMode
                      : BILLING_MODES[approvalDialog.targetMode].label}`}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className={`print-area ${printMode === 'Thermal' ? 'print-thermal' : 'print-a4'}`} aria-hidden="true">
        <PrintableInvoice invoice={printableInvoice || printableDraft} mode={printMode} />
      </div>
    </div>
  );
}
