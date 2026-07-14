# Badizo POS Project Knowledge Base

This document is a future handover guide for Badizo POS. If support is needed later, give this file to Codex or any developer first so they can understand the project quickly.

## 1. Project Purpose

Badizo POS is a supermarket/shop POS system with:

- Billing/POS checkout
- Thermal bill printing
- Product master and Excel/CSV import
- Barcode sticker printing
- Inward/purchase entry
- Supplier master, dues, payments, and purchase orders
- Special/customer function orders and receivables
- Reports, books/ledger, counter closing
- System settings, users, backups, password vault
- Electron packaging planned/available, but current testing is mainly browser based

## 2. High-Level Architecture

```text
Browser / Electron UI
        |
        | HTTP API calls through frontend/src/api/client.js
        v
Node.js Express backend
        |
        | mysql2 pool
        v
MySQL database badizo_pos
```

Main runtime parts:

- Backend: `backend/server.js`
- Backend routes: `backend/routes/*`
- Database schema/migrations: `backend/config/db.js`
- Frontend React app: `frontend/src/App.js`
- Frontend API wrapper: `frontend/src/api/client.js`
- Frontend screens: `frontend/src/components/*`
- Barcode PRN templates: `barcode/templates/*`
- Electron shell: `electron/main.js`

## 3. Setup Files

### Root Files

| File/Folder | Purpose |
|---|---|
| `README.md` | Basic project setup and overview. |
| `BROWSER_TEST_SETUP_GUIDE.md` | Browser-based local testing setup guide. |
| `BARCODE_STICKER_SETUP_GUIDE.md` | Barcode sticker printer setup guide. |
| `THERMAL_PRINTER_SETUP_GUIDE.md` | Thermal receipt printer setup guide. |
| `PROJECT_KNOWLEDGE_BASE.md` | This architecture/handover document. |
| `.gitignore` | Excludes node_modules/build/log/runtime files. |
| `backend/` | Express API, DB setup, routes, services. |
| `frontend/` | React UI. |
| `electron/` | Desktop packaging shell. |
| `barcode/` | PRN templates, output files, raw-print helper scripts. |
| `database/` | SQL schema reference. |
| `scripts/` | Helper scripts, mainly Windows setup/startup support. |
| `thermal/` | Thermal print assets/config area if present. |

## 4. Backend Architecture

### `backend/server.js`

Express entry point.

Responsibilities:

- Creates Express app.
- Enables CORS.
- Parses JSON bodies up to `250mb` for large imports.
- Exposes `/api/health`.
- Mounts routes from `backend/routes/index.js`.
- Starts server on `PORT` from `.env`, default `5000`.
- Starts daily backup scheduler.

### `backend/routes/index.js`

Central route registry. Each route file is mounted under an `/api/...` prefix.

Important mappings:

```text
/api/auth                 -> backend/routes/auth.js
/api/audit                -> backend/routes/audit.js
/api/accounting-vouchers  -> backend/routes/accountingVouchers.js
/api/backup               -> backend/routes/backup.js
/api/barcode              -> backend/routes/barcode.js
/api/books                -> backend/routes/books.js
/api/products             -> backend/routes/products.js
/api/billing              -> backend/routes/billing.js
/api/counter-closing      -> backend/routes/counterClosing.js
/api/customers            -> backend/routes/customers.js
/api/inward               -> backend/routes/inward.js
/api/settings             -> backend/routes/settings.js
/api/reports              -> backend/routes/reports.js
/api/special-orders       -> backend/routes/specialOrders.js
/api/users                -> backend/routes/users.js
```

If a frontend URL fails, first map the URL to this file.

## 5. Backend Config And Database

### `backend/config/db.js`

Most important backend file after routes.

Responsibilities:

- Loads `.env`.
- Creates MySQL connection pool.
- Ensures database tables exist.
- Applies schema upgrades using `ensureColumn`.
- Inserts default users and settings.

Important rule:

Schema changes are applied when backend starts because `db.js` creates/migrates tables during initialization.

