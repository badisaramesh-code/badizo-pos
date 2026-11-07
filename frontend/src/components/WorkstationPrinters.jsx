import React, { useState } from 'react';

export default function WorkstationPrinters() {
  const [inventory, setInventory] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const desktop = window.badizoDesktop;
  async function refresh() {
    setBusy(true);
    setInventory(null);
    setError('');
    try {
      const result = await desktop.getBarcodePrinters();
      if (!Array.isArray(result?.printers)) throw Error('Printer inventory unavailable');
      setInventory(result);
    } catch {
      setError('Windows printer inventory is unavailable on this workstation. Check the Print Spooler and open Printers & scanners.');
    } finally {
      setBusy(false);
    }
  }
  return <div className="change-box">
    <strong>Printers on this workstation</strong>
    {desktop?.getBarcodePrinters ? <>
      <p>Receipts normally use the Windows default printer. For desktop barcode labels, check the printer selected in Barcode against this list. A server login sends labels to the server printer.</p>
      <button type="button" className="secondary-button" onClick={refresh} disabled={busy}>{busy ? 'Checking printers…' : 'Check workstation printers'}</button>
      {inventory && <div role="status">
        {inventory.systemName && <strong>{inventory.systemName}</strong>}
        {inventory.printers.length ? <ul>{inventory.printers.map(printer => <li key={printer.name}>{printer.name}{printer.isDefault ? ' (Windows default)' : ''}</li>)}</ul> :
          <p>No printer queues found. Install the receipt or label printer in Windows, then check again.</p>}
      </div>}
      {error && <p role="alert">{error}</p>}
    </> : <span>For receipts, check the printer selected in the browser print dialog. Browser barcode labels use the configured server printer share.</span>}
  </div>;
}
