from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "BADIZO_NEW_STORE_INSTALL_GUIDE_TELUGU_ENGLISH.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

font_candidates = [
    ("Nirmala", Path("C:/Windows/Fonts/Nirmala.ttf")),
    ("Nirmala", Path("C:/Windows/Fonts/NirmalaB.ttf")),
]
regular = Path("C:/Windows/Fonts/Nirmala.ttc")
bold = Path("C:/Windows/Fonts/Nirmala.ttc")
if not regular.exists():
    raise FileNotFoundError("Nirmala UI font is required for Telugu text")
pdfmetrics.registerFont(TTFont("Nirmala", str(regular), subfontIndex=0))
pdfmetrics.registerFont(TTFont("Nirmala-Bold", str(bold), subfontIndex=1))

PAGE_W, PAGE_H = A4
NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#1D6FA5")
CYAN = colors.HexColor("#E9F5FB")
GREEN = colors.HexColor("#16825D")
AMBER = colors.HexColor("#FFF3D6")
RED = colors.HexColor("#B42318")
LIGHT = colors.HexColor("#F5F7FA")
INK = colors.HexColor("#182230")
MUTED = colors.HexColor("#52606D")

styles = getSampleStyleSheet()
title = ParagraphStyle("TitleX", fontName="Nirmala-Bold", fontSize=25, leading=31, textColor=colors.white, alignment=TA_CENTER, spaceAfter=8)
subtitle = ParagraphStyle("SubtitleX", fontName="Nirmala", fontSize=12.5, leading=19, textColor=colors.HexColor("#DCEEFF"), alignment=TA_CENTER)
h1 = ParagraphStyle("H1X", fontName="Nirmala-Bold", fontSize=18, leading=24, textColor=NAVY, spaceBefore=4, spaceAfter=9)
h2 = ParagraphStyle("H2X", fontName="Nirmala-Bold", fontSize=13, leading=18, textColor=BLUE, spaceBefore=8, spaceAfter=5)
body = ParagraphStyle("BodyX", fontName="Nirmala", fontSize=9.6, leading=15, textColor=INK, spaceAfter=5)
small = ParagraphStyle("SmallX", fontName="Nirmala", fontSize=8.2, leading=12, textColor=MUTED)
bullet = ParagraphStyle("BulletX", parent=body, leftIndent=12, firstLineIndent=-7, bulletIndent=2, spaceAfter=3)
code = ParagraphStyle("CodeX", fontName="Courier", fontSize=8.4, leading=12, textColor=colors.HexColor("#102A43"), backColor=colors.HexColor("#EDF2F7"), borderPadding=7, spaceBefore=3, spaceAfter=7)
callout = ParagraphStyle("CalloutX", parent=body, backColor=AMBER, borderColor=colors.HexColor("#F0B429"), borderWidth=0.7, borderPadding=8, spaceBefore=4, spaceAfter=8)
ok = ParagraphStyle("OkX", parent=body, backColor=colors.HexColor("#E8F7F0"), borderColor=GREEN, borderWidth=0.7, borderPadding=8, spaceBefore=4, spaceAfter=8)


def p(text, style=body):
    return Paragraph(text, style)


def bullets(items):
    return [p("• " + item, bullet) for item in items]


def section(en, te):
    return [p(en, h1), p(te, h2)]


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D7DEE7"))
    canvas.line(18 * mm, 14 * mm, PAGE_W - 18 * mm, 14 * mm)
    canvas.setFont("Nirmala", 7.8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 9 * mm, "Badizo POS - New Store Installation Guide")
    canvas.drawRightString(PAGE_W - 18 * mm, 9 * mm, f"Page {doc.page}")
    canvas.restoreState()


doc = BaseDocTemplate(str(OUT), pagesize=A4, rightMargin=18*mm, leftMargin=18*mm, topMargin=18*mm, bottomMargin=19*mm,
                      title="Badizo POS New Store Installation Guide - Telugu and English", author="Badizo")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=footer)])
story = []

# Cover
cover = Table([[p("BADIZO POS", title)], [p("NEW STORE OFFLINE INSTALLATION", title)],
               [p("కొత్త స్టోర్ ఆఫ్‌లైన్ ఇన్‌స్టాలేషన్", title)],
               [p("English + తెలుగు | Server, Admin, Counter and Security PCs", subtitle)]],
              colWidths=[doc.width], rowHeights=[24*mm, 19*mm, 19*mm, 19*mm])
cover.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,-1), NAVY), ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
                           ("BOX", (0,0), (-1,-1), 0.8, NAVY), ("TOPPADDING", (0,0), (-1,-1), 4)]))