Main tables created:

```text
users
products
product_import_jobs
product_import_lines
invoices
invoice_items
product_batches
barcode_print_logs
password_vault
invoice_item_batches
batch_free_offers
invoice_payments
held_bills
invoice_sequences
app_settings
inward_entries
inward_items
suppliers
purchase_orders
purchase_order_items
supplier_payments
audit_logs
stock_adjustments
sales_returns
sales_return_items
customers
special_orders
special_order_items
special_order_payments
loyalty_transactions
counter_closings
counter_handover_sheets
counter_handover_entries
counter_handover_denominations
accounting_vouchers
counter_cash_ledger_entries
```

Default app settings inserted include:

```text
shop_name
gst_number
phone
address
bank details
counter_count
default_print_mode
thermal_receipt_width_mm
thermal_feed_margin_mm
barcode_printer_templates
```

### `database/schema.sql`

Reference SQL schema. The live app mostly relies on `backend/config/db.js` for automatic creation/migration.

## 6. Backend Middleware And Services

### `backend/middleware/auth.js`

Responsibilities:

- JWT authentication.
- Role-based authorization.
- Roles: `SERVER`, `ADMIN`, `COUNTER`.
- Provides `authenticate` and `authorize`.

Common issue:

If API returns `Login required`, the request has no valid token. Frontend token handling is in `frontend/src/api/client.js`.

### `backend/services/auditService.js`

Writes audit log entries for important actions.

Used by billing, product changes, inward, purchase orders, etc.

### `backend/services/backupService.js`

Handles MySQL backup/restore scheduling and filesystem backup folder logic.

Reads paths from `.env`:

```text
BACKUP_DIR
MYSQLDUMP_PATH
MYSQL_PATH
BACKUP_DAILY_TIME
```

### `backend/services/invoiceNumberService.js`

Generates and manages invoice number sequences.

Important for billing and counter-safe invoice numbering.

### `backend/utils/formatters.js`

Shared backend formatting helpers, especially money parsing.

## 7. Backend Routes By Responsibility

### `backend/routes/auth.js`

