from pathlib import Path
p=Path(r'D:\badizo-pos-main\scripts\new-store-20260920\write-report.cjs')
t=p.read_text(encoding='utf8')
t=t.replace('13 pages, shaped Telugu text','14 pages, shaped Telugu text')
t=t.replace('New-store backend enables the local daily-backup scheduler; configured at 22:30. It requires an awake, running server. Actual future timer execution is not claimed as tested.','Windows task runs full local SQL + barcode templates/output PRN + thermal ZIP backup daily at 09:00, plus startup catch-up, duplicate suppression and failure retries. Backend timer is disabled to avoid two schedules. Actual future trigger/wake execution on a new PC remains a site acceptance check.')
t=t.replace('No fixed store IP is imposed.','Server adapter is configured to 192.168.1.10/24. Clients have no per-IP allowlist and need reachable LAN connectivity; another subnet requires routing.')
t=t.replace('All role launchers use explicit server selection and checksum verification.','All role launchers use fixed 192.168.1.10 and checksum verification. Stale cache/common-name discovery is suppressed when discovery is disabled; a focused VM regression test passed. Windows UTF-8 BOM configuration is accepted.')
t=t.replace("'## Scope and remaining acceptance'", """'## Requested LAN / Excel / PRN changes','',
'- Included a blank 21-column NEW_SKU_UPLOAD.xlsx, with text code/barcode/HSN columns, unit validation and Telugu-English Guide sheet. Imported two isolated test SKUs through the actual frontend converter and backend API; leading zeros, price and stock were verified.',
'- Tested full backup ZIP contents, same-day duplicate suppression and failure handling on an isolated root/database. Error exit and preservation of the last successful archive marker passed.',
'- New-store application time setting is 09:00. Scheduled backup uses server Windows local time. If the PC is off, backup occurs after next startup; wake support is OS/hardware dependent.',
'- No external font/CDN references found in frontend source/public assets. Required application runtimes are bundled; printer drivers must be supplied for the actual models. Online integrations are not part of offline operation.','',
'## Scope and remaining acceptance'""")
t=t.replace('target reboot recovery; real LAN clients;','target reboot recovery; physical static-IP change/conflict detection; actual 09:00 Windows trigger/wake; real LAN clients;')
p.write_text(t,encoding='utf8')