story += [Spacer(1, 24*mm), cover, Spacer(1, 16*mm),
          p("ONE PACKAGE - ONE BAT FILE - ALL CURRENT FEATURES", ParagraphStyle("tag", parent=h1, alignment=TA_CENTER, textColor=GREEN)),
          Spacer(1, 4*mm),
          p("Package entry file / ప్రధాన ఫైల్", h2),
          p("RUN_BADIZO_NEW_STORE_INSTALL.bat", code),
          p("Prepared from the current Badizo POS source and production builds. The package includes the backend, production frontend, desktop app installer, offline Node runtime, role setup, LAN check, Google Drive backup setup helper, and SHA-256 checksums.", body),
          p("ప్రస్తుత Badizo POS code ఆధారంగా backend, frontend production build, desktop installer, offline Node runtime, Server/Admin/Counter/Security role setup, LAN check, Google Drive backup helper మరియు checksums ఈ package లో ఉన్నాయి.", body),
          p("Important / ముఖ్యమైనది: Install on the SERVER PC first. MySQL Server 8.x must already be installed and configured.", callout),
          PageBreak()]

story += section("1. What is included", "1. ఈ package లో ఏమి ఉన్నాయి")
data = [
    [p("Item", h2), p("Purpose / ఉపయోగం", h2)],
    [p("RUN_BADIZO_NEW_STORE_INSTALL.bat"), p("Main menu for Server, Counter, Admin and Security installation / అన్ని systems కోసం ప్రధాన installer")],
    [p("payload/app/backend"), p("API, authentication, billing, inventory, reports, books, backups and database auto-migrations")],
    [p("payload/app/frontend/build"), p("Production user interface served by the backend")],
    [p("payload/Badizo Setup 1.0.0.exe"), p("Windows desktop application with Badizo B shortcut")],
    [p("CHECK_BADIZO_LAN.bat"), p("Checks server reachability and ports")],
    [p("CONFIGURE_GOOGLE_DRIVE_BACKUP.bat"), p("Optional Google Drive backup configuration")],
    [p("FILE_CHECKSUMS_SHA256.csv"), p("Package integrity verification")],
]
t = Table(data, colWidths=[62*mm, doc.width-62*mm], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,0), CYAN), ("GRID", (0,0), (-1,-1), .35, colors.HexColor("#CBD5E1")),
                       ("VALIGN", (0,0), (-1,-1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 6), ("RIGHTPADDING", (0,0), (-1,-1), 6),
                       ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5)]))
story += [t, Spacer(1, 5*mm)]
story += section("2. Hardware and prerequisites", "2. అవసరమైన hardware మరియు prerequisites")
story += bullets([
    "Server PC: Windows 10/11 64-bit, 8 GB RAM minimum (16 GB recommended), SSD and wired LAN.",
    "MySQL Server 8.x installed as a Windows service. Keep the MySQL username and password ready.",
    "Router/LAN range must support fixed IP 192.168.1.10. Make sure no other device is using this IP.",
    "Counter/Admin/Security PCs: Windows 10/11 64-bit and wired LAN to the same router.",
    "Printer drivers must be installed separately: 80mm thermal/A4 printer and TSC-244 Pro when used.",
    "సర్వర్‌కు LAN cable, SSD, MySQL 8, username/password అవసరం. 192.168.1.10 IP ఇంకొక device వాడకూడదు.",
])
story += [p("Before starting, take a backup if this PC has any old Badizo database. New-store setup creates/uses database badizo_pos.", callout), PageBreak()]

story += section("3. Server PC installation - first", "3. Server PC installation - ముందుగా ఇదే చేయాలి")
steps = [
    ("1", "Copy the complete folder", "మొత్తం package folder ని Server Desktop కు copy చేయండి."),
    ("2", "Install MySQL Server 8.x", "MySQL Windows service Automatic/Running లో ఉండాలి. Username/password గుర్తుంచుకోండి."),
    ("3", "Run the BAT as Administrator", "RUN_BADIZO_NEW_STORE_INSTALL.bat పై right-click చేసి Run as administrator ఎంచుకోండి."),
    ("4", "Choose 1 - SERVER PC", "Menu లో 1 ఎంచుకోండి. UAC వస్తే Yes నొక్కండి."),
    ("5", "Enter MySQL credentials", "MySQL user blank అయితే root తీసుకుంటుంది. Password తప్పకుండా ఇవ్వండి."),
    ("6", "Wait for SUCCESS", "Files C:\\BadizoPOS కి copy అవుతాయి; DB tables auto-create అవుతాయి; startup task మరియు firewall rules add అవుతాయి."),
]
rows = [[p("Step", h2), p("English", h2), p("తెలుగు", h2)]] + [[p(n, h2), p(en), p(te)] for n,en,te in steps]
t=Table(rows, colWidths=[14*mm, 70*mm, doc.width-84*mm], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,0), CYAN), ("GRID", (0,0), (-1,-1), .35, colors.HexColor("#CBD5E1")),
                       ("VALIGN", (0,0), (-1,-1), "TOP"), ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5)]))
