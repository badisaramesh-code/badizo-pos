import React, { useEffect, useMemo, useRef, useState } from 'react';
import { approveSensitiveBillingMode, fetchBarcodeTemplate, fetchSettings, generateBarcodePrn, printBarcodePrn, searchProducts } from '../api/client';

const TEMPLATE_OPTIONS = [
  {
    name: 'tsc-244-pro-50x50-two-up.prn',
    label: '50 x 50 mm Two-Up',
    printer: 'TSC-244-Pro',
    help: 'One printer row prints two 50x50mm stickers side-by-side.'
  },
  {
    name: 'tsc-244-1-33x25-single.prn',
    label: '33 x 25 mm Two-Up',
    printer: 'TSC TE244',
    help: 'One printer row prints two 33x25mm stickers side-by-side.'
  },
  {
    name: 'tsc-244-2-jewellery-100x15-tail.prn',
    label: '100 x 15 mm Jewellery Tail',
    printer: 'TSC 244-2',
    help: '65mm printable tail split into price side and shop/address side.'
  }
];

const BARCODE_STORE_SETTINGS_KEY = 'badizo_barcode_store_settings';
const BARCODE_LABEL_FORMAT_KEY = 'badizo_barcode_label_format';
const DEFAULT_STORE_SETTINGS = {
  company: 'hyper fresh mart llp',
  address_line_1: 'H.NO: 3-41, Behind GV Mall, Morisetti Vari street',
  address_line_2: 'Sathupally, Khammam(dt), Telangana-507303',
  customer_care: 'Customer care: 08760 295000 - hyperfreshmart@gmail.com',
  phone: '08760 295000'
};

function loadBarcodeStoreSettings() {
  try {
    const raw = window.localStorage.getItem(BARCODE_STORE_SETTINGS_KEY);
    if (!raw) return DEFAULT_STORE_SETTINGS;
    return { ...DEFAULT_STORE_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    return DEFAULT_STORE_SETTINGS;
  }
}

function todayStickerDate() {
  return new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).replace(/ /g, '-').toUpperCase();
}

function moneyTwoDecimals(value) {
  const amount = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount)) return String(value ?? '');
  return amount.toFixed(2);
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function loadBarcodeLabelFormat() {
  try {
    const saved = window.localStorage.getItem(BARCODE_LABEL_FORMAT_KEY);
    return TEMPLATE_OPTIONS.some((option) => option.name === saved) ? saved : TEMPLATE_OPTIONS[0].name;
  } catch (err) {
    return TEMPLATE_OPTIONS[0].name;
  }
}

function displayNumber(value, decimals = 2) {
  const amount = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(amount)) return '0.00';
  return amount.toFixed(decimals);
}