API:

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/approve-sensitive-mode`

Used for:

- Login
- Current user
- Admin/sensitive approvals

### `backend/routes/users.js`

User management from System screen.

API:

- `GET /api/users`
- `POST /api/users`

### `backend/routes/settings.js`

System settings and password vault.

API:

- `GET /api/settings`
- `POST /api/settings`
- `GET /api/settings/password-vault`
- `POST /api/settings/password-vault/:slotNo`
- `GET /api/settings/password-vault/:slotNo/reveal`

Important settings:

- Thermal width/feed margin
- Default print mode
- Barcode sticker printer mappings
- Shop name/GST/phone/address
- Bank details
- Counter count

### `backend/routes/products.js`

Large product/inventory route.

Main responsibilities:

- Product list/search/save
- Fast barcode lookup
- Exact barcode/product-code lookup
- Excel/CSV import
- Import history
- Product dropbox/unused products
- Duplicate product-code cleanup
- Bulk edit
- Stock adjustment
- Expiry dashboard
- Reorder suggestions
- Product export/template

Important APIs:

```text
GET    /api/products
GET    /api/products/search/:query
GET    /api/products/exact/:query
POST   /api/products/save
POST   /api/products/import
GET    /api/products/import-history
GET    /api/products/import-history/:id
DELETE /api/products/import-history/:id
GET    /api/products/dropbox
DELETE /api/products/dropbox/bulk-delete
GET    /api/products/duplicate-codes
DELETE /api/products/duplicate-codes/bulk-delete
GET    /api/products/expiry-dashboard
GET    /api/products/reorder-suggestions
POST   /api/products/stock-adjustments
```

Known design notes:

- Product import is batch-oriented.
- Import history shows status.
- Product Dropbox identifies old/unused products using sales/inward activity.
- Product page is list-first with tabs/sections.

### `backend/routes/billing.js`

Core POS billing route.

Responsibilities:

- Next invoice number
- Checkout
- Stock deduction
- Batch stock consumption
- Free promo/free offer handling
- Held bills
- Invoice details/reprint
- Invoice void
- Sales return

Important APIs:

```text
GET    /api/billing/invoice/next
POST   /api/billing/checkout
GET    /api/billing/invoice/details
POST   /api/billing/invoice/reprint
POST   /api/billing/invoice/void
POST   /api/billing/return
POST   /api/billing/hold
GET    /api/billing/holds
GET    /api/billing/hold/list
DELETE /api/billing/hold/:token
```

Important behavior:

- Billing must be fast for barcode scanners.
- Exact barcode scan should add product immediately.
- Same product scanned multiple times should increment/add quantity, not be ignored.
- Held bills are stored in `held_bills`.
- Thermal/A4 printing is frontend-driven.

### `backend/routes/barcode.js`

Barcode sticker PRN generation and raw printing.

Responsibilities:

- Reads PRN templates from `barcode/templates`.
- Replaces placeholders like product name, barcode, MRP, SP, company, address.
- Saves PRN output in `barcode/output`.
- Logs print activity in `barcode_print_logs`.
- Sends PRN to shared Windows printer path using `copy /b`.
- Reads printer mappings from `app_settings.barcode_printer_templates`.

Important APIs:

```text
GET  /api/barcode/template
GET  /api/barcode/print-logs
POST /api/barcode/prn
POST /api/barcode/print
```

Important files:

```text
barcode/templates/tsc-244-1-33x25-single.prn
barcode/templates/tsc-244-pro-50x50-two-up.prn
barcode/templates/tsc-244-2-jewellery-100x15-tail.prn
```

### `backend/routes/inward.js`

Inward, purchase, supplier, and supplier payable workflows.

Responsibilities:

- Supplier master
- Supplier autocomplete/search
- Inward purchase entry
- Draft/post inward
- Stock/batch creation from inward
- Purchase orders
- Supplier dues
- Supplier payments
- Supplier ledger

Important APIs:

```text
GET    /api/inward/suppliers
POST   /api/inward/suppliers
GET    /api/inward/suppliers/search
GET    /api/inward/supplier-dues
POST   /api/inward/supplier-payments
GET    /api/inward/supplier-ledger
GET    /api/inward/purchase-orders
GET    /api/inward/purchase-orders/:poNo
POST   /api/inward/purchase-orders
POST   /api/inward/purchase-orders/:poNo/status
GET    /api/inward/recent
GET    /api/inward/history
GET    /api/inward/by-number/:inwardNo/details
GET    /api/inward/:id/details
POST   /api/inward
DELETE /api/inward/:id
```

Route-order warning:

Specific routes like `/purchase-orders` and `/recent` must appear before generic routes like `/:id/details`.

### `backend/routes/customers.js`

Customer master/lookup used by Billing and Orders receivables.

API:

```text
GET  /api/customers/lookup/:phone
GET  /api/customers
POST /api/customers
```

### `backend/routes/specialOrders.js`

Special customer/function orders.

Responsibilities:

- Customer request orders for future dates
- Upcoming urgent orders
- Receivables/advance/partial payments
- Status updates

API:

```text
GET  /api/special-orders/upcoming
GET  /api/special-orders
GET  /api/special-orders/receivables
GET  /api/special-orders/:orderNo
POST /api/special-orders
POST /api/special-orders/:orderNo/status
POST /api/special-orders/:orderNo/payments
```

### `backend/routes/reports.js`

Reports for dashboard, sales, GST, stock, reprints, exceptions, counter handover, GSTR1, etc.

Important APIs:

```text
GET /api/reports/dashboard
GET /api/reports/daily-sales
GET /api/reports/daily-sales/export
GET /api/reports/reprints
GET /api/reports/counter-sale-slip
GET /api/reports/counter-handover
GET /api/reports/gst-hsn
GET /api/reports/monthly-sales
GET /api/reports/stock
GET /api/reports/top-products
GET /api/reports/tax-summary
GET /api/reports/exchange-bills
GET /api/reports/gstr1
GET /api/reports/exceptions
```

### `backend/routes/counterClosing.js`

Counter cash closing and handover.

API:

```text
GET  /api/counter-closing/expected
POST /api/counter-closing
GET  /api/counter-closing/summary
GET  /api/counter-closing/handover
POST /api/counter-closing/handover
GET  /api/counter-closing/handover/history
```

### `backend/routes/books.js`

Ledger/day-book/reporting screens.

API:

```text
GET /api/books/summary
GET /api/books/day-book
GET /api/books/accounting
```

### `backend/routes/accountingVouchers.js`

Manual accounting voucher entry.

API:

```text
POST /api/accounting-vouchers
```

### `backend/routes/backup.js`

Backup/restore APIs.

API:

```text
GET  /api/backup
POST /api/backup/run
GET  /api/backup/download/:file
POST /api/backup/restore
```

### `backend/routes/audit.js`

Audit log viewer.

API:

```text
GET /api/audit
```

## 8. Frontend Architecture

### `frontend/src/index.js`

React entry point.

### `frontend/src/App.js`

Main shell:

- Handles login state.
- Renders top sticky navigation.
- Mounts allowed tabs by role.
- Keeps already-opened workspaces mounted.

Workspace keys:

```text
dashboard
billing
closing
inventory
importHistory
orders
barcode
inward
reports
books
system
```

### `frontend/src/config/navigation.js`

Defines:

- User roles
- Tab labels
- Role access
- Hidden import history tab

### `frontend/src/api/client.js`

Single frontend API wrapper.

Responsibilities:

- Axios instance
- Base URL: `REACT_APP_API_BASE_URL` or `http://localhost:5000/api`
- Auth token storage/interceptor
- Exported functions for every backend API

