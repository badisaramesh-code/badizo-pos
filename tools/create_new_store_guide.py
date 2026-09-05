from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether

OUT = Path(__file__).resolve().parents[1] / "output" / "pdf" / "BADIZO_NEW_STORE_INSTALLATION_GUIDE_TELUGU.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Title2", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=24, leading=29, textColor=colors.HexColor("#17324d"), alignment=TA_CENTER, spaceAfter=14))
styles.add(ParagraphStyle(name="Sub", parent=styles["Normal"], fontSize=11, leading=16, textColor=colors.HexColor("#38536d"), alignment=TA_CENTER, spaceAfter=12))
styles.add(ParagraphStyle(name="H1x", parent=styles["Heading1"], fontSize=17, leading=21, textColor=colors.HexColor("#0b6b53"), spaceBefore=5, spaceAfter=9))
styles.add(ParagraphStyle(name="H2x", parent=styles["Heading2"], fontSize=12.5, leading=16, textColor=colors.HexColor("#17324d"), spaceBefore=8, spaceAfter=5))
styles.add(ParagraphStyle(name="Bodyx", parent=styles["BodyText"], fontSize=9.6, leading=14, spaceAfter=5))
styles.add(ParagraphStyle(name="Smallx", parent=styles["BodyText"], fontSize=8.2, leading=11, textColor=colors.HexColor("#4e5f6d")))
styles.add(ParagraphStyle(name="Warn", parent=styles["BodyText"], fontSize=9.5, leading=14, backColor=colors.HexColor("#fff4d6"), borderColor=colors.HexColor("#e5a92d"), borderWidth=0.7, borderPadding=7, spaceBefore=5, spaceAfter=8))
styles.add(ParagraphStyle(name="Ok", parent=styles["BodyText"], fontSize=9.5, leading=14, backColor=colors.HexColor("#e8f7ef"), borderColor=colors.HexColor("#2f9a6d"), borderWidth=0.7, borderPadding=7, spaceBefore=5, spaceAfter=8))

def p(text, style="Bodyx"):
    return Paragraph(text, styles[style])

def bullets(items):
    out = []
    for item in items:
        out.append(Paragraph(f"- {item}", styles["Bodyx"]))
    return out

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d7e0e8"))
    canvas.line(18*mm, 15*mm, 192*mm, 15*mm)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#607080"))
    canvas.drawString(18*mm, 10*mm, "Badizo POS - New Store One Click Deployment")
    canvas.drawRightString(192*mm, 10*mm, f"Page {doc.page}")
    canvas.restoreState()

