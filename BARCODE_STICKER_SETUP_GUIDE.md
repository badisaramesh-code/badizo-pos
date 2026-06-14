# Badizo POS Barcode Sticker Printer Setup Guide

This guide is for setting up barcode sticker printing on a new Windows system.

## 1. What The Software Does

Badizo POS does not print barcode stickers like a normal A4/browser page.

It creates a raw printer command file called a PRN file, then sends that file directly to the TSC barcode printer.

Generated files are saved here:

```powershell
D:\badizo-pos-main\barcode\output
```

The printer will not automatically read files from this folder. The software sends the PRN file to the Windows shared printer path.

Example:

```bat
copy /b "D:\badizo-pos-main\barcode\output\YOUR_FILE.prn" "\\localhost\TSC TTP-244 -1"
```

## 2. Supported Sticker Sizes

Current setup:

| Sticker Size | Template File | Expected Printer |
|---|---|---|
| 33 x 25 mm Two-Up | `barcode\templates\tsc-244-1-33x25-single.prn` | `TSC TTP-244 -1` |
| 50 x 50 mm Two-Up | `barcode\templates\tsc-244-pro-50x50-two-up.prn` | `TSC TTP-244 Pro` |
| 100 x 15 mm Jewellery Tail | `barcode\templates\tsc-244-2-jewellery-100x15-tail.prn` | `TSC 244-2` |

Two-Up means two stickers print side-by-side in one row.

## 3. Install Printer Driver

Install the correct TSC printer driver on Windows.

After connecting printer by USB, check installed printers:

```powershell
Get-Printer | Select-Object Name,Shared,ShareName,DriverName,PortName,PrinterStatus | Format-Table -AutoSize
```

Expected example:

```text
Name              Shared ShareName        PortName PrinterStatus
----              ------ ---------        -------- -------------
TSC TTP-244 -1    True   TSC TTP-244 -1   USB002   Normal
TSC TTP-244 Pro   True   TSC TTP-244 Pro  COM1:    Normal
```

## 4. Share The Printer In Windows

The raw PRN print works through Windows printer sharing.

Open:

```text
Control Panel > Devices and Printers
```

For `TSC TTP-244 -1`:

1. Right-click printer.
2. Click `Printer properties`.
3. Open `Sharing` tab.
4. Check `Share this printer`.
5. Share name:

```text
TSC TTP-244 -1
```

For `TSC TTP-244 Pro`:

Share name:

```text
TSC TTP-244 Pro
```

Then verify:

```powershell
Get-Printer | Select-Object Name,Shared,ShareName,PortName,PrinterStatus | Format-Table -AutoSize
```

## 5. Configure In Badizo POS

Open:

```text
System > Open Setup Folder > Barcode Sticker Printers
```

Set share paths like this:

### 33 x 25 mm Two-Up

Printer Name:

```text
TSC TTP-244 -1
```

Windows Share Path:

```text
\\localhost\TSC TTP-244 -1
\\localhost\TSC 244-1
```

### 50 x 50 mm Two-Up

Printer Name:

```text
TSC TTP-244 Pro
```

Windows Share Path:

```text
\\localhost\TSC TTP-244 Pro
\\localhost\TSC-244-Pro
```

### 100 x 15 mm Jewellery Tail

Printer Name:

```text
TSC 244-2
```

Windows Share Path:

```text
\\localhost\TSC 244-2
```

Click:

```text
Save Settings
```

## 6. Test Printer From Command Line

First generate one PRN from POS:

```text
Barcode > Sticker Print > select size > scan/search product > Print Stickers
```

If a PRN file is created but not printed, manually test:

```bat
cmd.exe /c copy /b "D:\badizo-pos-main\barcode\output\YOUR_FILE.prn" "\\localhost\TSC TTP-244 -1"
```

For 50 x 50:

```bat
cmd.exe /c copy /b "D:\badizo-pos-main\barcode\output\YOUR_FILE.prn" "\\localhost\TSC TTP-244 Pro"
```

Success message:

```text
1 file(s) copied.
```

If this succeeds but sticker does not print, check printer power, label roll, feed/calibration, pause state, and printer queue.

## 7. Check Print Queue

```powershell
Get-PrintJob -PrinterName "TSC TTP-244 -1" -ErrorAction SilentlyContinue | Select-Object ID,Name,JobStatus,SubmittedTime,Size,TotalPages | Format-Table -AutoSize
```

Check printer status:

```powershell
Get-Printer -Name "TSC TTP-244 -1" | Select-Object Name,PrinterStatus,DetectedErrorState,ExtendedPrinterStatus,WorkOffline,PortName | Format-List
```

## 8. Common Errors And Fixes

### Error

```json
{
  "error": "Unable to send sticker file to \\\\localhost\\TSC 244-1. Share the Windows printer with this exact name and try again. Details: The network name cannot be found."
}
```

Reason:

The printer share path configured in POS does not match the Windows share name.

Fix:

Run:

```powershell
Get-Printer | Select-Object Name,Shared,ShareName,PortName,PrinterStatus | Format-Table -AutoSize
```

Use the exact `ShareName` in POS.

Example:

If Windows shows:

```text
Name            ShareName
TSC TTP-244 -1  TSC TTP-244 -1
```

Then POS share path must be:

```text
\\localhost\TSC TTP-244 -1
```

### API Says Printed True But Nothing Prints

Example:

```json
{
  "printed": true,
  "printer_share": "\\\\localhost\\TSC TTP-244 -1"
}
```

Reason:

POS successfully sent the file to Windows. Problem is usually printer queue, printer calibration, label roll, printer pause state, or unsupported PRN command.

Fix checks:

```powershell
Get-PrintJob -PrinterName "TSC TTP-244 -1"
Get-Printer -Name "TSC TTP-244 -1" | Format-List
```

Also power cycle printer and press `FEED` once.

## 9. Backend Restart Commands

Check Node backend process:

```powershell
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Select-Object ProcessId,CommandLine
```

Stop backend only:

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

## 10. Development Checks We Ran

Backend syntax checks:

```powershell
& 'C:\Program Files\nodejs\node.exe' --check backend\routes\barcode.js
& 'C:\Program Files\nodejs\node.exe' --check backend\routes\settings.js
& 'C:\Program Files\nodejs\node.exe' --check backend\config\db.js
```

Frontend build:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run build
```

Run from:

```powershell
D:\badizo-pos-main\frontend
```

## 11. Final Test Flow

1. Power on barcode sticker printer.
2. Press printer `FEED` button once.
3. Open POS.
4. Go to:

```text
Barcode > Sticker Print
```

5. Select:

```text
33 x 25 mm Two-Up
```

6. Scan/search product.
7. Set sticker count:

```text
2
```

8. Click:

```text
Print Stickers
```

Expected result:

Two stickers print side-by-side with product name, barcode, MRP, SP, tax note, quantity, shop name, address, and phone.