If an API call fails, search here first for the frontend function name and endpoint.

### `frontend/src/styles.css`

Global CSS for the whole app.

Contains:

- App layout
- Topbar/nav
- Billing layout
- Tables/forms
- Print styles
- Barcode sticker previews
- Responsive behavior

## 9. Frontend Components

### `LoginView.jsx`

Login form. Calls `login()` from API client.

### `DashboardView.jsx`

Dashboard summaries and navigation shortcuts.

### `BillingTerminalView.jsx`

Largest and most important frontend file.

Responsibilities:

- POS billing screen
- Barcode scanner/search input
- Fast exact barcode handling
- Cart lines/quantity/discounts/exchange/free products
- Customer handling
- Hold bill / held bill restore
- Checkout
- Thermal/A4 print rendering
- Reprint and history panels
- Price check behavior

Important printing functions:

```text
printCounterSaleSlip()
schedulePrint()
handleReprint()
```

Thermal settings consumed:

```text
shopSettings.thermal_receipt_width_mm
shopSettings.thermal_feed_margin_mm
shopSettings.default_print_mode
```

### `PrintableInvoice.jsx`

Reusable invoice print markup for thermal and A4 invoices.

Contains:

- Thermal logo area
- Customer block
- Item table
- GST/totals
- Exchange and free product sections
- QR code rendering

### `invoiceTemplates.js`

Template metadata/helpers for invoice layout.

### `InventoryDashboardView.jsx`

Products screen.

Responsibilities:

- Product list
- Product add/edit
- Import products
- Bulk edit
- Product dropbox/unused products
- Duplicate cleanup
- Stock adjustment
- Expiry dashboard
- Reorder suggestions

### `ProductImportHistoryView.jsx`

Import history and import detail viewer.

### `BarcodeStickersView.jsx`

Barcode sticker print screen.

Responsibilities:

- Select sticker size/template
- Search/scan product
- Preview sticker
- Generate PRN
- Send PRN to configured printer
- Download PRN file
- Admin PRN template setup

Uses:

```text
fetchBarcodeTemplate()
generateBarcodePrn()
printBarcodePrn()
fetchSettings()
```

### `InwardEntryView.jsx`

