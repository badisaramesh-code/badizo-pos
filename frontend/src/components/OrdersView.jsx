import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchSpecialOrderDetails,
  fetchSpecialOrderReceivables,
  fetchSpecialOrders,
  fetchUpcomingSpecialOrders,
  fetchCustomers,
  recordSpecialOrderPayment,
  saveSpecialOrder,
  updateSpecialOrderStatus
} from '../api/client';
import { formatMoney, toNumber } from '../utils/money';

const SECTIONS = {
  UPCOMING: 'upcoming',
  FORM: 'form',
  ALL: 'all',
  RECEIVABLES: 'receivables'
};

const blankOrder = {
  order_no: '',
  customer_name: '',
  customer_phone: '',
  event_type: 'Marriage / Function',
  required_date: '',
  delivery_time: '',
  order_status: 'CONFIRMED',
  priority: 'IMPORTANT',
  advance_amount: '',
  advance_payment_mode: 'Cash',
  advance_reference_no: '',
  due_date: '',
  notes: ''
};

const blankItem = {
  item_name: '',
  barcode: '',
  quantity: '1',
  unit: 'Nos',
  estimated_rate: '',
  procurement_type: 'SPECIAL_ORDER',
  procurement_status: 'NOT_ORDERED',
  supplier_name: '',
  notes: ''
};

