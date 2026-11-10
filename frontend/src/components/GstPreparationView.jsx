import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { fetchGstr1Report, fetchGstr2Report, fetchGstr3Report } from '../api/client';
import { TAX_HEADS, buildItcWorking, gstMonthRange, gstinHasValidFormat, parseGstr2b, purchaseDocuments, reconcileGstr2b, zeroTax } from '../utils/gstPreparation';
import { todayIso } from '../utils/date';

const ITC_SECTIONS = [
  ['4A1', 'Imports of goods'], ['4A2', 'Imports of services'], ['4A3', 'Reverse charge (other than imports)'],
  ['4A4', 'ISD credit'], ['4A5', 'All other ITC, including eligible reclaims'],
  ['4B1', 'Permanent reversals'], ['4B2', 'Other / temporary reversals'],
  ['4D1', 'ITC reclaimed (disclosure only)'], ['4D2', 'Ineligible ITC: time limit / place of supply']
];
const emptyItc = () => ITC_SECTIONS.map(([section, label]) => ({ section, label, ...zeroTax() }));
const plain = n => Number(n || 0).toFixed(2);

export default function GstPreparationView({ shop }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [loaded, setLoaded] = useState(null), [statement, setStatement] = useState(null);
  const [itc, setItc] = useState(emptyItc), [approved, setApproved] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [filter, setFilter] = useState('ALL');
  const requestRef = useRef(0);
  const importRef = useRef(0);
  useEffect(() => () => { ++requestRef.current; ++importRef.current; }, []);
  const result = useMemo(() => loaded && statement ? reconcileGstr2b(loaded.books, statement, 1, loaded.range.from) : null, [loaded, statement]);
  const working = useMemo(() => { try { return buildItcWorking(itc); } catch (e) { return { error: e.message }; } }, [itc]);
  const current = loaded && loaded.month === month && loaded.gstin === String(shop?.gst_number || '').trim().toUpperCase();
  const displayed = (result?.rows || []).filter(row => filter === 'ALL' || row.status === filter);

  function resetImport() { ++importRef.current; setStatement(null); setItc(emptyItc()); setApproved(false); setFilter('ALL'); }
  async function load() {
    const request = ++requestRef.current;
    setBusy(true); setError(''); setLoaded(null); resetImport();
    try {
      const range = gstMonthRange(month), gstin = String(shop?.gst_number || '').trim().toUpperCase();
      if (!gstinHasValidFormat(gstin)) throw new Error('A valid shop GSTIN is required for this working.');
      const [sales, purchases, summary] = await Promise.all([
        fetchGstr1Report(range), fetchGstr2Report({ from: '2017-07-01', to: range.to }), fetchGstr3Report(range)
      ]);
      if (request !== requestRef.current) return;
      setLoaded({ month, gstin, range, sales, summary, books: purchaseDocuments(purchases.b2b || []) });
    } catch (e) { if (request === requestRef.current) setError(e.response?.data?.error || e.message || 'Unable to load GST working.'); }
    finally { if (request === requestRef.current) setBusy(false); }
  }
  async function import2b(event) {
    const file = event.target.files?.[0], request = requestRef.current;
    event.target.value = '';
    if (!file || !current) return;
    setError(''); resetImport();
    const importId = importRef.current;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Use a GSTR-2B JSON file smaller than 20 MB.');
      const parsed = parseGstr2b(await file.text(), { gstin: loaded.gstin, fp: loaded.range.fp });
      if (request === requestRef.current && importId === importRef.current) setStatement(parsed);
    } catch (e) { if (request === requestRef.current && importId === importRef.current) setError(e.message || 'Unable to read GSTR-2B JSON.'); }
  }
  function changeMonth(value) { ++requestRef.current; setMonth(value); setLoaded(null); resetImport(); setBusy(false); setError(''); }
  function applyMatched() {
    if (!approved || !result) return;
    setItc(rows => rows.map(row => row.section === '4A5' ? { ...row, ...Object.fromEntries(TAX_HEADS.map(head => [head, result.matchedTax[head]])) } : row));
  }
  function exportWorking() {
    if (!current || !statement || !result || working.error) return;
    const workbook = XLSX.utils.book_new();
    const add = (name, rows) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No rows' }]), name);
    add('Read Me', [{ GSTIN: loaded.gstin, Period: loaded.range.fp, Status: 'DRAFT FOR REVIEW - NOT A PORTAL UPLOAD OR FILED RETURN',
      Note: 'B2B invoice reconciliation only. Verify all ITC eligibility, IMS actions, RCM, imports, notes, amendments, 3.2, exempt/non-GST inward, interest and payment utilization separately.',
      MatchedITCReviewed: approved ? 'Yes' : 'No', Other2BSections: statement.unsupported.join(', ') || 'None',
      BooksWindow: `Entries booked from 2017-07-01 through ${loaded.range.to}; older invoices may match this period. Earlier unmatched books are not automatically current-period ITC.` }]);
    add('2B Reconciliation', result.rows.map(row => ({ Status: row.status, GSTIN: (row.book || row.portal).gstin,
      Invoice: (row.book || row.portal).invoice, Date: (row.book || row.portal).date, Inward: row.book?.inward || '',
      BookCopies: row.bookCopies, PortalCopies: row.portalCopies,
      BooksTaxable: row.book?.taxable, PortalTaxable: row.portal?.taxable,
      ...Object.fromEntries(TAX_HEADS.flatMap(head => [[`Books ${head}`, row.book?.[head]], [`2B ${head}`, row.portal?.[head]]])),
      ITCAvailable: row.portal?.available || '', RCM: row.portal?.reverseCharge || '', Reason: row.portal?.reason || '' })));
    add('3B Table4 Working', [...working.rows, { section: '4C Net ITC (A minus B)', ...working.net }]);
    add('3B Outward Draft', loaded.summary.threeB?.outward || []);
    add('1 B2B Draft', loaded.sales.b2b || []); add('1 B2CL Draft', loaded.sales.b2cl || []);
    add('1 B2CS Draft', loaded.sales.b2c || []); add('1 HSN B2B Draft', loaded.sales.hsnB2b || []); add('1 HSN B2C Draft', loaded.sales.hsnB2c || []);
    add('Validation Checks', Object.entries(loaded.summary.checks || {}).flatMap(([check, rows]) => (Array.isArray(rows) ? rows : []).map(row => ({ check, ...row }))));
    XLSX.writeFile(workbook, `BADIZO-GST-WORKING-${loaded.gstin}-${loaded.range.fp}.xlsx`);
  }
  return <section className="panel" aria-label="GST return preparation">
    <div className="panel-header green"><h3>Regular GST — Return Preparation</h3></div>
    <div className="panel-body form-stack">
      <p>GSTR-1 working · GSTR-2B B2B invoice matching · GSTR-3B Table 4 working. This screen does not file a return or calculate final cash payable.</p>
      <div className="report-action-row"><label>Return month <input aria-label="GST return month" type="month" value={month} onChange={e => changeMonth(e.target.value)} /></label>
        <button type="button" disabled={busy} onClick={load}>{busy ? 'Loading GST working…' : 'Load GST Working'}</button>
        <label>Import portal GSTR-2B JSON <input aria-label="Import GSTR-2B JSON" type="file" accept=".json,application/json" disabled={!current || busy} onChange={import2b} /></label>
        <button type="button" onClick={exportWorking} disabled={!current || !statement || Boolean(working.error)}>Download Review Workbook</button>
      </div>
      {error && <div className="alert-box" role="alert">{error}</div>}
      {loaded && <p>GSTIN: <strong>{loaded.gstin}</strong> · {loaded.month} · {loaded.books.length} purchase documents available for matching (including older bookings).</p>}
      {statement && <p>2B documents: {statement.documents.length}. Import and working changes stay in this screen; download the workbook before leaving.</p>}
      {!!statement?.unsupported.length && <div className="alert-box">Other GSTR-2B sections require separate review: {statement.unsupported.join(', ')}. These are excluded from the matched-tax figure; this is not a complete ITC working.</div>}
      {result && <>
        <label>Reconciliation status <select aria-label="Reconciliation status" value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">All ({result.rows.length})</option>{Object.entries(result.counts).map(([status, count]) => <option key={status} value={status}>{status} ({count})</option>)}</select></label>
        <p>Matched tax for eligibility review: {TAX_HEADS.map(head => `${head.toUpperCase()} ${plain(result.matchedTax[head])}`).join(' · ')}. Matching does not approve ITC.</p>
        <div style={{ maxHeight: 360, overflow: 'auto' }}><table className="history-table"><thead><tr><th>Status</th><th>Supplier GSTIN</th><th>Invoice</th><th>Date</th><th>Books GST</th><th>2B GST</th></tr></thead><tbody>{displayed.slice(0, 200).map(row => <tr key={row.key}><td>{row.status}</td><td>{(row.book || row.portal).gstin}</td><td>{(row.book || row.portal).invoice}</td><td>{(row.book || row.portal).date}</td><td>{plain(TAX_HEADS.reduce((sum, head) => sum + (row.book?.[head] || 0), 0))}</td><td>{plain(TAX_HEADS.reduce((sum, head) => sum + (row.portal?.[head] || 0), 0))}</td></tr>)}</tbody></table></div>
        {displayed.length > 200 && <p>Showing first 200 matches. The review workbook contains all rows.</p>}
        <label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} /> I reviewed eligibility, goods/services receipt, blocked credit, time limits, payments and IMS status for the matched B2B documents.</label>
        <button type="button" disabled={!approved} onClick={applyMatched}>Copy reviewed matched B2B tax to 4(A)(5)</button>
      </>}
      {current && <>
        <h4>GSTR-3B Table 4 — editable review working</h4><p>Enter other eligible credits and reversals from verified records. 4(D) rows are disclosures and do not change net ITC. Review outward tables, 3.2, inward exempt/non-GST, interest and tax-head utilization separately before filing.</p>
        <table className="history-table"><thead><tr><th>Section</th>{TAX_HEADS.map(head => <th key={head}>{head.toUpperCase()}</th>)}</tr></thead><tbody>{itc.map((row, index) => <tr key={row.section}><td>{row.section} — {row.label}</td>{TAX_HEADS.map(head => <td key={head}><input style={{ width: 100 }} aria-label={`${row.section} ${head}`} type="number" min="0" step="0.01" value={row[head]} onChange={e => { const value = e.target.value; setItc(rows => rows.map((r, i) => i === index ? { ...r, [head]: value } : r)); }} /></td>)}</tr>)}</tbody><tfoot><tr><th>4(C) Net ITC</th>{TAX_HEADS.map(head => <td key={head}>{working.error ? 'Invalid amount' : plain(working.net[head])}</td>)}</tr></tfoot></table>
        {working.error && <div role="alert" className="alert-box">{working.error}</div>}
      </>}
    </div>
  </section>;
}