Inward/purchase module.

Responsibilities:

- Inward purchase entry
- Draft/post inward
- Supplier lookup/master
- Purchase orders
- Supplier dues/payments/ledger
- Batch, expiry, free offer handling

### `OrdersView.jsx`

Special customer orders and receivables.

Responsibilities:

- Function/marriage/bulk orders
- Upcoming urgent order list
- Advance/partial payments
- Receivables view

### `ReportsView.jsx`

Reports UI for sales/GST/stock/reprints/exceptions/etc.

### `BooksView.jsx`

Ledger books/day book/accounting reports.

### `CounterClosingView.jsx`

Counter closing and handover UI.

### `SystemView.jsx`

System setup.

Responsibilities:

- Store details
- Bank details
- Counters
- Default print mode
- Thermal width/feed margin
- Barcode sticker printer settings
- Password protected vault
- User management
- Backup/restore
- Audit logs

## 10. Barcode Printing Architecture

Barcode printing is raw TSPL/PRN based.

Flow:

```text
BarcodeStickersView
  -> generateBarcodePrn()
  -> POST /api/barcode/prn
  -> backend renders PRN from barcode/templates
  -> saves barcode/output/*.prn
  -> printBarcodePrn()
  -> POST /api/barcode/print
  -> backend copy /b file to \\localhost\PrinterShare
```

Printer mappings are configurable:

```text
System > Open Setup Folder > Barcode Sticker Printers
```

Stored in:

```text
app_settings.setting_key = barcode_printer_templates
```

Key files:

```text
backend/routes/barcode.js
frontend/src/components/BarcodeStickersView.jsx
frontend/src/components/SystemView.jsx
barcode/templates/*.prn
BARCODE_STICKER_SETUP_GUIDE.md
```

Known physical sticker behavior:

- `33 x 25 mm Two-Up`: two labels side-by-side
- `50 x 50 mm Two-Up`: two labels side-by-side
- `100 x 15 mm Jewellery Tail`: one tail label per feed

Important: PRN template coordinates are in printer dots, not CSS pixels.

For 203 dpi printers:

```text
1 mm ≈ 8 dots
```

## 11. Thermal Printing Architecture

Thermal receipt printing currently uses browser printing:

```text
window.print()
```

The app controls:

- receipt width
- print CSS
- feed margin
- A4/Thermal mode

The browser/Windows controls actual printer selection.

Key files:

```text
frontend/src/components/BillingTerminalView.jsx
frontend/src/components/PrintableInvoice.jsx
frontend/src/components/SystemView.jsx
backend/routes/settings.js
THERMAL_PRINTER_SETUP_GUIDE.md
```

Settings:

```text
default_print_mode
thermal_receipt_width_mm
thermal_feed_margin_mm
```

For browser testing, set Epson thermal printer as Windows default.

## 12. Product Import Architecture

Product import is handled by:

```text
frontend/src/components/InventoryDashboardView.jsx
frontend/src/components/ProductImportHistoryView.jsx
backend/routes/products.js
```

Data tables:

```text
product_import_jobs
product_import_lines
products
product_batches
```

Known behavior:

- File upload creates/updates products in batches.
- Import history tracks row-level success/failure.
- Large imports should be chunked and monitored.
- The app was improved so import should not show final failed state too early.

If import seems slow:

- Check backend logs.
- Check DB indexes on `products.barcode` and `products.product_code`.
- Check import history route.
- Avoid importing while frontend is repeatedly refreshing large product lists.

## 13. Billing/POS Scanner Architecture

Key files:

```text
frontend/src/components/BillingTerminalView.jsx
backend/routes/products.js
backend/routes/billing.js
```

Scanner rules:

- Exact barcode scan should add product immediately.
- Same barcode scanned again should increase/add quantity.
- Manual typing should show suggestions.
- Price Check should fetch on scan without pressing Check.

If scanner is slow:

- Inspect scanner input handling in `BillingTerminalView.jsx`.
- Inspect exact lookup API in `backend/routes/products.js`.
- Confirm product barcode exists exactly in `products.barcode`.
- Check browser focus is in scanner input.

