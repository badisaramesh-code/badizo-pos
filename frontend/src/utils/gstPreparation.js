// Preparation only. Matching a document does not establish legal ITC eligibility.
export const TAX_HEADS = ['igst', 'cgst', 'sgst', 'cess'];
const amount = value => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) throw new Error('GST document contains an invalid amount.');
  return Math.round(n * 100) / 100;
};
const text = value => String(value ?? '').trim().toUpperCase();
export const gstinHasValidFormat = value => /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(text(value));
export const zeroTax = () => Object.fromEntries(TAX_HEADS.map(head => [head, 0]));
export function gstUqc(unit) {
  return ({ NOS: 'NOS', PCS: 'PCS', PIECE: 'PCS', PIECES: 'PCS', KG: 'KGS', KGS: 'KGS', G: 'GMS', GM: 'GMS', GMS: 'GMS',
    L: 'LTR', LTR: 'LTR', LITRE: 'LTR', ML: 'MLT', MLT: 'MLT', M: 'MTR', MTR: 'MTR', BOX: 'BOX', PACK: 'PAC', PAC: 'PAC',
    SET: 'SET', DOZ: 'DOZ', BTL: 'BTL', BOTTLE: 'BTL', BAG: 'BAG', OTH: 'OTH' })[text(unit)] || null;
}
export function buildSplitHsn(rows = []) {
  return rows.map((row, index) => ({ num: index + 1, hsn_sc: String(row.hsn_code || ''), desc: '', uqc: gstUqc(row.unit_type),
    qty: amount(row.quantity), rt: amount(row.gst_percent), txval: amount(row.taxable_value),
    iamt: amount(row.igst), camt: amount(row.cgst), samt: amount(row.sgst), csamt: 0 }));
}
export function gstDate(value) {
  const s = String(value || '').trim();
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/) || s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!match) return '';
  const [year, month, day] = match[1].length === 4 ? match.slice(1) : [match[3], match[2], match[1]];
  const iso = `${year}-${month}-${day}`, parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : '';
}
export function gstMonthRange(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new Error('Select a valid return month.');
  const [year, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: `${month}-${new Date(Date.UTC(year, m, 0)).getUTCDate()}`, fp: month.slice(5) + month.slice(0, 4) };
}
const identity = row => `${text(row.gstin)}|${text(row.invoice)}|${row.date}`;
const totalFields = rows => rows.reduce((sum, row) => {
  for (const head of ['taxable', ...TAX_HEADS]) sum[head] = amount((sum[head] || 0) + amount(row[head]));
  return sum;
}, { taxable: 0, ...zeroTax() });

export function parseGstr2b(raw, { gstin, fp }) {
  let root = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw;
  for (let i = 0; i < 4 && root && !root.docdata && root.data; i++) root = root.data;
  if (!root || typeof root !== 'object' || !root.docdata || typeof root.docdata !== 'object') throw new Error('Upload the original GST portal GSTR-2B JSON with document details.');
  if (!gstinHasValidFormat(root.gstin) || text(root.gstin) !== text(gstin)) throw new Error('GSTR-2B GSTIN does not match the shop GSTIN.');
  if (String(root.rtnprd || root.fp) !== fp) throw new Error('GSTR-2B return period does not match the selected month.');
  const documents = [], unsupported = [];
  for (const [section, entries] of Object.entries(root.docdata)) {
    if (section !== 'b2b' && entries && (Array.isArray(entries) ? entries.length : Object.keys(entries).length)) unsupported.push(section);
  }
  if (root.docdata.b2b !== undefined && !Array.isArray(root.docdata.b2b)) throw new Error('Unsupported GSTR-2B B2B document structure.');
  for (const supplier of root.docdata.b2b || []) {
    if (!Array.isArray(supplier.inv)) throw new Error('GSTR-2B supplier invoices are missing.');
    for (const inv of supplier.inv) {
      const parts = Array.isArray(inv.items) ? inv.items.map(item => item.itm_det || item) : [inv];
      if (!parts.length || inv.val === undefined || parts.some(item => item.txval === undefined || !['igst', 'iamt', 'cgst', 'camt', 'sgst', 'samt'].some(head => item[head] !== undefined))) throw new Error('GSTR-2B invoice tax totals are missing or unsupported.');
      const values = totalFields(parts.map(item => ({ taxable: item.txval, igst: item.igst ?? item.iamt, cgst: item.cgst ?? item.camt, sgst: item.sgst ?? item.samt, cess: item.cess ?? item.csamt })));
      const row = { gstin: text(supplier.ctin), supplier: supplier.trdnm || '', invoice: text(inv.inum), date: gstDate(inv.dt),
        ...values, value: amount(inv.val), available: text(inv.itcavl), reverseCharge: text(inv.rev ?? inv.rchrg),
        invoiceType: text(inv.typ), imsStatus: text(inv.imsStatus || ''), reason: String(inv.rsn || '') };
      if (!gstinHasValidFormat(row.gstin) || !row.invoice || !row.date) throw new Error('A GSTR-2B invoice has an invalid supplier GSTIN, number or date.');
      if (['taxable', ...TAX_HEADS].some(head => row[head] < 0)) throw new Error('Negative B2B amounts require separate document review.');
      documents.push(row);
    }
  }
  return { gstin: text(root.gstin), fp, generated: root.gendt || '', documents, unsupported };
}

