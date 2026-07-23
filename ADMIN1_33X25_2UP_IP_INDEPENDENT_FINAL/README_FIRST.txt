BADIZO ADMIN1 - FINAL 33 x 25 mm 2-UP - IP INDEPENDENT
Date: 23-07-2026

Use this package only on the Admin1 computer where the USB TSC TE244 is installed.

1. Extract this ZIP completely.
2. Connect and switch on the TSC TE244 printer.
3. Double-click INSTALL_ADMIN1_FINAL.bat and accept Administrator permission.
4. Wait for the green SUCCESS message.
5. Restart Admin1 once.
6. Open only the desktop shortcut named Badizo Admin1.
7. In Barcode, select 33 x 25 mm Two-Up and print one test row.

Verified configuration:
- Windows printer: TSC TE244
- Windows share: TSC-244-2
- App print path: \\localhost\TSC-244-2
- Sticker template: SIZE 68 mm x 25 mm, GAP 2 mm, two 33 mm labels per row
- Printer resolution: TSC TE244 203 dpi
- Admin login: admin1
- Server lookup: hostname first, automatic LAN scan fallback

Why IP changes are safe:
- Stickers are sent locally from the Admin1 desktop app to \\localhost\TSC-244-2.
- Old saved paths such as \\192.168.1.23\TSC-244-2 are ignored for this 33 x 25 TSC TE244 template.
- No Admin1 IP address is stored in the printer path.
- Badizo server discovery checks common hostnames and scans the current LAN if its IP changes.

To check settings later without reinstalling, run VERIFY_ADMIN1_PRINTER.bat.
