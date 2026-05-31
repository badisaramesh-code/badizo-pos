# BADIZO Barcode Sticker PRN

Template file:

`barcode/templates/tsc-244-pro-50x50-two-up.prn`

Generated PRN files:

`barcode/output/`

The template is external so each store can adjust sticker text, spacing, address, or printer positioning without changing app code.

For TSC TTP-244 Pro raw printing on Windows:

1. Share the printer in Windows, for example as `TSC-244-Pro`.
2. Edit `barcode/print-prn-to-tsc.bat` if the share name is different.
3. Generate a PRN from the Barcode Sticker screen.
4. Run:

`barcode\print-prn-to-tsc.bat barcode\output\YOUR_FILE.prn`
