# Badizo POS

Badizo POS is a supermarket billing application for retail/wholesale checkout, GST/IGST billing, product inventory, barcode stickers, inward purchase entry, reports, books, and multi-counter operation.

## Current Modules

- Dashboard: daily sales, bills, stock alerts, payment summary.
- Billing POS: product search by barcode/name after 3 characters, 5 suggestions, retail/wholesale/GST/IGST modes, cash/UPI/card, hold/resume bill, bill history, thermal/A4 print mode.
- Invoice numbering: backend-controlled financial-year sequence with configurable counter-wise series, for example `BZ/26-27/C01/000001`.
- Products: product creation/editing, CSV import/export for Excel, barcode 128 value, auto/manual product code, HSN, GST slab, MRP, retail/wholesale price, discount, bulk discount, free item, low-stock alert.
- Barcode: 50x50mm sticker preview and TSC-244 Pro PRN command generation.
- Inward: supplier details and purchase product table.
- Reports: daily sales, monthly, counter-wise, GSTR-1, HSN GST, tax, stock, top/low products, debtors/creditors, staff report placeholders.
- Books: day book, ledger book, cash book, profit and loss, balance sheet, purchase book.
- System: server/admin/counter layout, shop settings, user role placeholders.
- Backup: manual database backup from System and automatic daily SQL backup on the server.

## Recommended System Requirements

- Server PC: Intel i5/Ryzen 5 or better, 16 GB RAM, SSD, Windows 11 Pro, LAN static IP.
- Counter PC: Intel i3 or better, 8 GB RAM, SSD, Windows 10/11.
- Database: MySQL 8.x.
- Runtime: Node.js 20 LTS or newer.
- Browser: Chrome or Edge.
- Printers: 80mm thermal printer for receipts, TSC-244 Pro for barcode stickers.
- Backup: external drive or NAS. Take daily SQL backups.

## Install

1. Install MySQL 8 and create/import the database:
   ```sql
   SOURCE database/schema.sql;
   ```
2. Install Node.js 20 LTS.
3. Install backend dependencies:
   ```bash
   cd backend
   npm install
   ```
4. Install frontend dependencies:
   ```bash
   cd frontend
   npm install
   ```
5. Configure database credentials in `backend/.env`:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=1234
   DB_NAME=badizo_pos
   PORT=5000
   ```

## Run For Testing

Start backend:
```bash
cd backend
npm run dev
```

Start frontend:
```bash
cd frontend
npm start
```

Open:
```text
http://localhost:3000
```

## Daily Operating Flow

1. Start MySQL server.
2. Start Badizo backend.
3. Start/open Badizo frontend on each counter.
4. Use Products to add/import product master data. Admin/Server users can download the CSV template, fill it in Excel, and import it back.
5. Use Inward for purchase entries and stock updates.
6. Use Billing POS for daily sales.
7. Use Reports and Books for end-of-day checking.
8. Take database backup at shop close.

## Final Testing Checklist

- Product search returns 5 suggestions for both name and barcode fragments.
- Barcode scan adds an item quickly and repeated scans merge into one cart line.
- Unknown barcode creates a red warning line and cannot be billed.
- Retail/wholesale price switches correctly.
- GST/IGST tax split is correct.
- Cash change calculation is correct.
- F12 cash, F11 UPI, F10 card, F9 search, F8 history work.
- Counter 1 to Counter 6 invoice numbers are unique and continue in financial-year format.
- Product CSV import rejects missing required columns, duplicate barcodes, invalid GST, and conflicting product codes.
- Hold and resume multiple bills.
- Thermal/A4 receipt print layout checked with real printer.
- TSC PRN sticker file tested on TSC-244 Pro.
- Low stock report matches products below minimum stock.
- Database backup and restore tested before daily use.

## Database Backup

Backups are saved as `.sql` files in `backend/backups` by default. Admin/Server users can open System and click `Backup Now`.

Optional backend `.env` settings:
```env
BACKUP_DIR=D:\BadizoPOSBackups
BACKUP_DAILY_TIME=22:30
MYSQLDUMP_PATH=C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe
```

Copy backup files to an external drive or cloud folder daily. Restore must be tested before using the software for live shop billing.

## Production Notes

For 2 lakh plus products and 2000 bills per day, keep the database on the server PC, connect counters through LAN, use indexed barcode/product-name search, and do not run the database from a shared folder. The current schema has barcode and product-name indexes, authenticated admin/server product changes, validated CSV import/export, and backend invoice sequence locking. Future production work should add audit logs, final receipt templates, scheduled backups, and restore testing.
