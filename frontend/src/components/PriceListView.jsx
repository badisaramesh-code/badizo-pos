import React, { useEffect, useMemo, useState } from 'react';
import { fetchPriceListGroups, fetchPriceListProducts, fetchPriceListUpdateJob, fetchSettings, startPriceListUpdateJob } from '../api/client';

const DEFAULT_GST_OPTIONS = ['0', '3', '5', '12', '18', '28', '40'];
const DEFAULT_GROUPS = ['ALL PRODUCTS', 'FMG', 'PLASTIC', 'FOOD', 'GENERAL'];
const UNIT_OPTIONS = ['Nos', 'Gm', 'Kg', 'Ml', 'Ltr', 'Pack'];
const DISCOUNT_TYPE_OPTIONS = ['PERCENT', 'VALUE'];
const PRICE_LIST_PAGE_SIZE = 500;

const PROPERTY_OPTIONS = [
  { key: 'gst_percent', label: 'GST Slab', type: 'gst', newField: 'new_gst_slab', oldField: 'gst_slab' },
  { key: 'hsn_code', label: 'HSN Code', type: 'text', newField: 'new_hsn_code', oldField: 'hsn_code' },
  { key: 'product_group', label: 'Product Group', type: 'group', newField: 'new_product_group', oldField: 'product_group' },
  { key: 'sale_price', label: 'Sales Rate', type: 'number', newField: 'new_sales_rate', oldField: 'sales_rate' },
  { key: 'discount_value', label: 'Discount', type: 'number', newField: 'new_discount', oldField: 'discount' },
  { key: 'discount_type', label: 'Discount Type', type: 'discountType', newField: 'new_discount_type', oldField: 'discount_type' },
  { key: 'unit_type', label: 'Unit', type: 'unit', newField: 'new_unit', oldField: 'unit' }
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 19);
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function propertyConfig(key) {
  return PROPERTY_OPTIONS.find((option) => option.key === key) || PROPERTY_OPTIONS[0];
}

function parseGstOptions(value) {
  const parsed = String(value || '')
    .split(/[,;\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 0 && item <= 100)
    .filter((item, index, list) => list.indexOf(item) === index)
    .sort((a, b) => a - b)
    .map(String);
  return parsed.length > 1 ? parsed : DEFAULT_GST_OPTIONS;
}

function normalizePreviewValue(option, rawValue, gstOptions = DEFAULT_GST_OPTIONS) {
  const value = String(rawValue ?? '').trim();
  if (!value) return { error: 'Enter change property value.' };

  if (option.type === 'gst') {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 100) return { error: 'GST slab must be between 0 and 100.' };
    return { value: numberValue, display: `${numberValue}%` };
  }

  if (option.type === 'number') {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) return { error: `${option.label} must be zero or more.` };
    return { value: numberValue, display: formatMoney(numberValue) };
  }

  if (option.type === 'discountType') {
    const normalized = value.toUpperCase();
    if (!DISCOUNT_TYPE_OPTIONS.includes(normalized)) return { error: 'Select Percent or Value discount type.' };
    return { value: normalized, display: normalized };
  }

  if (option.type === 'unit') {
    if (!UNIT_OPTIONS.includes(value)) return { error: 'Select a valid unit.' };
    return { value, display: value };
  }

  const normalized = value.toUpperCase();
  return { value: normalized, display: normalized };
}

function displayValue(row, field) {
  if (!field) return '';
  const value = row[field];
  if (['mrp', 'sales_rate', 'discount', 'net_sales_rate', 'new_sales_rate', 'new_discount'].includes(field)) return formatMoney(value);
  if (['gst_slab', 'new_gst_slab'].includes(field)) return `${Number(value || 0)}%`;
  return value || '';
}