export function purchaseDocuments(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = row.inward_no || `${row.supplier_gstin}|${row.supplier_invoice_no}|${row.invoice_date}`;
    if (!grouped.has(key)) grouped.set(key, { gstin: text(row.supplier_gstin), invoice: text(row.supplier_invoice_no), date: gstDate(row.invoice_date),
      supplier: row.supplier_name || '', inward: row.inward_no || '', booked: gstDate(row.booking_date || row.invoice_date), taxable: 0, ...zeroTax(), value: 0 });
    const doc = grouped.get(key);
    for (const head of ['taxable', ...TAX_HEADS, 'value']) doc[head] = amount(doc[head] + amount(row[head === 'taxable' ? 'taxable_value' : head === 'value' ? 'invoice_value' : head]));
  }
  return [...grouped.values()];
}

export function reconcileGstr2b(books, statement, tolerance = 1, periodFrom = '') {
  const bookMap = new Map(), portalMap = new Map();
  for (const [docs, map] of [[books, bookMap], [statement.documents, portalMap]]) for (const doc of docs) {
    const key = identity(doc); if (!map.has(key)) map.set(key, []); map.get(key).push(doc);
  }
  const rows = [];
  for (const key of new Set([...bookMap.keys(), ...portalMap.keys()])) {
    const b = bookMap.get(key) || [], p = portalMap.get(key) || [], book = b[0], portal = p[0];
    // Historical purchases are loaded to match late-filed supplier invoices, not
    // to classify every prior-period invoice as missing from this month's 2B.
    if (!p.length && periodFrom && b.every(doc => doc.booked && doc.booked < periodFrom)) continue;
    let status;
    if (b.length > 1 || p.length > 1) status = 'DUPLICATE';
    else if (!book) status = 'ONLY_IN_2B';
    else if (!portal) status = 'ONLY_IN_BOOKS';
    else if (['taxable', 'value', ...TAX_HEADS].some(head => Math.abs(book[head] - portal[head]) > tolerance + 0.00001)) status = 'AMOUNT_MISMATCH';
    else if (portal.available !== 'Y' || portal.reverseCharge !== 'N' || !['', 'R'].includes(portal.invoiceType) || ['REJECTED', 'PENDING', 'R', 'P'].includes(portal.imsStatus)) status = 'REVIEW_ITC';
    else status = 'MATCHED_FOR_REVIEW';
    rows.push({ key, status, book, portal, bookCopies: b.length, portalCopies: p.length });
  }
  const matched = rows.filter(row => row.status === 'MATCHED_FOR_REVIEW').map(row => row.portal);
  return { rows, matchedTax: totalFields(matched), counts: rows.reduce((sum, row) => ({ ...sum, [row.status]: (sum[row.status] || 0) + 1 }), {}) };
}

export function buildItcWorking(sections) {
  const rows = sections.map(section => ({ section: section.section, ...Object.fromEntries(TAX_HEADS.map(head => {
    const value = amount(section[head]); if (value < 0) throw new Error('Enter non-negative amounts; use reversal sections for deductions.'); return [head, value];
  })) }));
  const net = zeroTax();
  for (const row of rows) {
    const sign = row.section.startsWith('4A') ? 1 : row.section.startsWith('4B') ? -1 : 0;
    for (const head of TAX_HEADS) net[head] = amount(net[head] + sign * row[head]);
  }
  return { rows, net };
}
