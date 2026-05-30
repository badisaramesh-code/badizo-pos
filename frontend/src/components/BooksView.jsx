import React from 'react';

const books = [
  ['Day Book', 'All daily transactions in chronological order', 'Today: Rs. 48,250'],
  ['Ledger Book', 'Account-wise debit and credit ledger', '248 accounts'],
  ['Cash Book', 'Cash receipts and payments journal', 'Balance: Rs. 24,800'],
  ['Profit & Loss', 'Income statement for the period', 'Net Profit: Rs. 2.8L'],
  ['Balance Sheet', 'Assets, liabilities and equity', 'FY 2026-27'],
  ['Purchase Book', 'All purchase inward entries', 'Rs. 68.4L this month']
];

export default function BooksView() {
  return (
    <div className="books-grid">
      {books.map(([title, note, value]) => (
        <button className="module-card" key={title}>
          <strong>{title}</strong>
          <span className="muted">{note}</span>
          <span className="status-chip">{value}</span>
        </button>
      ))}
    </div>
  );
}