## 14. Inward/Purchase/Supplier Architecture

Key files:

```text
frontend/src/components/InwardEntryView.jsx
backend/routes/inward.js
```

Main tables:

```text
inward_entries
inward_items
suppliers
supplier_payments
purchase_orders
purchase_order_items
product_batches
batch_free_offers
```

Purchase orders:

- UI in Inward section.
- Supplier autocomplete after 3 letters.
- Selected supplier pre-fills GSTIN and phone.
- PO status: `DRAFT`, `ORDERED`, `RECEIVED`, `CANCELLED`.

Supplier dues:

- Created/derived from posted inward credit bills.
- Payments stored in `supplier_payments`.
- Ledger combines purchases and payments.

## 15. Special Orders / Receivables Architecture

Key files:

```text
frontend/src/components/OrdersView.jsx
backend/routes/specialOrders.js
backend/routes/customers.js
```

Tables:

```text
special_orders
special_order_items
special_order_payments
customers
```

Use case:

- Future marriage/function/customer request orders.
- Next 7 days urgent order view.
- Advance and partial payments.
- Customer receivables.

## 16. Reports And Books Architecture

Reports:

```text
frontend/src/components/ReportsView.jsx
backend/routes/reports.js
```

Books:

```text
frontend/src/components/BooksView.jsx
backend/routes/books.js
backend/routes/accountingVouchers.js
```

Counter closing:

```text
frontend/src/components/CounterClosingView.jsx
backend/routes/counterClosing.js
```

## 17. Electron Architecture

Electron files:

```text
electron/main.js
electron/package.json
electron/README.md
```

Current browser mode is primary for testing.

Electron package:

- Bundles backend.
- Bundles frontend build.
- Can package Windows installer with `electron-builder`.

Potential future improvement:

- Direct silent printing to selected thermal printer.
- Printer list in System settings.
- Avoid browser print dialog.

## 18. Environment Variables

Backend `.env` typical values:

```text
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=...
DB_NAME=badizo_pos
PORT=5000
JWT_SECRET=...
BACKUP_DIR=D:\BadizoPOSBackups
BACKUP_DAILY_TIME=22:30
MYSQLDUMP_PATH=C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe
MYSQL_PATH=C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe
```

Frontend API base:

```text
REACT_APP_API_BASE_URL=http://localhost:5000/api
```

If not set, frontend defaults to:

```text
http://localhost:5000/api
```

## 19. Common Commands

### Check Node/npm

```powershell
node -v
npm -v
```

### Install backend dependencies

```powershell
cd D:\badizo-pos-main\backend
npm ci
```

### Install frontend dependencies

```powershell
cd D:\badizo-pos-main\frontend
npm ci
```

### Start backend

```powershell
cd D:\badizo-pos-main\backend
node server.js
```

Background start:

```powershell
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'D:\badizo-pos-main\backend' -WindowStyle Hidden
```

### Start frontend

```powershell
cd D:\badizo-pos-main\frontend
npm start
```