const blankPayment = {
  order_no: '',
  customer_name: '',
  amount: '',
  payment_date: todayIso(),
  payment_mode: 'Cash',
  reference_no: '',
  notes: ''
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

function dueAgeLabel(value) {
  if (!value) return '-';
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return '-';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return 'Today';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

function statusClass(status) {
  if (status === 'PAID' || status === 'READY' || status === 'DELIVERED' || status === 'CLOSED') return 'success';
  if (status === 'OVERDUE' || status === 'CANCELLED') return 'danger';
  if (status === 'URGENT' || status === 'NEED_TO_ORDER') return 'warning';
  return 'info';
}

export default function OrdersView() {
  const [activeSection, setActiveSection] = useState(SECTIONS.UPCOMING);
  const [upcomingOrders, setUpcomingOrders] = useState([]);
  const [orders, setOrders] = useState([]);
  const [receivables, setReceivables] = useState({ rows: [], summary: { total_receivable: 0, overdue_count: 0, order_count: 0 } });
  const [orderForm, setOrderForm] = useState(blankOrder);
  const [items, setItems] = useState([{ ...blankItem }]);
  const [paymentForm, setPaymentForm] = useState(blankPayment);
  const [orderFilter, setOrderFilter] = useState({ search: '', status: 'OPEN' });
  const [receivableSearch, setReceivableSearch] = useState('');
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [customerSuggestions, setCustomerSuggestions] = useState([]);
  const [isCustomerLookupOpen, setIsCustomerLookupOpen] = useState(false);
  const [isCustomerSuggestionLoading, setIsCustomerSuggestionLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadUpcoming();
    loadOrders();
    loadReceivables();
  }, []);

  useEffect(() => {
    const query = orderForm.customer_name.trim();
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
  }, [orderForm.customer_name]);

  const totals = useMemo(() => {
    const total = items.reduce((sum, item) => {
      const lineTotal = toNumber(item.quantity) * toNumber(item.estimated_rate);
      return sum + lineTotal;
    }, 0);
    const paid = orderForm.order_no ? 0 : toNumber(orderForm.advance_amount);
    return { total, balance: Math.max(total - paid, 0) };
  }, [items, orderForm.advance_amount, orderForm.order_no]);

  async function loadUpcoming() {
    try {
      setUpcomingOrders(await fetchUpcomingSpecialOrders());
    } catch (err) {
      setUpcomingOrders([]);
    }
  }

  async function loadOrders() {
    setIsLoading(true);
    try {
      setOrders(await fetchSpecialOrders(orderFilter));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load special orders.');
    } finally {
      setIsLoading(false);
    }
  }

  async function loadReceivables() {
    try {
      setReceivables(await fetchSpecialOrderReceivables({ search: receivableSearch }));
    } catch (err) {
      setReceivables({ rows: [], summary: { total_receivable: 0, overdue_count: 0, order_count: 0 } });
    }
  }

  function updateOrder(field, value) {
    setOrderForm((current) => ({ ...current, [field]: value }));
    if (field === 'required_date' && !orderForm.due_date) {
      setOrderForm((current) => ({ ...current, required_date: value, due_date: value }));
    }
  }

  function selectCustomerSuggestion(customer) {
    setOrderForm((current) => ({
      ...current,
      customer_name: customer.customer_name || '',
      customer_phone: customer.phone || ''
    }));
    setCustomerSuggestions([]);
    setIsCustomerLookupOpen(false);
    setStatusMessage(`${customer.customer_name || 'Customer'} loaded from customer master.`);
  }

  function updateItem(index, field, value) {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index
        ? {
          ...item,
          [field]: value,
          ...(field === 'procurement_type' && value === 'REGULAR_STOCK' ? { procurement_status: 'NOT_REQUIRED' } : {})
        }
        : item
    )));
  }

  function addItem() {
    setItems((current) => [...current, { ...blankItem }]);
  }

  function removeItem(index) {
    setItems((current) => (current.length === 1 ? current : current.filter((_, itemIndex) => itemIndex !== index)));
  }

  function resetForm() {
    setOrderForm(blankOrder);
    setItems([{ ...blankItem }]);
    setSelectedDetails(null);
  }

  async function submitOrder(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setIsSaving(true);
    try {
      const result = await saveSpecialOrder({ ...orderForm, items });
      setStatusMessage(`Special order ${result.order_no} saved. Balance due ${formatMoney(result.balance_due)}.`);
      resetForm();
      await loadUpcoming();
      await loadOrders();
      await loadReceivables();
      setActiveSection(SECTIONS.UPCOMING);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to save special order.');
    } finally {
      setIsSaving(false);
    }
  }

  async function openOrder(orderNo) {
    setErrorMessage('');
    try {
      const details = await fetchSpecialOrderDetails(orderNo);
      setSelectedDetails(details);
      setOrderForm({
        ...blankOrder,
        ...details.order,
        required_date: details.order.required_date ? String(details.order.required_date).slice(0, 10) : '',
        due_date: details.order.due_date ? String(details.order.due_date).slice(0, 10) : '',
        advance_amount: ''
      });
      setItems(details.items.map((item) => ({
        item_name: item.item_name || '',
        barcode: item.barcode || '',
        quantity: String(item.quantity ?? ''),
        unit: item.unit || 'Nos',
        estimated_rate: String(item.estimated_rate ?? ''),
        procurement_type: item.procurement_type || 'SPECIAL_ORDER',
        procurement_status: item.procurement_status || 'NOT_ORDERED',
        supplier_name: item.supplier_name || '',
        notes: item.notes || ''
      })));
      setActiveSection(SECTIONS.FORM);
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to open special order.');
    }
  }

  async function changeStatus(orderNo, status) {
    setErrorMessage('');
    try {
      await updateSpecialOrderStatus(orderNo, status);
      setStatusMessage(`Order ${orderNo} marked ${status}.`);
      await loadUpcoming();
      await loadOrders();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to update order status.');
    }
  }

  function startPayment(row) {
    setPaymentForm({
      ...blankPayment,
      order_no: row.order_no,
      customer_name: row.customer_name,
      amount: String(row.balance_due || ''),
      payment_date: todayIso()
    });
    setActiveSection(SECTIONS.RECEIVABLES);
  }

  async function submitPayment(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setIsSaving(true);
    try {
      const result = await recordSpecialOrderPayment(paymentForm.order_no, paymentForm);
      setStatusMessage(`Payment recorded for ${paymentForm.order_no}. Balance ${formatMoney(result.balance_due)}.`);
      setPaymentForm(blankPayment);
      await loadUpcoming();
      await loadOrders();
      await loadReceivables();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to record payment.');
    } finally {
      setIsSaving(false);
    }
  }

  function renderOrderTable(rows, emptyText = 'No special orders found.') {
    return (
      <table className="history-table">
        <thead>
          <tr><th>Required</th><th>Order</th><th>Customer</th><th>Event</th><th>Status</th><th>Total</th><th>Advance/Paid</th><th>Balance</th><th>Action</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan="9">{emptyText}</td></tr>
          ) : rows.map((row) => (
            <tr key={row.order_no}>
              <td><strong>{formatDate(row.required_date)}</strong><div className="muted compact-cell-text">{dueAgeLabel(row.required_date)}</div></td>
              <td className="mono">{row.order_no}</td>
              <td>{row.customer_name}<div className="muted compact-cell-text">{row.customer_phone}</div></td>
              <td>{row.event_type || '-'}</td>
              <td><span className={`status-chip ${statusClass(row.order_status)}`}>{row.order_status}</span></td>
              <td>{formatMoney(row.total_amount)}</td>
              <td>{formatMoney(row.paid_amount || row.advance_amount)}</td>
              <td><strong>{formatMoney(row.balance_due)}</strong></td>
              <td>
                <button className="secondary-button" type="button" onClick={() => openOrder(row.order_no)}>Open</button>
                {row.balance_due > 0 && <button className="secondary-button" type="button" onClick={() => startPayment(row)}>Pay</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <div className="form-stack">
      <section className="panel">
        <div className="panel-header green">
          <div>
            <h2 className="panel-title">Special Orders</h2>
            <span className="panel-subtitle">Future customer orders, procurement reminders, and customer receivables.</span>
          </div>
          <button className="primary-button compact-primary" type="button" onClick={() => setActiveSection(SECTIONS.FORM)}>New Order</button>
        </div>
        <div className="panel-body">
          <div className="product-section-tabs" role="tablist" aria-label="Orders sections">
            <button type="button" className={activeSection === SECTIONS.UPCOMING ? 'active' : ''} onClick={() => { setActiveSection(SECTIONS.UPCOMING); loadUpcoming(); }}>Next 7 Days</button>
            <button type="button" className={activeSection === SECTIONS.FORM ? 'active' : ''} onClick={() => setActiveSection(SECTIONS.FORM)}>Add / Edit Order</button>
            <button type="button" className={activeSection === SECTIONS.ALL ? 'active' : ''} onClick={() => { setActiveSection(SECTIONS.ALL); loadOrders(); }}>All Orders</button>
            <button type="button" className={activeSection === SECTIONS.RECEIVABLES ? 'active' : ''} onClick={() => { setActiveSection(SECTIONS.RECEIVABLES); loadReceivables(); }}>Customer Receivables</button>
          </div>
        </div>
      </section>

      {errorMessage && <div className="alert-box">{errorMessage}</div>}
      {statusMessage && <div className="change-box">{statusMessage}</div>}

      {activeSection === SECTIONS.UPCOMING && (
        <section className="panel">
          <div className="panel-header green">
            <div>
              <h2 className="panel-title">Urgent Orders: Next 7 Days</h2>
              <span className="panel-subtitle">Review this daily so special procurement is not missed.</span>
            </div>
            <button className="secondary-button" type="button" onClick={loadUpcoming}>Refresh</button>
          </div>
          <div className="panel-body form-stack">
            {renderOrderTable(upcomingOrders, 'No urgent special orders in the next 7 days.')}
          </div>
        </section>
      )}

      {activeSection === SECTIONS.FORM && (
        <section className="panel">
          <div className="panel-header green">
            <div>
              <h2 className="panel-title">{orderForm.order_no ? `Edit ${orderForm.order_no}` : 'New Special Order'}</h2>
              <span className="panel-subtitle">Use for marriage, function, freezer item, return gift, and bulk customer orders.</span>
            </div>
            <button className="secondary-button" type="button" onClick={resetForm}>Clear</button>
          </div>
          <form className="panel-body form-stack" onSubmit={submitOrder}>
            <div className="special-order-grid">
              <label className="supplier-lookup-field">
                <span className="field-label">Customer Name</span>
                <input
                  className="field"
                  value={orderForm.customer_name}
                  onChange={(event) => updateOrder('customer_name', event.target.value)}
                  onFocus={() => {
                    if (customerSuggestions.length) setIsCustomerLookupOpen(true);
                  }}
                  onBlur={() => setTimeout(() => setIsCustomerLookupOpen(false), 180)}
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
              <label><span className="field-label">Phone</span><input className="field" value={orderForm.customer_phone} onChange={(event) => updateOrder('customer_phone', event.target.value)} /></label>
              <label><span className="field-label">Event Type</span><input className="field" value={orderForm.event_type} onChange={(event) => updateOrder('event_type', event.target.value)} /></label>
              <label><span className="field-label">Required Date</span><input className="field" type="date" value={orderForm.required_date} onChange={(event) => updateOrder('required_date', event.target.value)} /></label>
              <label><span className="field-label">Delivery Time</span><input className="field" value={orderForm.delivery_time} onChange={(event) => updateOrder('delivery_time', event.target.value)} /></label>
              <label>
                <span className="field-label">Priority</span>
                <select className="select" value={orderForm.priority} onChange={(event) => updateOrder('priority', event.target.value)}>
                  <option value="IMPORTANT">Important</option>
                  <option value="URGENT">Urgent</option>
                  <option value="NORMAL">Normal</option>
                </select>
              </label>
              <label>
                <span className="field-label">Status</span>
                <select className="select" value={orderForm.order_status} onChange={(event) => updateOrder('order_status', event.target.value)}>
                  <option value="CONFIRMED">Confirmed</option>
                  <option value="NEED_TO_ORDER">Need to Order</option>
                  <option value="ORDERED">Ordered</option>
                  <option value="READY">Ready</option>
                  <option value="DELIVERED">Delivered</option>
                  <option value="CLOSED">Closed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </label>
              <label><span className="field-label">Due Date</span><input className="field" type="date" value={orderForm.due_date} onChange={(event) => updateOrder('due_date', event.target.value)} /></label>
              {!orderForm.order_no && <label><span className="field-label">Advance Amount</span><input className="field" type="number" min="0" step="0.01" value={orderForm.advance_amount} onChange={(event) => updateOrder('advance_amount', event.target.value)} /></label>}
              {!orderForm.order_no && (
                <label>
                  <span className="field-label">Advance Mode</span>
                  <select className="select" value={orderForm.advance_payment_mode} onChange={(event) => updateOrder('advance_payment_mode', event.target.value)}>
                    <option value="Cash">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="Card">Card</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cheque">Cheque</option>
                  </select>
                </label>
              )}
              {!orderForm.order_no && <label><span className="field-label">Advance Reference</span><input className="field" value={orderForm.advance_reference_no} onChange={(event) => updateOrder('advance_reference_no', event.target.value)} /></label>}
              <label className="special-order-notes"><span className="field-label">Notes</span><input className="field" value={orderForm.notes} onChange={(event) => updateOrder('notes', event.target.value)} /></label>
            </div>

            <div className="bulk-table-wrap">
              <table className="history-table">
                <thead>
                  <tr><th>Item</th><th>Barcode</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Total</th><th>Procurement</th><th>Status</th><th>Supplier</th><th>Notes</th><th></th></tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={`special-item-${index}`}>
                      <td><input className="field" value={item.item_name} onChange={(event) => updateItem(index, 'item_name', event.target.value)} /></td>
                      <td><input className="field" value={item.barcode} onChange={(event) => updateItem(index, 'barcode', event.target.value.toUpperCase())} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', event.target.value)} /></td>
                      <td><input className="field compact-number-field" value={item.unit} onChange={(event) => updateItem(index, 'unit', event.target.value)} /></td>
                      <td><input className="field compact-number-field" type="number" min="0" step="0.01" value={item.estimated_rate} onChange={(event) => updateItem(index, 'estimated_rate', event.target.value)} /></td>
                      <td>{formatMoney(toNumber(item.quantity) * toNumber(item.estimated_rate))}</td>
                      <td>
                        <select className="select" value={item.procurement_type} onChange={(event) => updateItem(index, 'procurement_type', event.target.value)}>
                          <option value="SPECIAL_ORDER">Special Order</option>
                          <option value="REGULAR_STOCK">Regular Stock</option>
                        </select>
                      </td>
                      <td>
                        <select className="select" value={item.procurement_status} onChange={(event) => updateItem(index, 'procurement_status', event.target.value)}>
                          <option value="NOT_ORDERED">Not Ordered</option>
                          <option value="ORDERED">Ordered</option>
                          <option value="RECEIVED">Received</option>
                          <option value="NOT_REQUIRED">Not Required</option>
                        </select>
                      </td>
                      <td><input className="field" value={item.supplier_name} onChange={(event) => updateItem(index, 'supplier_name', event.target.value)} /></td>
                      <td><input className="field" value={item.notes} onChange={(event) => updateItem(index, 'notes', event.target.value)} /></td>
                      <td><button className="danger-button" type="button" onClick={() => removeItem(index)}>Del</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="summary-band">
              <span>Total: <strong>{formatMoney(orderForm.order_no && selectedDetails ? selectedDetails.order.total_amount : totals.total)}</strong></span>
              <span>Balance: <strong>{formatMoney(orderForm.order_no && selectedDetails ? selectedDetails.order.balance_due : totals.balance)}</strong></span>
              <button className="secondary-button" type="button" onClick={addItem}>Add Item</button>
              <button className="primary-button compact-primary" type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : 'Save Order'}</button>
            </div>
          </form>
        </section>
      )}

      {activeSection === SECTIONS.ALL && (
        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">All Special Orders</h2></div>
          <div className="panel-body form-stack">
            <form className="history-search-row inward-history-filters" onSubmit={(event) => { event.preventDefault(); loadOrders(); }}>
              <label><span className="field-label">Search</span><input className="field" value={orderFilter.search} onChange={(event) => setOrderFilter((current) => ({ ...current, search: event.target.value }))} /></label>
              <label>
                <span className="field-label">Status</span>
                <select className="select" value={orderFilter.status} onChange={(event) => setOrderFilter((current) => ({ ...current, status: event.target.value }))}>
                  <option value="OPEN">Open</option>
                  <option value="ALL">All</option>
                  <option value="NEED_TO_ORDER">Need to Order</option>
                  <option value="ORDERED">Ordered</option>
                  <option value="READY">Ready</option>
                  <option value="DELIVERED">Delivered</option>
                  <option value="CLOSED">Closed</option>
                </select>
              </label>
              <button className="primary-button compact-primary" type="submit" disabled={isLoading}>Search</button>
            </form>
            {renderOrderTable(orders)}
          </div>
        </section>
      )}

      {activeSection === SECTIONS.RECEIVABLES && (
        <section className="panel">
          <div className="panel-header green"><h2 className="panel-title">Customer Receivables</h2></div>
          <div className="panel-body form-stack">
            <form className="supplier-payment-form" onSubmit={submitPayment}>
              <label><span className="field-label">Order No</span><input className="field" value={paymentForm.order_no} onChange={(event) => setPaymentForm((current) => ({ ...current, order_no: event.target.value }))} /></label>
              <label><span className="field-label">Customer</span><input className="field" value={paymentForm.customer_name} disabled /></label>
              <label><span className="field-label">Amount</span><input className="field" type="number" min="0" step="0.01" value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} /></label>
              <label><span className="field-label">Payment Date</span><input className="field" type="date" value={paymentForm.payment_date} onChange={(event) => setPaymentForm((current) => ({ ...current, payment_date: event.target.value }))} /></label>
              <label>
                <span className="field-label">Mode</span>
                <select className="select" value={paymentForm.payment_mode} onChange={(event) => setPaymentForm((current) => ({ ...current, payment_mode: event.target.value }))}>
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Card">Card</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Cheque">Cheque</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label><span className="field-label">Reference</span><input className="field" value={paymentForm.reference_no} onChange={(event) => setPaymentForm((current) => ({ ...current, reference_no: event.target.value }))} /></label>
              <label className="supplier-payment-notes"><span className="field-label">Notes</span><input className="field" value={paymentForm.notes} onChange={(event) => setPaymentForm((current) => ({ ...current, notes: event.target.value }))} /></label>
              <button className="primary-button compact-primary" type="submit" disabled={isSaving}>{isSaving ? 'Saving...' : 'Record Payment'}</button>
            </form>

            <form className="history-search-row" onSubmit={(event) => { event.preventDefault(); loadReceivables(); }}>
              <input className="field" value={receivableSearch} onChange={(event) => setReceivableSearch(event.target.value)} placeholder="Search customer / phone / order no" />
              <button className="primary-button compact-primary" type="submit">Search Receivables</button>
            </form>
            <div className="summary-band">
              <span>Orders: <strong>{receivables.summary.order_count}</strong></span>
              <span>Total Receivable: <strong>{formatMoney(receivables.summary.total_receivable)}</strong></span>
              <span>Overdue: <strong>{receivables.summary.overdue_count}</strong></span>
            </div>
            {renderOrderTable(receivables.rows, 'No customer receivables pending.')}
          </div>
        </section>
      )}
    </div>
  );
}