story += [t, Spacer(1, 4*mm), p("Expected server addresses / సర్వర్ URLs", h2),
          p("App: http://192.168.1.10:5000<br/>Health: http://192.168.1.10:5000/api/health<br/>Legacy redirect: http://192.168.1.10:3000", code),
          p("The installer changes the active LAN adapter to fixed IP 192.168.1.10. Reserve this address in the router and avoid IP conflicts.", callout),
          p("Success checks: Badizo desktop shortcut opens, login screen appears, health URL returns success, and Windows Task Scheduler contains 'Badizo POS Backend'.", ok),
          PageBreak()]

story += section("4. Counter, Admin and Security PCs", "4. Counter, Admin మరియు Security PCs")
story += [p("Run the same main BAT on each client PC. The server must already be running and reachable at 192.168.1.10.", body),
          p("ప్రతి client PC లో ఇదే main BAT run చేయండి. ముందుగా Server PC ON లో ఉండి 192.168.1.10 address reachable గా ఉండాలి.", body)]
client_data = [
    [p("Menu", h2), p("PC role", h2), p("Access / ఉపయోగం", h2)],
    [p("2"), p("COUNTER"), p("Billing and counter closing. Each counter user is selected at login.")],
    [p("3"), p("ADMIN"), p("Products, inward, barcode, reports, books, staff, system and billing.")],
    [p("4"), p("SECURITY"), p("Gate Pass workflow and permitted security functions.")],
]
t=Table(client_data, colWidths=[18*mm, 36*mm, doc.width-54*mm], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,0), CYAN), ("GRID", (0,0), (-1,-1), .35, colors.HexColor("#CBD5E1")),
                       ("VALIGN", (0,0), (-1,-1), "TOP"), ("TOPPADDING", (0,0), (-1,-1), 6), ("BOTTOMPADDING", (0,0), (-1,-1), 6)]))
story += [t, Spacer(1, 4*mm)]
story += bullets([
    "Double-click RUN_BADIZO_NEW_STORE_INSTALL.bat and choose the correct role.",
    "The installer tests ports 5000/3000, installs Badizo Setup, writes the server config, creates the B desktop shortcut and opens the app.",
    "If Windows SmartScreen appears, select More info and Run anyway only when this package came from the trusted Badizo server/developer copy.",
    "Desktop shortcut తెరచి login చేయండి. Server unavailable అయితే మొదట CHECK_BADIZO_LAN.bat run చేయండి.",
])
story += [p("Do not copy only the BAT file. Copy the complete folder with payload; otherwise installation will fail.", callout), PageBreak()]

story += section("5. Features included in this build", "5. ఈ build లో ఉన్న ప్రధాన features")
features = [
    ("Billing POS", "Barcode/name search, retail/wholesale, GST/IGST, Cash/UPI/Card/Mixed, hold/resume, reprint, quotation, sales return, free offers and quantity pricing."),
    ("Products & Inventory", "Product master, Code128 barcode, HSN/GST slabs, units/pack measure, batch/expiry, stock alerts, CSV/Excel import-export, mass price update and import history."),
    ("Inward & Suppliers", "Purchase inward, supplier master, purchase orders, batch stock, discounts, tax, supplier payments and financial-year numbering."),
    ("Barcode", "Sticker preview/print logs and TSC-244 Pro 33x25 template workflow."),
    ("Counters", "Counter-wise invoice sequence, closing, handover denominations, cash ledger and role-based access."),
    ("Reports", "Daily/monthly/counter sales, GST/GSTR-1/HSN/tax, stock, product performance, debtors/creditors and export/print workflows."),
    ("Books & Accounts", "Day book, ledger, cash/bank, purchase/sales, P&L, balance sheet, vouchers and Local/Non-Local accounts."),
    ("Operations", "Gate Pass, special orders, customers/loyalty, staff attendance/payroll, audit/session tracking and shop settings."),
    ("Protection", "Daily local SQL backup, backup health alerts, optional Google Drive backup, checksum manifest, startup recovery and LAN diagnostics."),
]
for name, desc in features:
    story.append(KeepTogether([p(name, h2), p(desc, body)]))