### Check backend process

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Select-Object ProcessId,CommandLine
```

### Stop backend by PID

```powershell
Stop-Process -Id BACKEND_PID -Force
```

### Check port 5000

```powershell
Test-NetConnection -ComputerName localhost -Port 5000 | Select-Object ComputerName,RemotePort,TcpTestSucceeded
```

### Build frontend

```powershell
cd D:\badizo-pos-main\frontend
npm run build
```

### Backend syntax checks

```powershell
node --check backend\routes\barcode.js
node --check backend\routes\settings.js
node --check backend\config\db.js
```

## 20. Debugging Map

### If API URL fails

1. Find frontend function in `frontend/src/api/client.js`.
2. Map URL to backend route in `backend/routes/index.js`.
3. Check route file for exact path.
4. Check `authenticate`/`authorize` requirements.
5. Test with login token if needed.

### If database column/table error appears

1. Search table/column in `backend/config/db.js`.
2. Confirm backend restarted after schema change.
3. Confirm MySQL user has ALTER/CREATE permissions.
4. Check `ensureColumn` order and table existence.

### If product scan is slow

1. Check `BillingTerminalView.jsx`.
2. Check `lookupExactProduct()` in `frontend/src/api/client.js`.
3. Check `/api/products/exact/:query` in `products.js`.
4. Confirm DB index on `products.barcode`.

### If import fails

1. Check browser Network response for `/api/products/import`.
2. Check `product_import_jobs`.
3. Check `product_import_lines`.
4. Open `ProductImportHistoryView.jsx`.
5. Inspect import code in `backend/routes/products.js`.

### If barcode sticker does not print

1. Check POS settings: `System > Barcode Sticker Printers`.
2. Run `Get-Printer`.
3. Confirm Windows ShareName.
4. Try manual `copy /b`.
5. Inspect generated PRN in `barcode/output`.
6. Inspect template in `barcode/templates`.

### If thermal bill prints to wrong printer

1. Browser mode uses Windows/browser printer choice.
2. Set Epson as default.
3. Check Chrome print dialog selected printer.
4. Check `THERMAL_PRINTER_SETUP_GUIDE.md`.

## 21. Git Workflow Notes

Before changing:

```powershell
git status --short --branch
git pull origin main
```

After changing:

```powershell
git status --short --branch
git diff --stat
git add <files>
git commit -m "Clear message"
git push origin main
```

Recent important commits:

```text
6589be9 Refine POS billing and print behavior
4680eec Configure barcode sticker printers
235b5e0 Configure thermal receipt print settings
60e6e1d Improve POS barcode scanning flows
8852344 Fast barcode scan auto-adds item without pressing Enter.
```

## 22. Files To Read First In Future Support Session

If a future Codex session has limited time, read these first:

```text
PROJECT_KNOWLEDGE_BASE.md
BROWSER_TEST_SETUP_GUIDE.md
BARCODE_STICKER_SETUP_GUIDE.md
THERMAL_PRINTER_SETUP_GUIDE.md
backend/routes/index.js
backend/config/db.js
frontend/src/api/client.js
frontend/src/App.js
frontend/src/config/navigation.js
```

Then read the workflow-specific file:

```text
Billing issue        -> BillingTerminalView.jsx, billing.js, products.js
Product issue        -> InventoryDashboardView.jsx, products.js
Import issue         -> InventoryDashboardView.jsx, ProductImportHistoryView.jsx, products.js
Inward/PO issue      -> InwardEntryView.jsx, inward.js
Orders issue         -> OrdersView.jsx, specialOrders.js, customers.js
Barcode issue        -> BarcodeStickersView.jsx, barcode.js, barcode/templates/*.prn
Thermal print issue  -> BillingTerminalView.jsx, PrintableInvoice.jsx, SystemView.jsx
Settings issue       -> SystemView.jsx, settings.js, db.js
Reports issue        -> ReportsView.jsx, reports.js
Books issue          -> BooksView.jsx, books.js
```

## 23. Current Caution Areas

- `BillingTerminalView.jsx`, `InwardEntryView.jsx`, and `products.js` are large files. Make small targeted changes and test carefully.
- Browser thermal printing cannot reliably force printer selection; Electron should handle that later.
- Barcode PRN coordinates depend on physical sticker roll and printer calibration.
- Schema changes are automatic but only run when backend starts.
- Avoid deleting/reverting unknown local changes without checking `git status`.
## Permanent shortcut branding rule

- Every Badizo desktop shortcut must use the official Badizo **B** logo.
- Never leave a Badizo shortcut with a generic monitor, browser, CMD, or blank-file icon.
- Preferred Windows shortcut icon: `electron/assets/badizo.ico`.
- Available source artwork: `frontend/public/badizo-logo.jpg` and `frontend/public/badizo-logo-transparent.png`.
- This rule applies to Server, Admin, Counter, Security, setup, and future Badizo shortcuts.

