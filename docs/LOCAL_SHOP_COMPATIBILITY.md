# Local shop compatibility

This change preserves the standalone Basic SKU draft workflow while retaining the
current main branch's billing, recovery, sync, authentication and printer fixes.

## Basic SKU

Open `/api/basic-skus/page` and sign in as SERVER or ADMIN. Import a CSV with
`product_code,product_name,unit_type,mrp,sale_price` headers (friendly names such
as Product Code and Sale Price are accepted). Optional columns are `gst_percent`,
`hsn_code`, `purchase_price`, `stock_qty`, and `wholesale_price`.

Imports are drafts, not billable products. Fill GST, HSN and Unit before publishing.
CSV import supports up to 30,000 rows; updates/publication accept up to 500 selected
draft IDs. Duplicate product/code errors and product sync outbox failures roll back
the complete publication transaction. Publication uses main's product-capture
hooks. Successful audit calls retain main's current failure-only audit policy.

Normal database bootstrap creates the additive `basic_sku_drafts` table. For
installations with database bootstrap disabled, apply
`database/migrations/basic-sku-drafts.sql` to the intended database during the
approved maintenance window. Existing rows are preserved. Do not run the full
`database/schema.sql` script against an existing shop; that script drops the database.

## Local backups

The scheduled backup script locates its backend relative to its own directory.
Set `BADIZO_CLOUD_BACKUP_DIR` to the backup root and `LOCAL_BACKUP_KEEP_COUNT` to
the desired retained daily-file count (zero keeps all). The daily subfolder,
health report and catch-up task use this root. An explicit
`BADIZO_SCHEDULED_BACKUP_DIR` still overrides the backup-listing source.

Set `GOOGLE_DRIVE_BACKUP_ENABLED=false` for local-only daily backups; no scheduled
daily cloud request is made. Local backup failure is still reported as failed,
even if an older local backup exists. Set it to true only when Drive is configured.
Explicit `upload-folder` requests are also rejected while Drive is disabled.
`BADIZO_DISABLE_SCHEDULED_CLOUD_BACKUP=true` disables the catch-up scheduler itself,
including local backups; leave it false when using the local daily scheduler.
This change does not create Windows tasks or alter a deployed environment file.

## Existing local invoice numbering

Default main invoice numbering is unchanged. Shops already using a counter-free
format can opt in with `BADIZO_LEGACY_INVOICE_PREFIX`, producing
`<prefix>/<financial-year>/<sequence>` (minimum three digits). Preserve each
shop's actual prefix in its private deployment configuration.

Optional `BADIZO_LEGACY_INVOICE_START_YEAR` and
`BADIZO_LEGACY_INVOICE_START_NUMBER` establish a minimum only in the specified
financial year. Allocation never reduces existing sequence or invoice maxima;
both standard and legacy local formats are searched. Example for a synthetic shop:

```dotenv
BADIZO_LEGACY_INVOICE_PREFIX=EXAMPLE
BADIZO_LEGACY_INVOICE_START_YEAR=26-27
BADIZO_LEGACY_INVOICE_START_NUMBER=800
```

Cloud and recovery invoice namespaces always take precedence over compatibility
mode. Validate numbering continuation with a restored database before deployment.

## Deployment boundary

Do not copy environment files, accounts, bank details, customer data, old backup
source files, dependency directories or generated bundles into the source branch.
Keep shop identity, bank details and printer configuration as deployment settings.
Test on a separate database and port with scheduled jobs and printing disabled.
Obtain the maintenance-window approval before replacing live files, applying
migrations, altering production settings or restarting the backend.

## Persistent backup controls

Server / Admin users can configure the backup root, local retention count, Drive enablement, whether to keep local copies, Drive retention and daily time in System Settings. Settings are stored atomically in app_settings and apply to the next job without a restart. Drive credentials remain in the server environment; the enable switch does not create a Google connection.

Local generation is always required. Keep local copies defaults to true, including when Drive is enabled; turning Drive off forces it on. Optional removal after upload requires verified matching remote bytes and is never performed for desktop-sync copies or recovery-bound artifacts. Pending/unverified files are preserved even when this exceeds configured retention. A zero local retention count keeps all local copies.

Until settings are saved, environment paths/counts remain effective. An explicit Drive=false overrides credentials; existing credible Drive configuration is recognized when the old enable variable is absent. Changing the root sends future jobs to its daily/manual subfolders; it does not move or delete old files. Legacy environment folders remain available in the backup list. Files from other previous user-selected folders remain on disk and can be accessed by selecting that folder again.

Health reports local and cloud outcomes separately. Disabled Drive cannot produce Google failure alerts, but local write/read/retention failures remain visible. Catch-up follows the configured daily time and reads fresh settings each pass. The standalone script reads settings via a short direct DB connection after validating active recovery binding, without loading schema-bootstrap code; it fails visibly if settings cannot be read.