story = [
    Spacer(1, 25*mm),
    p("BADIZO POS", "Title2"),
    p("New Store One-Click Installation Guide", "Title2"),
    p("Server 192.168.1.10 | Any client IP | LAN-only operation | Internet optional", "Sub"),
    Spacer(1, 8*mm),
    p("<b>Simple Telugu note (English letters):</b> Ee guide ni order lo follow avvandi. Server mundu install cheyyali; taruvata prathi client lo same BAT run chesi role select cheyyali.", "Ok"),
    p("<b>Package folder:</b> Badizo new store onle click<br/><b>Main file:</b> RUN_BADIZO_NEW_STORE_INSTALL.bat<br/><b>Normal daily use:</b> Desktop meeda B logo unna Badizo shortcut matrame open cheyyandi.", "Warn"),
    Spacer(1, 8*mm),
    p("Prepared for the complete Badizo workflow: products and inventory, inward/purchase, sales, ledgers and posting, counter closing/cash balance, financial-year reports, thermal and A4 printing, A4 PDF, barcode labels, local backup and optional Google Drive backup.", "Bodyx"),
    PageBreak(),
    p("1. What is included", "H1x"),
    *bullets([
        "<b>Offline package:</b> app, backend dependencies, frontend build, bundled Node runtime and Badizo Windows installer.",
        "<b>One BAT for all computers:</b> choose Server, Counter, Admin or Security.",
        "<b>Server:</b> fixed address 192.168.1.10, port 5000, Windows firewall rule, automatic startup task.",
        "<b>Clients:</b> connect to 192.168.1.10 first; hostname and automatic LAN scan are fallback options.",
        "<b>Desktop:</b> official B-logo Badizo application shortcut. Browser is only for health checking.",
        "<b>Printing:</b> barcode PRN/thermal/A4/A4 PDF features already included in Badizo.",
        "<b>Backup:</b> local SQL backup daily at 22:30; Google Drive setup is optional and retries after internet returns.",
        "<b>Integrity:</b> SHA-256 checksum manifest is included."
    ]),
    p("Important limitation", "H2x"),
    p("Badizo works without internet because server and clients communicate over the local LAN. The server PC, switch/router and LAN cables must still be powered and connected. Google Drive upload waits while internet is unavailable; local backup continues.", "Warn"),
    p("2. Before installation", "H1x"),
    *bullets([
        "Use Windows 10/11 64-bit PCs. Connect every system to the same router/switch using LAN where possible.",
        "Reserve 192.168.1.10 for the server in the router DHCP reservation table. Confirm no other device uses it.",
        "Server must have MySQL Server 8.x and client tools (mysql.exe and mysqldump.exe).",
        "Keep the complete package folder together. Do not run a BAT from inside the ZIP.",
        "Know the MySQL username and password. Default database created is badizo_pos.",
        "Connect and test thermal/barcode/A4 printers in Windows before selecting them in Badizo."
    ]),
    PageBreak(),
    p("3. Server PC - one click", "H1x"),
    p("<b>Order:</b> First install the server. Do not install clients before the server health check passes.", "Ok"),
    *bullets([
        "Copy the full <b>Badizo new store onle click</b> folder to the server.",
        "Right-click or double-click <b>RUN_BADIZO_NEW_STORE_INSTALL.bat</b>.",
        "Choose <b>1 - SERVER PC</b>. Approve the Windows Administrator prompt.",
        "Enter MySQL user (press Enter for root), then enter the MySQL password.",
        "Installer creates/uses C:\BadizoPOS, database badizo_pos, fixed server IP 192.168.1.10, firewall ports and startup task.",
        "Wait for <b>BADIZO SERVER INSTALLATION SUCCESSFUL</b>.",
        "The Badizo desktop application is installed and its official B shortcut is created. Open that shortcut for daily use.",
        "Restart the server once. Open Badizo and log in. Confirm dashboard loads."
    ]),
    p("Server verification", "H2x"),
    *bullets([
        "Run <b>CHECK_BADIZO_LAN.bat</b>; port 5000 and API health must show PASS.",
        "Optional browser-only check: http://192.168.1.10:5000/api/health",
        "Windows Task Scheduler must contain <b>Badizo POS Backend</b>.",
        "Local backups are stored in D:\BadizoPOSBackups when D: exists, otherwise C:\BadizoPOSBackups."
    ]),
    p("Do not continue if 192.168.1.10 is already used by another device. Fix the IP conflict or router reservation first.", "Warn"),
    p("4. Client PCs - Counter/Admin/Security", "H1x"),
    *bullets([
        "Copy the same complete package folder to the client PC.",
        "Run <b>RUN_BADIZO_NEW_STORE_INSTALL.bat</b>.",
        "Choose 2 Counter, 3 Admin, or 4 Security.",
        "The installer checks 192.168.1.10, installs Badizo, writes the role-specific connection config, repairs the B icon and opens the app.",
        "Repeat on every client. Client computers may keep DHCP and may have any free IP in the same LAN.",
        "For daily use, open only the B-logo <b>Badizo</b> desktop shortcut."
    ]),
    PageBreak(),
    p("5. Printer setup", "H1x"),
    p("Barcode label printer", "H2x"),
    *bullets([
        "Install the exact Windows printer driver and print a Windows test page.",
        "Share the printer with a short name. Confirm the share is reachable from the computer that sends PRN data.",
        "In Badizo: System > Barcode Sticker Printers. Select the correct template/printer share.",
        "Print one test label. Verify size, gap, darkness, product name, Code128 and price before bulk printing.",
        "Do not use A4 or thermal printer drivers for raw barcode PRN jobs."
    ]),
    p("Thermal receipt printer", "H2x"),
    *bullets([
        "Install the printer in Windows; set paper width (typically 58/80 mm) and print a test page.",
        "In Badizo System, verify default print mode, receipt width and feed margin.",
        "Use the Badizo desktop app for normal printing. Run a one-item test bill before opening the counter."
    ]),
    p("A4 print and A4 PDF", "H2x"),
    *bullets([
        "Install the A4 printer and test it in Windows.",
        "Use A4 Print inside Badizo for paper output.",
        "Use A4 PDF inside the desktop app. Files are saved under Desktop > Badizo A4 Bills.",
        "Open one generated PDF and check invoice number, customer, GST, totals and page boundaries."
    ]),
    p("6. Business workflow acceptance test", "H1x"),
]
data = [
    [p("<b>Area</b>","Smallx"), p("<b>Test</b>","Smallx")],
    [p("Products/Inventory","Smallx"), p("Create one test product, inward stock, edit prices, scan in Sale and verify stock reduction.","Smallx")],
    [p("Sales","Smallx"), p("Complete cash and digital bills; test hold/restore, reprint, exchange and customer lookup.","Smallx")],
    [p("Books/Ledgers","Smallx"), p("Post purchase/payment voucher; verify day book, supplier/customer ledger and balances.","Smallx")],
    [p("Counter closing","Smallx"), p("Enter denomination/cash closing; verify expected cash, handover sheet and cash balance.","Smallx")],
    [p("Reports/FY","Smallx"), p("Select correct financial year and verify sales, GST, stock, HSN, top products and closing reports.","Smallx")],
    [p("Printing","Smallx"), p("Print one barcode, one thermal bill, one A4 bill and save one A4 PDF.","Smallx")],
]
tbl = Table(data, colWidths=[38*mm, 132*mm], repeatRows=1)
tbl.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),colors.HexColor("#dcebe6")),("GRID",(0,0),(-1,-1),0.5,colors.HexColor("#a9bac6")),("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),6),("RIGHTPADDING",(0,0),(-1,-1),6),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
story.append(tbl)
story.extend([
    PageBreak(),
    p("7. Offline LAN test", "H1x"),
    *bullets([
        "Keep server, router/switch and clients ON. Disconnect only the internet/WAN cable.",
        "Open Badizo from two client PCs. Login, product search and billing must continue.",
        "Create a small test bill on one counter and verify it appears in server reports.",
        "Reconnect internet. Google Drive pending backups should retry automatically.",
        "If clients fail while internet is off, they are not on the same local LAN or the server/firewall/IP has a problem."
    ]),
    p("8. Local and Google Drive backup", "H1x"),
    p("Local backup is enabled by the server installer at 22:30 daily. Keep the server powered at that time. Also run a manual backup from Badizo System after first installation and verify a non-empty .sql file exists.", "Ok"),
    p("Google Drive one-time setup", "H2x"),
    *bullets([
        "In Google Cloud Console create/select a project, enable Google Drive API and configure the OAuth consent screen.",
        "Create an OAuth Client ID of type Desktop app. Copy Client ID and Client Secret.",
        "Create a Google Drive folder for Badizo backups. Copy the folder ID from its URL.",
        "On the server run <b>CONFIGURE_GOOGLE_DRIVE_BACKUP.bat</b>, approve UAC and enter those three values.",
        "A browser authorization page opens. Login to the correct Google account and approve access.",
        "Run a manual backup in Badizo. Confirm local file, Drive upload and the in-app success/pending popup.",
        "When internet is absent, local POS and local backup continue; Drive upload retries every 10 minutes."
    ]),
    p("OAuth credentials are shop-specific and cannot be safely pre-filled in a universal package. Never share Client Secret, refresh token, database password or the installed backend .env file.", "Warn"),
    PageBreak(),
    p("9. Troubleshooting", "H1x"),
    *bullets([
        "<b>Client cannot connect:</b> run CHECK_BADIZO_LAN.bat; check server power, LAN cable, 192.168.1.10 conflict, Private network profile and firewall port 5000.",
        "<b>Badizo opens in browser:</b> close it and use the B-logo desktop app. Browser is for health checking only.",
        "<b>Generic shortcut icon:</b> rerun the client role installation; it repairs the official B icon.",
        "<b>Barcode does not print:</b> verify Windows share name, exact PRN template, printer DPI/label size and raw print access.",
        "<b>Thermal/A4 wrong printer:</b> verify Windows driver/default/selected printer and Badizo print mode.",
        "<b>A4 PDF not found:</b> check Desktop > Badizo A4 Bills and use the desktop app.",
        "<b>Backup fails:</b> verify mysql.exe/mysqldump.exe, backup directory permission, MySQL password and server logs.",
        "<b>Google popup pending:</b> local backup is safe; check internet, OAuth authorization and Drive folder ID."
    ]),
    p("10. Final handover checklist", "H1x"),
    *bullets([
        "[ ] Router reserves 192.168.1.10 for the server; no IP conflict.",
        "[ ] Server restarts automatically and Badizo health check passes.",
        "[ ] Every PC has the official B-logo Badizo desktop shortcut.",
        "[ ] Counter/Admin/Security logins show only the intended role access.",
        "[ ] Product, inward, sale, stock, ledgers, posting, counter closing and financial-year reports verified.",
        "[ ] Barcode, thermal, A4 and A4 PDF outputs physically checked.",
        "[ ] Internet disconnected test passed on at least two clients.",
        "[ ] Manual local backup restored/tested on a safe test database or verified as non-empty.",
        "[ ] Google Drive backup and popup verified when credentials are configured.",
        "[ ] Package and PDF kept safely; MySQL and Google credentials stored separately."
    ]),
    p("Recommended additions already covered", "H2x"),
    p("Router IP reservation, startup after reboot, firewall rules, role-specific clients, B-icon repair, LAN discovery, IP-conflict check, checksums, offline test, backup retry, printer acceptance tests and final handover checklist are included so the installation is repeatable and supportable.", "Ok"),
])

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=20*mm, title="Badizo New Store Installation Guide", author="Badizo")
doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
print(OUT)