story += [p("తెలుగు సారాంశం: Billing, products/stock, inward/suppliers, barcode, counter closing, reports, ledger books, local/non-local accounts, staff payroll, gate pass, users/settings మరియు backup modules అన్నీ package లో ఉన్నాయి.", ok), PageBreak()]

story += section("6. First login and shop configuration", "6. మొదటి login మరియు shop settings")
story += bullets([
    "Open the Badizo B desktop shortcut on the server and log in with the configured Server/Admin user.",
    "In System, verify shop name, address, GSTIN, phone, invoice prefix, financial year and GST slabs.",
    "Create/verify users for Server, Admin, each Counter and Security; keep passwords private.",
    "Add/import products, verify MRP/sale price/GST/stock and print one barcode test.",
    "Configure receipt mode and test one thermal/A4 bill without using live stock if possible.",
    "Set printer preferences on each PC. Printer drivers are Windows-side prerequisites.",
    "System settings లో shop details, GSTIN, invoice prefix, financial year, users, products, printer అన్నీ verify చేసిన తర్వాతే live billing ప్రారంభించండి.",
])
story += [p("Never start live billing until invoice numbering, GST calculation, stock deduction, receipt print, counter closing and backup restore are tested.", callout)]
story += section("7. Backup and daily operation", "7. Backup మరియు రోజువారీ ఉపయోగం")
story += bullets([
    "Automatic local backup time: 22:30. Default folder is D:\\BadizoPOSBackups when D: exists, otherwise C:\\BadizoPOSBackups.",
    "Use System > Backup Now before major product imports, upgrades or financial-year changes.",
    "Optionally run CONFIGURE_GOOGLE_DRIVE_BACKUP.bat on the server. Complete the browser authorization using the intended shop Google account.",
    "Keep at least one separate external/cloud copy. A backup is trusted only after a restore test.",
    "Daily: start Server first, confirm app/health, then open counters. At closing, verify counter closing and backup status.",
])
story += [PageBreak()]

story += section("8. Troubleshooting", "8. సమస్యలు వస్తే")
trouble = [
    ("BAT says payload missing", "The folder is incomplete. Copy/extract the entire package again."),
    ("MySQL not found", "Install/configure MySQL Server 8.x and ensure the MySQL Windows service exists."),
    ("MySQL login failed", "Re-run and enter the correct MySQL username/password."),
    ("192.168.1.10 conflict", "Disconnect/renumber the conflicting device, reserve the server IP in the router, then re-run."),
    ("Client cannot connect", "Run CHECK_BADIZO_LAN.bat; confirm server is ON, same LAN, Private network profile, ports 5000/3000 allowed."),
    ("Desktop shortcut wrong", "Re-run the client option from the complete package; it rewrites the role/server configuration."),
    ("Server does not become healthy", "Check C:\\BadizoPOS\\backend\\logs\\server.err.log and confirm MySQL service/database credentials."),
    ("Print problem", "Verify Windows printer driver, default printer, paper size and test print before changing Badizo settings."),
]
rows=[[p("Problem / సమస్య", h2), p("Action / పరిష్కారం", h2)]]+[[p(a),p(b)] for a,b in trouble]
t=Table(rows,colWidths=[58*mm,doc.width-58*mm],repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),CYAN),("GRID",(0,0),(-1,-1),.35,colors.HexColor("#CBD5E1")),
                       ("VALIGN",(0,0),(-1,-1),"TOP"),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
story += [t, Spacer(1,5*mm), p("Support information to send: PC role, screenshot, exact error text, server IP, time of error, and the relevant log file. Never send the MySQL password in screenshots or chat.", callout)]
story += section("9. Final go-live checklist", "9. Live billing ముందు final checklist")
checks = [
    "[ ] Server fixed IP 192.168.1.10 reserved and no conflict",
    "[ ] Health URL and Badizo desktop app work on Server/Admin/Counter/Security PCs",
    "[ ] Correct role and counter login tested",
    "[ ] Shop/GST/financial-year/invoice settings verified",
    "[ ] Product import, barcode search and stock tested",
    "[ ] Cash/UPI/Card/Mixed payment and GST bill totals verified",
    "[ ] Thermal/A4 receipt and barcode label test printed",
    "[ ] Hold/resume, reprint, return, counter closing and reports tested",
    "[ ] Local backup created and restore test completed",
    "[ ] Package checksum file retained with the installer copy",
]
story += bullets(checks)
story += [p("Installation is complete only after every applicable checklist item passes. / వర్తించే ప్రతి checklist item success అయిన తర్వాతే installation complete గా పరిగణించండి.", ok)]

doc.build(story)
print(OUT)

