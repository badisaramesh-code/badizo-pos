# Badizo POS Thermal Receipt Printer Setup Guide

This guide is for setting up the thermal receipt printer on another Windows machine.

## 1. Important Difference From Barcode Sticker Printing

Thermal receipt printing in browser mode is not raw PRN printing.

Current browser mode uses:

```text
window.print()
```

That means Chrome/Edge and Windows decide which printer receives the bill.

The POS controls:

- receipt width
- receipt content layout
- feed/cut margin
- thermal/A4 mode

But in browser mode, the POS cannot reliably force a specific printer without the print dialog/default printer.

In future Electron mode, the app can directly select a printer by name.

## 2. Current Working Thermal Printer Example

On this server PC the thermal receipt printer is:

```text
EPSON TM-T82X-II Receipt
```

Driver:

```text
EPSON TM-T(203dpi) Receipt6
```

Port:

```text
TMUSB001
```

Check installed printers:

```powershell
Get-Printer | Select-Object Name,Shared,ShareName,DriverName,PortName,PrinterStatus,Default | Format-Table -AutoSize
```

Expected example:

```text
Name                     DriverName                  PortName  PrinterStatus
----                     ----------                  --------  -------------
EPSON TM-T82X-II Receipt EPSON TM-T(203dpi) Receipt6 TMUSB001  Normal
```

## 3. Install Thermal Printer Driver

Install the correct Epson thermal printer driver for your printer model.

For Epson TM-T82 / TM-T82X:

1. Connect printer by USB.
2. Install Epson Advanced Printer Driver.
3. Restart Windows if driver setup asks.
4. Confirm printer appears in:

```text
Control Panel > Devices and Printers
```

Then run:

```powershell
Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Default | Format-Table -AutoSize
```

## 4. Set Thermal Printer As Default

Because browser mode uses Windows/browser print handling, set the thermal printer as default.

Windows UI:

```text
Settings > Bluetooth & devices > Printers & scanners
```

Open:

```text
EPSON TM-T82X-II Receipt
```

Click:

```text
Set as default
```

PowerShell command:

```powershell
(New-Object -ComObject WScript.Network).SetDefaultPrinter("EPSON TM-T82X-II Receipt")
```

Verify:

```powershell
Get-Printer | Select-Object Name,Default,PrinterStatus | Format-Table -AutoSize
```

## 5. Configure Paper Size In Windows

Open:

```text
Control Panel > Devices and Printers
```

Right-click:

```text
EPSON TM-T82X-II Receipt
```

Open:

```text
Printer properties > Preferences
```

Recommended:

- Paper width: `80 mm`
- Paper type: receipt / roll paper
- Cut: enabled if printer has auto-cutter
- Feed: small / minimal

If receipt appears compressed, check that the Windows driver is not using 58 mm paper.

## 6. Configure In Badizo POS

Open:

```text
System > Open Setup Folder
```

Set:

```text
Default Print = Thermal receipt
Thermal Width = 80 mm
Thermal Feed Margin = 18
```

Click:

```text
Save Settings
```

Available thermal widths in POS:

```text
58, 60, 72, 76, 80, 82, 85, 90 mm
```

For your current receipt printer, use:

```text
80 mm
```

If extra blank paper comes after print, reduce:

```text
Thermal Feed Margin
```

Try:

```text
8 to 12
```

If print is cutting too close, increase it:

```text
18 to 25
```

## 7. Browser Print Settings

When Chrome/Edge print dialog opens:

Select printer:

```text
EPSON TM-T82X-II Receipt
```

Recommended settings:

```text
Layout: Portrait
Paper size: 80 mm receipt / roll paper
Margins: None
Scale: 100
Headers and footers: Off
Background graphics: On
```

If the browser keeps selecting HP or PDF:

1. Set Epson as Windows default.
2. In print dialog, manually select Epson once.
3. Print one test bill.
4. Browser usually remembers last selected printer.

## 8. Common Issues And Fixes

### Issue: Bill Goes To HP Printer Instead Of Epson

Reason:

Browser print selected HP or Windows default is HP.

Fix:

Set Epson as default:

```powershell
(New-Object -ComObject WScript.Network).SetDefaultPrinter("EPSON TM-T82X-II Receipt")
```

Then verify:

```powershell
Get-Printer | Select-Object Name,Default | Format-Table -AutoSize
```

### Issue: Receipt Looks Compressed

Reason:

POS or Windows driver is using wrong paper width.

Fix in POS:

```text
System > Thermal Width > 80 mm
```

Fix in Windows printer preferences:

```text
Paper width = 80 mm
Scale = 100%
Margins = None
```

### Issue: Printer Wastes Too Much Blank Paper

Reason:

Receipt height/feed margin is too large or printer driver feed setting is high.

Fix in POS:

```text
Thermal Feed Margin = 8 to 12
```

Fix in Windows driver:

```text
Reduce feed / paper cut feed
```

### Issue: Nothing Prints But Browser Says Printed

Check queue:

```powershell
Get-PrintJob -PrinterName "EPSON TM-T82X-II Receipt" -ErrorAction SilentlyContinue | Select-Object ID,Name,JobStatus,SubmittedTime,Size,TotalPages | Format-Table -AutoSize
```

Check status:

```powershell
Get-Printer -Name "EPSON TM-T82X-II Receipt" | Select-Object Name,PrinterStatus,DetectedErrorState,ExtendedPrinterStatus,WorkOffline,PortName | Format-List
```

## 9. Backend Restart Commands

If settings are changed in code or backend is restarted:

Find backend PID:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Select-Object ProcessId,CommandLine
```

Stop backend:

```powershell
Stop-Process -Id BACKEND_PID -Force
```

Start backend:

```powershell
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'D:\badizo-pos-main\backend' -WindowStyle Hidden
```

Verify backend:

```powershell
Test-NetConnection -ComputerName localhost -Port 5000 | Select-Object ComputerName,RemotePort,TcpTestSucceeded
```

## 10. Final Thermal Test

1. Set Epson thermal printer as Windows default.
2. Open Badizo POS in browser.
3. Go to:

```text
System > Open Setup Folder
```

4. Set:

```text
Default Print = Thermal receipt
Thermal Width = 80 mm
Thermal Feed Margin = 18
```

5. Save settings.
6. Go to Billing.
7. Add one product.
8. Complete bill.
9. Select Epson printer in browser print dialog.
10. Confirm print.

If the print is good but extra paper comes, reduce feed margin.

## 11. Future Electron Setup

When Electron is used, we can improve this further by adding:

- thermal printer name setting
- direct silent print to Epson
- no browser print dialog
- printer selection from System settings

For now, browser mode depends on Windows/default printer and browser print dialog.