export default function BarcodeStickersView() {
  const savedStoreSettings = loadBarcodeStoreSettings();
  const [screenMode, setScreenMode] = useState('print');
  const [templateName, setTemplateName] = useState(loadBarcodeLabelFormat);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [setupPassword, setSetupPassword] = useState({ username: '', password: '' });
  const [form, setForm] = useState({
    product_name: '',
    barcode: '',
    mrp: '0.00',
    sale_price: '0.00',
    pkd_date: todayStickerDate(),
    qty: '1',
    unit: 'Nos',
    company: savedStoreSettings.company,
    address_line_1: savedStoreSettings.address_line_1,
    address_line_2: savedStoreSettings.address_line_2,
    customer_care: savedStoreSettings.customer_care,
    phone: savedStoreSettings.phone,
    stickerCount: '2'
  });
  const [templateInfo, setTemplateInfo] = useState(null);
  const [prn, setPrn] = useState('');
  const [outputInfo, setOutputInfo] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [barcodePrinterTemplates, setBarcodePrinterTemplates] = useState({});
  const selectedTemplate = TEMPLATE_OPTIONS.find((option) => option.name === templateName) || TEMPLATE_OPTIONS[0];
  const selectedPrinterConfig = barcodePrinterTemplates[templateName] || {};
  const selectedPrinterName = selectedPrinterConfig.printer || selectedTemplate.printer;
  const searchRef = useRef(null);
  const stickerCountRef = useRef(null);
  const selectedProductRef = useRef(null);
  const systemName = window.location.hostname || '127.0.0.1';
  const labelColumnCount = templateName === 'tsc-244-2-jewellery-100x15-tail.prn' ? 1 : 2;

  useEffect(() => {
    loadBarcodePrinterSettings();
  }, []);

  useEffect(() => {
    const query = searchQuery.trim();
    if (screenMode !== 'print') return undefined;
    if (query.length < 3) {
      setSuggestions([]);
      setSelectedSearchIndex(0);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      runLiveSearch(query);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [searchQuery, screenMode]);

  useEffect(() => {
    selectedProductRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedSearchIndex]);

  useEffect(() => {
    function handleWindowKeyDown(event) {
      if (screenMode !== 'print') return;
      if (event.key === 'F11') {
        event.preventDefault();
        loadHighlightedProduct();
      }
    }

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [screenMode, suggestions, selectedSearchIndex]);

  useEffect(() => {
    setPrn('');
    setOutputInfo(null);
    if (screenMode === 'setup' && setupUnlocked) {
      loadTemplate();
    } else {
      setTemplateInfo(null);
    }
  }, [templateName, screenMode, setupUnlocked]);

  async function loadBarcodePrinterSettings() {
    try {
      const settings = await fetchSettings();
      setBarcodePrinterTemplates(settings.barcode_printer_templates || {});
    } catch (err) {
      setBarcodePrinterTemplates({});
    }
  }

  async function loadTemplate() {
    try {
      const result = await fetchBarcodeTemplate(templateName);
      setTemplateInfo(result);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load PRN template.');
    }
  }

  async function unlockTemplateSetup(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    try {
      await approveSensitiveBillingMode({
        username: setupPassword.username,
        password: setupPassword.password,
        reason: 'Barcode PRN template setup'
      });
      setSetupUnlocked(true);
      setSetupPassword({ username: '', password: '' });
      setStatusMessage('PRN Template Setup unlocked.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Admin password required for PRN Template Setup.');
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function changeTemplateName(nextTemplateName) {
    setTemplateName(nextTemplateName);
    try {
      window.localStorage.setItem(BARCODE_LABEL_FORMAT_KEY, nextTemplateName);
    } catch (_err) {
      // Ignore storage failures; selection still works for the current screen.
    }
  }

  async function runLiveSearch(query) {
    setIsSearching(true);
    try {
      const products = await searchProducts(query);
      setSuggestions(products.slice(0, 80));
      setSelectedSearchIndex(0);
    } catch (_err) {
      setSuggestions([]);
    } finally {
      setIsSearching(false);
    }
  }

  function saveStoreSettings() {
    const settings = {
      company: form.company,
      address_line_1: form.address_line_1,
      address_line_2: form.address_line_2,
      customer_care: form.customer_care,
      phone: form.phone
    };
    window.localStorage.setItem(BARCODE_STORE_SETTINGS_KEY, JSON.stringify(settings));
    setStatusMessage('PRN store details saved. Refresh tarvata kuda same details vastayi.');
    setErrorMessage('');
  }

  function applyProduct(product) {
    setForm((current) => ({
      ...current,
      product_name: String(product.product_name || '').toUpperCase(),
      barcode: product.barcode || current.barcode,
      mrp: moneyTwoDecimals(product.mrp ?? 0),
      sale_price: moneyTwoDecimals(product.sale_price ?? product.mrp ?? 0),
      hsn_code: product.hsn_code || '',
      gst_percent: displayNumber(product.gst_percent || 0),
      sales_sgst_percent: displayNumber(product.sales_sgst_percent || 0),
      sales_cgst_percent: displayNumber(product.sales_cgst_percent || 0),
      sales_igst_percent: displayNumber(product.sales_igst_percent || 0),
      discount_value: displayNumber(product.discount_value || 0),
      discount_type: product.discount_type || 'PERCENT',
      pkd_date: todayStickerDate(),
      qty: '1',
      unit: product.unit_type || 'Nos'
    }));
    setSearchQuery(product.barcode || product.product_name || '');
    setSuggestions([]);
    setSelectedSearchIndex(0);
    setPrn('');
    setOutputInfo(null);
    setStatusMessage(`${product.product_name} loaded for sticker.`);
    setErrorMessage('');
    window.setTimeout(() => stickerCountRef.current?.focus(), 30);
  }

  async function searchAndLoadProduct(query = searchQuery) {
    const cleaned = String(query || '').trim();
    if (!cleaned) {
      setErrorMessage('Scan barcode or type product name first.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('');

    try {
      const products = await searchProducts(cleaned);
      if (!products.length) {
        setErrorMessage('Product not found for this barcode/product name.');
        return;
      }
      if (products.length === 1) {
        applyProduct(products[0]);
        return;
      }
      const exact = products.find((product) => (
        String(product.barcode || '').toUpperCase() === cleaned.toUpperCase()
        || String(product.product_code || '').toUpperCase() === cleaned.toUpperCase()
      ));
      if (exact) {
        applyProduct(exact);
        return;
      }
      setSuggestions(products.slice(0, 8));
      setSelectedSearchIndex(0);
      setStatusMessage(`${products.length} products found. Select one product.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load product from barcode/product name.');
    }
  }

  function moveSelectedProduct(direction) {
    if (!suggestions.length) return;
    setSelectedSearchIndex((current) => {
      const next = current + direction;
      if (next < 0) return suggestions.length - 1;
      if (next >= suggestions.length) return 0;
      return next;
    });
  }

  function loadHighlightedProduct() {
    const product = suggestions[selectedSearchIndex];
    if (product) applyProduct(product);
  }

  function handleSearchKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelectedProduct(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelectedProduct(-1);
      return;
    }
    if (event.key === 'F11') {
      event.preventDefault();
      loadHighlightedProduct();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (suggestions.length) {
        loadHighlightedProduct();
      } else {
        searchAndLoadProduct();
      }
    }
  }

  function handleStickerCountKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      generatePrn({ sendToPrinter: true });
    }
  }

  async function generatePrn({ sendToPrinter = false } = {}) {
    setErrorMessage('');
    setStatusMessage('');
    if (!form.barcode || !form.product_name) {
      setErrorMessage('Scan/search a product before printing sticker.');
      return;
    }
    setIsPrinting(sendToPrinter);
    try {
      const result = await generateBarcodePrn({
        ...form,
        mrp: moneyTwoDecimals(form.mrp),
        sale_price: moneyTwoDecimals(form.sale_price),
        template_name: templateName
      });
      setPrn(result.prn || '');
      setOutputInfo(result);
      if (!sendToPrinter) {
      setStatusMessage(`Sticker print file ready and report saved: ${result.output_name}. Printer: ${result.printer_name || selectedPrinterName}`);
        return;
      }

      try {
        const localSharePath = (selectedPrinterConfig.shares || []).find((share) => /^\\\\localhost\\/i.test(String(share || '')));
        const isAdmin1Local33x25 = result.template_name === 'tsc-244-1-33x25-single.prn'
          || /TSC\s*TE244/i.test(String(selectedPrinterName || result.printer_name || ''));
        const localShareName = isAdmin1Local33x25
          ? 'TSC-244-2'
          : localSharePath ? String(localSharePath).replace(/^\\\\localhost\\/i, '') : '';
        const printResult = window.badizoDesktop?.printBarcodePrn && localShareName
          ? await window.badizoDesktop.printBarcodePrn({ prn: result.prn, shareName: localShareName })
          : await printBarcodePrn({
            output_name: result.output_name,
            template_name: result.template_name,
            printer_name: selectedPrinterName
          });
        setOutputInfo({ ...result, ...printResult });
        setStatusMessage(`Sticker sent to ${printResult.printer_name || selectedPrinterName}. File: ${result.output_name}`);
      } catch (printErr) {
        setErrorMessage(printErr.response?.data?.error || 'Sticker file was created, but Windows could not send it to the printer.');
        setStatusMessage(`Sticker file is ready: ${result.output_path}. Check printer sharing, then print this PRN file.`);
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to generate PRN.');
    } finally {
      setIsPrinting(false);
    }
  }

  function copyPrn() {
    if (!prn) return;
    window.navigator.clipboard?.writeText(prn);
    setStatusMessage('PRN copied.');
  }

  function openStickerPrint() {
    setScreenMode('print');
    setSetupUnlocked(false);
    setSetupPassword({ username: '', password: '' });
    setTemplateInfo(null);
    setPrn('');
    setOutputInfo(null);
    setErrorMessage('');
    setStatusMessage('');
  }

  function openTemplateSetup() {
    setScreenMode('setup');
    setSetupUnlocked(false);
    setSetupPassword({ username: '', password: '' });
    setTemplateInfo(null);
    setPrn('');
    setOutputInfo(null);
    setErrorMessage('');
    setStatusMessage('');
  }

  const stickerRows = useMemo(() => {
    const fields = [
      ['product_name', 'Product Name'],
      ['barcode', 'Barcode 128'],
      ['mrp', 'MRP'],
      ['sale_price', 'Price'],
      ['pkd_date', 'Packed Date'],
      ['qty', 'Qty'],
      ['unit', 'Unit']
    ];
    return fields;
  }, []);

  return (
    <div className="form-stack">
      {screenMode === 'print' ? (
      <section className="panel barcode-workstation-panel">
        <div className="panel-body form-stack barcode-workstation">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          {outputInfo?.output_path && (
            <div className="file-path-box">{outputInfo.output_path}</div>
          )}

          <div className="barcode-entry-layout">
            <div className="barcode-left-workspace">
              <div className="panel-header green barcode-compact-header">
                <div>
                  <h2 className="panel-title">Barcode Sticker Print</h2>
                  <span className="panel-subtitle">Search product, F11 load, enter sticker count, print</span>
                </div>
                <div className="barcode-header-actions">
                  <div className="barcode-mode-row barcode-mode-row-inline">
                    <button
                      className={`segment-button ${screenMode === 'print' ? 'active' : ''}`}
                      type="button"
                      onClick={openStickerPrint}
                    >
                      Sticker Print
                    </button>
                    <button
                      className={`segment-button ${screenMode === 'setup' ? 'active' : ''}`}
                      type="button"
                      onClick={openTemplateSetup}
                    >
                      PRN Template Setup
                    </button>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => searchRef.current?.focus()}>Focus Search</button>
                </div>
              </div>

              <div className="barcode-entry-form">
              <label><span className="field-label">Barcode</span><input className="field" value={form.barcode} onChange={(event) => update('barcode', event.target.value.toUpperCase())} /></label>
              <label className="wide-field"><span className="field-label">Product</span><input className="field" value={form.product_name} onChange={(event) => update('product_name', event.target.value.toUpperCase())} /></label>
              <label><span className="field-label">Packing Date</span><input className="field" value={form.pkd_date} onChange={(event) => update('pkd_date', event.target.value.toUpperCase())} /></label>
              <label><span className="field-label">Unit</span><input className="field" value={form.unit} onChange={(event) => update('unit', event.target.value)} /></label>
              <label><span className="field-label">MRP</span><input className="field" value={form.mrp} readOnly /></label>
              <label><span className="field-label">Base Rate</span><input className="field" value={form.sale_price} readOnly /></label>
              <label><span className="field-label">Net Rate</span><input className="field" value={form.sale_price} readOnly /></label>
              <label><span className="field-label">HSN Code</span><input className="field" value={form.hsn_code || ''} readOnly /></label>
              <label><span className="field-label">New Sales Rate</span><input className="field" value={form.sale_price} readOnly /></label>
              <label><span className="field-label">New Discount</span><input className="field" value={form.discount_value || '0.00'} readOnly /></label>
              <label><span className="field-label">New Discount Type</span><input className="field" value={form.discount_type || 'PERCENT'} readOnly /></label>
              <label><span className="field-label">New GST</span><input className="field" value={form.gst_percent || '0'} readOnly /></label>
              <label className="sticker-count-field"><span className="field-label">Quantity / Stickers</span><input ref={stickerCountRef} className="field" type="number" min="1" step="1" value={form.stickerCount} onChange={(event) => update('stickerCount', event.target.value)} onKeyDown={handleStickerCountKeyDown} /></label>
              <button className="primary-button" type="button" onClick={() => generatePrn({ sendToPrinter: true })} disabled={isPrinting}>
                {isPrinting ? 'Sending...' : 'Print Barcode Labels'}
              </button>
              <div className="barcode-search-strip barcode-search-under-print">
                <input
                  ref={searchRef}
                  className="field barcode-live-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Type 3+ letters/code or scan barcode"
                />
                <button className="secondary-button" type="button" onClick={() => searchAndLoadProduct()}>Find</button>
                <button className="secondary-button" type="button" onClick={() => {
                  setSearchQuery('');
                  setSuggestions([]);
                  setSelectedSearchIndex(0);
                  searchRef.current?.focus();
                }}>Clear</button>
                <span className="barcode-search-status">{isSearching ? 'Searching...' : `${suggestions.length} products`}</span>
              </div>
              </div>
            </div>

            <div className="barcode-printer-card">
              <label><span className="field-label">Printer Name</span><input className="field" value={selectedPrinterName} readOnly /></label>
              <label><span className="field-label">System Name</span><input className="field" value={systemName} readOnly /></label>
              <label>
                <span className="field-label">Label Format</span>
                <select className="select" value={templateName} onChange={(event) => changeTemplateName(event.target.value)}>
                  {TEMPLATE_OPTIONS.map((option) => (
                    <option key={option.name} value={option.name}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label><span className="field-label">Sticker Size</span><input className="field" value={selectedTemplate.label} readOnly /></label>
              <label><span className="field-label">Column Count</span><input className="field" value={labelColumnCount} readOnly /></label>
              <div className="barcode-printer-actions">
                <button className="secondary-button" type="button" onClick={() => generatePrn()} disabled={isPrinting}>Create File</button>
                <button className="secondary-button" type="button" onClick={() => prn && downloadTextFile(prn, outputInfo?.output_name || 'barcode-sticker.prn')} disabled={!prn}>Download</button>
              </div>
            </div>
          </div>

          <div className="barcode-product-grid-wrap">
            <table className="history-table barcode-product-grid-table">
              <thead>
                <tr>
                  <th>Product Code</th>
                  <th>Barcode</th>
                  <th>Description</th>
                  <th>Product Name</th>
                  <th>Unit</th>
                  <th>HSN Code</th>
                  <th>MRP</th>
                  <th>Rate</th>
                  <th>Discount</th>
                  <th>Disc Type</th>
                  <th>Net Rate</th>
                  <th>Sales GST</th>
                  <th>Sales SGST</th>
                  <th>Sales CGST</th>
                  <th>Sales IGST</th>
                  <th>Stock</th>
                  <th>Purchase Rate</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((product, index) => {
                  const active = index === selectedSearchIndex;
                  return (
                    <tr
                      key={product.barcode}
                      ref={active ? selectedProductRef : null}
                      className={active ? 'selected-row' : ''}
                      onClick={() => setSelectedSearchIndex(index)}
                      onMouseEnter={() => setSelectedSearchIndex(index)}
                      onDoubleClick={() => applyProduct(product)}
                    >
                      <td>{product.product_code || ''}</td>
                      <td className="mono">{product.barcode}</td>
                      <td>{product.alias_names || product.product_group || ''}</td>
                      <td><strong>{product.product_name}</strong></td>
                      <td>{product.unit_type || 'Nos'}</td>
                      <td>{product.hsn_code || ''}</td>
                      <td>{displayNumber(product.mrp)}</td>
                      <td>{displayNumber(product.sale_price)}</td>
                      <td>{displayNumber(product.discount_value)}</td>
                      <td>{product.discount_type || 'PERCENT'}</td>
                      <td>{displayNumber(product.sale_price)}</td>
                      <td>{displayNumber(product.gst_percent)}</td>
                      <td>{displayNumber(product.sales_sgst_percent)}</td>
                      <td>{displayNumber(product.sales_cgst_percent)}</td>
                      <td>{displayNumber(product.sales_igst_percent)}</td>
                      <td>{displayNumber(product.stock_qty, 3)}</td>
                      <td>{displayNumber(product.purchase_price)}</td>
                    </tr>
                  );
                })}
                {!suggestions.length && (
                  <tr>
                    <td colSpan="17">Search 3 letters/code to view products. Use arrow keys, mouse, or F11 to load selected product.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="barcode-bottom-preview">
            <StickerPreview form={form} templateName={templateName} />
            <div className="change-box">
              Output printer: <strong>{selectedPrinterName}</strong>. Print history is saved in Reports - Barcode Stickers.
            </div>
          </div>
        </div>
      </section>
      ) : (
      <div className="barcode-grid">
        <section className="panel">
          <div className="panel-header green">
            <h2 className="panel-title">PRN Template Setup</h2>
            <div className="barcode-mode-row barcode-mode-row-inline">
              <button
                className={`segment-button ${screenMode === 'print' ? 'active' : ''}`}
                type="button"
                onClick={openStickerPrint}
              >
                Sticker Print
              </button>
              <button
                className={`segment-button ${screenMode === 'setup' ? 'active' : ''}`}
                type="button"
                onClick={openTemplateSetup}
              >
                PRN Template Setup
              </button>
            </div>
          </div>
          <div className="panel-body form-stack">
            {errorMessage && <div className="alert-box">{errorMessage}</div>}
            {statusMessage && <div className="change-box">{statusMessage}</div>}

            {!setupUnlocked ? (
              <form className="form-stack" onSubmit={unlockTemplateSetup}>
                <div className="alert-box">
                  PRN template setup is for admin/server use only. Unlock this screen, create/check the size template, keep the PRN template in the system folder, then close this screen.
                </div>
                <label>
                  <span className="field-label">Admin Username</span>
                  <input className="field" value={setupPassword.username} onChange={(event) => setSetupPassword((current) => ({ ...current, username: event.target.value }))} autoComplete="username" />
                </label>
                <label>
                  <span className="field-label">Password</span>
                  <input className="field" type="password" value={setupPassword.password} onChange={(event) => setSetupPassword((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" />
                </label>
                <button className="primary-button" type="submit">Unlock PRN Setup</button>
              </form>
            ) : (
              <>
                <label>
                  <span className="field-label">Sticker Size / Template</span>
                  <select className="select" value={templateName} onChange={(event) => changeTemplateName(event.target.value)}>
                    {TEMPLATE_OPTIONS.map((option) => (
                      <option key={option.name} value={option.name}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="change-box">
                  Printer Name: <strong>{selectedPrinterName}</strong> | {selectedTemplate.help}
                </div>
                <div className="change-box">
                  Edit these sample values only for PRN template testing. Store sticker print screen will still auto-fill product data.
                </div>
                <div className="two-column-form">
                  {stickerRows.map(([field, label]) => (
                    <label key={field}>
                      <span className="field-label">{label}</span>
                      <input
                        className="field"
                        value={form[field]}
                        onChange={(event) => update(field, field === 'product_name' ? event.target.value.toUpperCase() : event.target.value)}
                      />
                    </label>
                  ))}
                  <label>
                    <span className="field-label">How many test stickers?</span>
                    <input
                      className="field"
                      type="number"
                      min="1"
                      step="1"
                      value={form.stickerCount}
                      onChange={(event) => update('stickerCount', event.target.value)}
                    />
                  </label>
                </div>
                <div className="two-column-form">
                  <label>
                    <span className="field-label">Store Name</span>
                    <input className="field" value={form.company} onChange={(event) => update('company', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Phone Number</span>
                    <input className="field" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Address Line 1</span>
                    <input className="field" value={form.address_line_1} onChange={(event) => update('address_line_1', event.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Address Line 2</span>
                    <input className="field" value={form.address_line_2} onChange={(event) => update('address_line_2', event.target.value)} />
                  </label>
                  <label className="wide-field">
                    <span className="field-label">Customer Care Line</span>
                    <input className="field" value={form.customer_care} onChange={(event) => update('customer_care', event.target.value)} />
                  </label>
                </div>
                <button className="primary-button" type="button" onClick={saveStoreSettings}>Save Store Details</button>
                {templateInfo && (
                  <div className="change-box barcode-template-path-box">
                    <span>Template file:</span>
                    <strong>{templateInfo.template_path}</strong>
                  </div>
                )}
                <button className="secondary-button" type="button" onClick={loadTemplate}>Reload Template</button>
                <button className="secondary-button" type="button" onClick={() => generatePrn()}>Create Test PRN From Current Product</button>
                <button className="secondary-button" type="button" onClick={copyPrn} disabled={!prn}>Copy Test PRN</button>
                <button className="secondary-button" type="button" onClick={() => {
                  setSetupUnlocked(false);
                  setTemplateInfo(null);
                  setPrn('');
                }}>Close PRN Setup</button>
              </>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">{selectedTemplate.label} Template Preview</h2></div>
          <div className="panel-body barcode-preview-wrap">
            <StickerPreview form={form} templateName={templateName} />
            <pre className="prn-output">
              {setupUnlocked
                ? (prn || templateInfo?.template || `Template file will load from barcode/templates/${templateName}`)
                : 'Unlock PRN Template Setup to view template details.'}
            </pre>
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

function StickerPreview({ form, templateName }) {
  if (templateName === 'tsc-244-1-33x25-single.prn') {
    return (
      <div className="sticker-preview sticker-preview-33x25">
        <strong className="sticker-product">{form.product_name}</strong>
        <div className="barcode-bars small"></div>
        <div className="mono sticker-code">{form.barcode}</div>
        <div className="sticker-price-row"><strong>MRP {form.mrp}</strong><strong>Price {form.sale_price}</strong></div>
        <div className="tax-note">Inclusive of all taxes</div>
        <div className="sticker-meta-row">Qty: {form.qty} {form.unit}</div>
        <div className="sticker-divider"></div>
        <strong className="sticker-store">{form.company}</strong>
        <small>{form.address_line_1}<br />Ph: {form.phone}</small>
      </div>
    );
  }

  if (templateName === 'tsc-244-2-jewellery-100x15-tail.prn') {
    const shortName = String(form.product_name || '').toUpperCase().slice(0, 25);
    return (
      <div className="sticker-preview sticker-preview-jewellery">
        <div className="jewellery-side">
          <strong className="jewellery-product-name">{shortName}</strong>
          <strong>MRP {form.mrp}</strong>
          <strong>Price {form.sale_price}</strong>
          <div className="barcode-bars jewellery-bars"></div>
          <span className="mono">{form.barcode}</span>
        </div>
        <div className="jewellery-side shop-side">
          <strong>{form.company}</strong>
          <span>{form.address_line_1}</span>
          <span>{form.address_line_2}</span>
          <span>Ph: {form.phone}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="sticker-preview sticker-preview-wide">
      <strong className="sticker-product">{form.product_name}</strong>
      <div className="barcode-bars"></div>
      <div className="mono sticker-code">{form.barcode}</div>
      <div className="sticker-price-row"><strong>MRP Rs: {form.mrp}</strong><strong>Price Rs: {form.sale_price}</strong></div>
      <div>[ Inclusive of all taxes ]</div>
      <div className="sticker-price-row sticker-meta-row"><span>Pkd. Date: {form.pkd_date}</span><span>Qty: {form.qty} {form.unit}</span></div>
      <div className="sticker-divider"></div>
      <strong className="sticker-store">{form.company}</strong>
      <small>{form.address_line_1}<br />{form.address_line_2}<br />{form.customer_care}</small>
    </div>
  );
}
