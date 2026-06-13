import React, { useEffect, useState } from 'react';
import {
  deleteProductImport,
  fetchProductImportHistory,
  fetchProductImportHistoryDetail
} from '../api/client';

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function statusClass(status) {
  if (status === 'SUCCESS') return 'status-chip success';
  if (status === 'PARTIAL SUCCESS') return 'status-chip warning';
  if (status === 'ROLLED BACK') return 'status-chip muted';
  return 'status-chip danger';
}

export default function ProductImportHistoryView() {
  const [rows, setRows] = useState([]);
  const [expandedId, setExpandedId] = useState('');
  const [detailsById, setDetailsById] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    loadHistory();
  }, []);

  async function loadHistory() {
    setStatusMessage('');
    setErrorMessage('');
    setIsLoading(true);
    try {
      setRows(await fetchProductImportHistory());
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load product import history.');
    } finally {
      setIsLoading(false);
    }
  }

  async function toggleImport(importId) {
    if (expandedId === importId) {
      setExpandedId('');
      return;
    }

    setExpandedId(importId);
    if (detailsById[importId]) return;

    try {
      const detail = await fetchProductImportHistoryDetail(importId);
      setDetailsById((current) => ({ ...current, [importId]: detail }));
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to load import details.');
    }
  }

  async function deleteImport(importRow) {
    const confirmed = window.confirm(`Delete import ${importRow.file_name || importRow.id}? This will remove products inserted by this import and restore products updated by it.`);
    if (!confirmed) return;

    setStatusMessage('');
    setErrorMessage('');
    setIsDeleting(importRow.id);
    try {
      const result = await deleteProductImport(importRow.id);
      setStatusMessage(`Import deleted: ${result.deletedProducts || 0} products removed, ${result.restoredProducts || 0} products restored.`);
      setDetailsById((current) => {
        const next = { ...current };
        delete next[importRow.id];
        return next;
      });
      await loadHistory();
    } catch (err) {
      setErrorMessage(err.response?.data?.error || 'Unable to delete import.');
    } finally {
      setIsDeleting('');
    }
  }

  return (
    <div className="import-history-page">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Product Import History</h2>
            <div className="inventory-stats">
              <span className="status-chip">{rows.length} imports</span>
              <span className="status-chip">{rows.filter((row) => row.status === 'PARTIAL SUCCESS').length} partial</span>
              <span className="status-chip">{rows.filter((row) => row.status === 'FAILED').length} failed</span>
            </div>
          </div>
          <button className="secondary-button" type="button" onClick={loadHistory} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        <div className="panel-body">
          {errorMessage && <div className="alert-box">{errorMessage}</div>}
          {statusMessage && <div className="change-box">{statusMessage}</div>}

          <div className="bulk-table-wrap import-history-table-wrap">
            <table className="history-table import-history-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Date</th>
                  <th>File</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Inserted</th>
                  <th>Updated</th>
                  <th>Errors</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan="9">No product imports found.</td></tr>
                ) : (
                  rows.map((row) => {
                    const isExpanded = expandedId === row.id;
                    const detail = detailsById[row.id];
                    const lines = detail?.lines || [];
                    const errorLines = lines.filter((line) => line.action_status === 'ERROR');
                    const successLines = lines.filter((line) => ['INSERTED', 'UPDATED'].includes(line.action_status));

                    return (
                      <React.Fragment key={row.id}>
                        <tr>
                          <td><button className="secondary-button" type="button" onClick={() => toggleImport(row.id)}>{isExpanded ? 'Hide' : 'View'}</button></td>
                          <td>{formatDate(row.created_at)}</td>
                          <td>
                            <strong>{row.file_name || '-'}</strong>
                            <div className="muted compact-cell-text">{row.id}</div>
                          </td>
                          <td><span className={statusClass(row.status)}>{row.status}</span></td>
                          <td>{row.total_rows}</td>
                          <td>{row.inserted_count}</td>
                          <td>{row.updated_count}</td>
                          <td>{row.error_rows}</td>
                          <td>{row.created_by || '-'}</td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan="9">
                              <div className="change-box" style={{ marginBottom: 12 }}>
                                Imported: {successLines.length || row.valid_rows} rows. Errors: {errorLines.length || row.error_rows}. Batches: {row.batch_count}.
                                {row.failure_message ? ` Failure: ${row.failure_message}` : ''}
                                {row.rollback_status === 'ROLLED_BACK' ? ` Rolled back by ${row.rollback_by || '-'} on ${formatDate(row.rollback_at)}.` : ''}
                              </div>

                              {row.rollback_status !== 'ROLLED_BACK' && (
                                <button className="danger-button" type="button" onClick={() => deleteImport(row)} disabled={isDeleting === row.id}>
                                  {isDeleting === row.id ? 'Deleting Import...' : 'Delete Import'}
                                </button>
                              )}

                              <div className="bulk-table-wrap import-history-table-wrap" style={{ marginTop: 12 }}>
                                <table className="history-table import-history-detail-table">
                                  <thead>
                                    <tr><th>Row</th><th>Status</th><th>Code</th><th>Barcode</th><th>Product</th><th>Message</th></tr>
                                  </thead>
                                  <tbody>
                                    {!detail ? (
                                      <tr><td colSpan="6">Loading details...</td></tr>
                                    ) : errorLines.length === 0 && row.status === 'FAILED' ? (
                                      <tr>
                                        <td>0</td>
                                        <td><span className={statusClass('FAILED')}>FAILED</span></td>
                                        <td>-</td>
                                        <td>-</td>
                                        <td>{row.file_name || '-'}</td>
                                        <td>{row.failure_message || 'Import failed before row-level details were recorded.'}</td>
                                      </tr>
                                    ) : errorLines.length === 0 ? (
                                      <tr><td colSpan="6">No failure rows in this import.</td></tr>
                                    ) : (
                                      errorLines.map((line) => (
                                        <tr key={line.id}>
                                          <td>{line.row_no}</td>
                                          <td><span className={statusClass('FAILED')}>{line.action_status}</span></td>
                                          <td className="mono muted">{line.product_code || '-'}</td>
                                          <td className="mono muted">{line.barcode || '-'}</td>
                                          <td>{line.product_name || '-'}</td>
                                          <td>{line.error_message || '-'}</td>
                                        </tr>
                                      ))
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