export default function PriceListView() {
  const [groups, setGroups] = useState(DEFAULT_GROUPS);
  const [gstOptions, setGstOptions] = useState(DEFAULT_GST_OPTIONS);
  const [productGroup, setProductGroup] = useState('ALL PRODUCTS');
  const [description, setDescription] = useState('');
  const [updatedBefore, setUpdatedBefore] = useState('');
  const [selectedProperty, setSelectedProperty] = useState('gst_percent');
  const [propertyValue, setPropertyValue] = useState('');
  const [priceListDate, setPriceListDate] = useState(todayIso);
  const [rows, setRows] = useState([]);
  const [selectedBarcodes, setSelectedBarcodes] = useState([]);
  const [lastQuery, setLastQuery] = useState({ group: 'ALL PRODUCTS', description: '', updatedBefore: '', total: 0, page: 1, totalPages: 1 });
  const [previewMeta, setPreviewMeta] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const activeProperty = propertyConfig(selectedProperty);
  const selectedSet = useMemo(() => new Set(selectedBarcodes), [selectedBarcodes]);
  const selectedRowsOnPage = rows.filter((row) => selectedSet.has(row.barcode));
  const allSelectedOnPage = rows.length > 0 && selectedRowsOnPage.length === rows.length;
  const totalPages = Math.max(Number(lastQuery.totalPages || 1), 1);
  const jobActive = activeJob && ['QUEUED', 'RUNNING'].includes(activeJob.status);
  const jobPercent = activeJob?.total_count ? Math.min(100, Math.round((Number(activeJob.processed_count || 0) / Number(activeJob.total_count || 1)) * 100)) : 0;
  const isBusy = isLoading || isSaving;

  useEffect(() => {
    fetchPriceListGroups()
      .then((apiGroups) => {
        const merged = [...DEFAULT_GROUPS, ...apiGroups].map((group) => String(group || '').trim().toUpperCase()).filter(Boolean);
        setGroups([...new Set(merged)]);
      })
      .catch(() => setGroups(DEFAULT_GROUPS));
    fetchSettings()
      .then((settings) => setGstOptions(parseGstOptions(settings.gst_slabs)))
      .catch(() => setGstOptions(DEFAULT_GST_OPTIONS));
  }, []);

  useEffect(() => {
    if (!jobActive) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const job = await fetchPriceListUpdateJob(activeJob.id);
        setActiveJob(job);
        if (!['QUEUED', 'RUNNING'].includes(job.status)) {
          setStatusMessage(`Update ${job.status}: ${job.updated_count || 0} products updated.`);
          setPreviewMeta(null);
          loadProducts(lastQuery.description ? 'product' : 'group', lastQuery.page || 1, true);
        }
      } catch (err) {
        setErrorMessage(err.response?.data?.error || 'Unable to refresh update status.');
      }
    }, 1200);

    return () => window.clearInterval(timer);
  }, [activeJob?.id, jobActive, lastQuery.description, lastQuery.page]);

  function resetMessages() {
    setStatusMessage('');
    setErrorMessage('');
  }

  function clearPreview(message = '') {
    setPreviewMeta(null);
    if (message) setStatusMessage(message);
  }

  function resetScreen() {
    setDescription('');
    setUpdatedBefore('');
    setPropertyValue('');
    setRows([]);
    setSelectedBarcodes([]);
    setLastQuery({ group: 'ALL PRODUCTS', description: '', updatedBefore: '', total: 0, page: 1, totalPages: 1 });
    setPreviewMeta(null);
    setActiveJob(null);
    resetMessages();
  }

  function updatePropertyValue(value) {
    setPropertyValue(value);
    if (previewMeta) clearPreview('Preview cleared because the value changed.');
  }

  async function loadProducts(mode, targetPage = 1, keepSelection = false) {
    resetMessages();
    const cleanedDescription = description.trim();
    if (mode === 'product' && cleanedDescription.length < 2) {
      setErrorMessage('Enter product name or product code to load product-wise details.');
      return;
    }

    const query = {
      group: mode === 'group' ? productGroup : 'ALL PRODUCTS',
      description: mode === 'product' ? cleanedDescription : '',
      updatedBefore,
      page: targetPage
    };

    setIsLoading(true);
    try {
      setPreviewMeta(null);
      const result = await fetchPriceListProducts({
        ...query,
        limit: PRICE_LIST_PAGE_SIZE
      });
      const total = Number(result.summary?.total || result.rows.length);
      const page = Number(result.summary?.page || targetPage);
      const pages = Number(result.summary?.totalPages || 1);
      setRows(result.rows);
      if (!keepSelection) {
        setSelectedBarcodes(result.rows.map((row) => row.barcode));
      }
      setLastQuery({ ...query, total, page, totalPages: pages });
      const rangeStart = total ? ((page - 1) * PRICE_LIST_PAGE_SIZE) + 1 : 0;
      const rangeEnd = Math.min(page * PRICE_LIST_PAGE_SIZE, total);
      setStatusMessage(result.rows.length ? `Showing ${rangeStart}-${rangeEnd} of ${total} matching products.` : 'No products found.');
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load price list products.');
    } finally {
      setIsLoading(false);
    }
  }

  function reloadPage(page) {
    loadProducts(lastQuery.description ? 'product' : 'group', page, true);
  }

  function updateSelection(barcode, checked) {
    const selected = new Set(selectedBarcodes);
    if (checked) {
      selected.add(barcode);
    } else {
      selected.delete(barcode);
    }
    setSelectedBarcodes([...selected]);
    if (previewMeta) clearPreview('Preview cleared because selection changed.');
  }

  function updateAllSelection(checked) {
    const selected = new Set(selectedBarcodes);
    rows.forEach((row) => {
      if (checked) {
        selected.add(row.barcode);
      } else {
        selected.delete(row.barcode);
      }
    });
    setSelectedBarcodes([...selected]);
    if (previewMeta) clearPreview('Preview cleared because selection changed.');
  }

  function previewChange() {
    resetMessages();
    const normalized = normalizePreviewValue(activeProperty, propertyValue, gstOptions);
    if (!rows.length) return setErrorMessage('Load products before changing property.');
    if (!selectedBarcodes.length) return setErrorMessage('Select at least one product.');
    if (normalized.error) return setErrorMessage(normalized.error);

    setPreviewMeta({
      property: selectedProperty,
      propertyLabel: activeProperty.label,
      value: normalized.value,
      display: normalized.display,
      count: selectedBarcodes.length
    });
    return setStatusMessage(`${selectedBarcodes.length} selected products previewed. Review old/new values, then press Update Products.`);
  }

  async function saveChanges() {
    resetMessages();
    const normalized = normalizePreviewValue(activeProperty, propertyValue, gstOptions);
    if (!previewMeta || previewMeta.property !== selectedProperty || normalized.error || String(previewMeta.value) !== String(normalized.value)) {
      setErrorMessage('Preview is not matching the current property/value. Click Change Property again before updating.');
      return;
    }
    const cleanBarcodes = [...new Set(selectedBarcodes.map((barcode) => String(barcode || '').trim().toUpperCase()).filter(Boolean))];
    if (!cleanBarcodes.length) return setErrorMessage('Select products before updating.');

    const confirmed = window.confirm(`Update ${cleanBarcodes.length} selected products? This will change ${previewMeta.propertyLabel} to ${previewMeta.display}.`);
    if (!confirmed) return;

    setIsSaving(true);
    try {
      const job = await startPriceListUpdateJob({
        barcodes: cleanBarcodes,
        selectedBarcodes: cleanBarcodes,
        group: lastQuery.group,
        description: lastQuery.description,
        updatedBefore: lastQuery.updatedBefore,
        property: previewMeta.property,
        value: previewMeta.value,
        update_date: priceListDate
      });
      setActiveJob(job);
      setStatusMessage(`Update job started for ${job.total_count || cleanBarcodes.length} selected products. You can continue billing/search while it runs.`);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to start selected product update.');
    } finally {
      setIsSaving(false);
    }
  }

  function renderValueInput() {
    if (activeProperty.type === 'gst') {
      return (
        <select className="select" value={propertyValue} onChange={(event) => updatePropertyValue(event.target.value)}>
          <option value="">Select GST</option>
          {gstOptions.map((gst) => <option key={gst} value={gst}>{gst}%</option>)}
        </select>
      );
    }
    if (activeProperty.type === 'group') {
      return (
        <>
          <input className="field" list="price-list-groups" value={propertyValue} onChange={(event) => updatePropertyValue(event.target.value.toUpperCase())} placeholder="GENERAL / FOOD / PLASTIC" />
          <datalist id="price-list-groups">
            {groups.filter((group) => group !== 'ALL PRODUCTS').map((group) => <option key={group} value={group} />)}
          </datalist>
        </>
      );
    }
    if (activeProperty.type === 'discountType') {
      return (
        <select className="select" value={propertyValue} onChange={(event) => updatePropertyValue(event.target.value)}>
          <option value="">Select type</option>
          {DISCOUNT_TYPE_OPTIONS.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
      );
    }
    if (activeProperty.type === 'unit') {
      return (
        <select className="select" value={propertyValue} onChange={(event) => updatePropertyValue(event.target.value)}>
          <option value="">Select unit</option>
          {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
        </select>
      );
    }
    return (
      <input
        className="field"
        type={activeProperty.type === 'number' ? 'number' : 'text'}
        step={activeProperty.type === 'number' ? '0.01' : undefined}
        min={activeProperty.type === 'number' ? '0' : undefined}
        value={propertyValue}
        onChange={(event) => updatePropertyValue(event.target.value)}
        placeholder={activeProperty.label}
      />
    );
  }

  return (
    <div className="price-list-view">
      <section className="panel price-list-panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">Mass Update</h2>
            <div className="inventory-stats">
              <span className="status-chip">Total Products {lastQuery.total}</span>
              <span className="status-chip">Page {lastQuery.page} of {totalPages}</span>
              <span className="status-chip">Loaded {rows.length} / 500</span>
              <span className="status-chip">Selected {selectedBarcodes.length}</span>
            </div>
          </div>
          <button className="secondary-button" type="button" onClick={resetScreen}>Clear</button>
        </div>
        <div className="panel-body form-stack">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}
          <div className="price-list-controls">
            <form className="price-list-search-box" onSubmit={(event) => { event.preventDefault(); loadProducts('product', 1, false); }}>
              <label>
                <span className="field-label">Product Group</span>
                <select className="select" value={productGroup} onChange={(event) => setProductGroup(event.target.value)}>
                  {groups.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={() => loadProducts('group', 1, false)} disabled={isLoading}>{isLoading ? 'Loading...' : 'Load Group Wise'}</button>
              <label>
                <span className="field-label">Product Description</span>
                <input className="field" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Product name / product code" />
              </label>
              <button className="secondary-button" type="submit" disabled={isLoading}>{isLoading ? 'Loading...' : 'Load Product Wise'}</button>
              <label>
                <span className="field-label">Updated Before</span>
                <input className="field" type="date" value={updatedBefore} onChange={(event) => setUpdatedBefore(event.target.value)} />
              </label>
            </form>
            <div className="price-list-change-box">
              <label>
                <span className="field-label">Select Property</span>
                <select className="select" value={selectedProperty} onChange={(event) => { setSelectedProperty(event.target.value); setPropertyValue(''); clearPreview(); }}>
                  {PROPERTY_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                </select>
              </label>
              <label>
                <span className="field-label">Change Property Value</span>
                {renderValueInput()}
              </label>
              <label>
                <span className="field-label">Mass Update Date</span>
                <input className="field" type="date" value={priceListDate} onChange={(event) => setPriceListDate(event.target.value)} />
              </label>
              <div className="price-list-action-stack">
                <button className="secondary-button" type="button" onClick={previewChange}>Change Property</button>
                <button className="primary-button" type="button" onClick={saveChanges} disabled={isSaving || jobActive || !previewMeta}>{isSaving ? 'Starting...' : jobActive ? 'Updating...' : 'Update Products'}</button>
              </div>
            </div>
          </div>
          {isBusy && (
            <div className="price-list-busy-box">
              <strong>{isSaving ? 'Updating selected products...' : 'Loading products...'}</strong>
              <small>Billing can continue while this page works.</small>
            </div>
          )}
          {activeJob && (
            <div className="price-list-job-box">
              <div><strong>Update job: {activeJob.status}</strong><small>{activeJob.processed_count || 0} of {activeJob.total_count || 0} processed, {activeJob.updated_count || 0} updated</small></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${jobPercent}%` }} /></div>
              {activeJob.failure_message && <small className="danger-text">{activeJob.failure_message}</small>}
            </div>
          )}
          <div className="price-list-pagebar">
            <button className="secondary-button" type="button" disabled={isLoading || lastQuery.page <= 1} onClick={() => reloadPage(lastQuery.page - 1)}>Previous 500</button>
            <strong>{lastQuery.total ? `${((lastQuery.page - 1) * PRICE_LIST_PAGE_SIZE) + 1}-${Math.min(lastQuery.page * PRICE_LIST_PAGE_SIZE, lastQuery.total)} of ${lastQuery.total}` : '0 products'}</strong>
            <button className="secondary-button" type="button" disabled={isLoading || lastQuery.page >= totalPages} onClick={() => reloadPage(lastQuery.page + 1)}>Next 500</button>
          </div>
          {previewMeta && (
            <div className="price-list-preview-banner">
              <span>Ready to update</span>
              <strong>{selectedBarcodes.length} selected products</strong>
              <small>{previewMeta.propertyLabel} will become {previewMeta.display}</small>
              <small>Only selected products will be updated.</small>
            </div>
          )}
          <div className="price-list-table-wrap">
            <table className="history-table price-list-table">
              <thead>
                <tr>
                  <th><input type="checkbox" checked={allSelectedOnPage} onChange={(event) => updateAllSelection(event.target.checked)} /></th>
                  <th>No</th>
                  <th>Product Group</th>
                  <th>Product Code</th>
                  <th>Description</th>
                  <th>HSN Code</th>
                  <th>Unit</th>
                  <th>GST Slab</th>
                  <th>MRP</th>
                  <th>Sales Rate</th>
                  <th>Discount</th>
                  <th>Discount Type</th>
                  <th>Net Sales Rate</th>
                  <th>Old Value</th>
                  <th>New Value</th>
                  <th>Last Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan="16">Load group-wise or product-wise details to review products.</td></tr>
                ) : rows.map((row, index) => {
                  const isSelected = selectedSet.has(row.barcode);
                  const previewed = Boolean(previewMeta && isSelected);
                  return (
                    <tr key={row.barcode} className={previewed ? 'price-list-preview-row' : ''}>
                      <td><input type="checkbox" checked={isSelected} onChange={(event) => updateSelection(row.barcode, event.target.checked)} /></td>
                      <td>{((lastQuery.page - 1) * PRICE_LIST_PAGE_SIZE) + index + 1}</td>
                      <td>{row.product_group}</td>
                      <td className="mono">{row.product_code || row.barcode}</td>
                      <td><strong>{row.description}</strong></td>
                      <td>{row.hsn_code}</td>
                      <td>{row.unit}</td>
                      <td>{displayValue(row, 'gst_slab')}</td>
                      <td>{displayValue(row, 'mrp')}</td>
                      <td>{displayValue(row, 'sales_rate')}</td>
                      <td>{displayValue(row, 'discount')}</td>
                      <td>{row.discount_type}</td>
                      <td>{displayValue(row, 'net_sales_rate')}</td>
                      <td><span className="muted">{displayValue(row, activeProperty.oldField)}</span></td>
                      <td>{previewed ? <span className="status-chip">{previewMeta.display}</span> : <span className="muted">-</span>}</td>
                      <td>{formatDateTime(row.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
