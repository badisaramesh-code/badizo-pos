# BADIZO Barcode Sticker PRN

Template files:

`barcode/templates/tsc-244-pro-50x50-two-up.prn`

`barcode/templates/tsc-244-1-33x25-single.prn`

`barcode/templates/tsc-244-2-jewellery-100x15-tail.prn`

Generated PRN files:

`barcode/output/`

The template is external so each store can adjust sticker text, spacing, address, or printer positioning without changing app code.

For TSC TTP-244 Pro raw printing on Windows:

1. Share the printer in Windows, for example as `TSC-244-Pro`.
2. Edit `barcode/print-prn-to-tsc.bat` if the share name is different.
3. Generate a PRN from the Barcode Sticker screen.
4. Run:

`barcode\print-prn-to-tsc.bat barcode\output\YOUR_FILE.prn`

33 x 25 mm printer share:

`TSC 244-1`

Print command:

`barcode\print-33x25-to-tsc-244-1.bat barcode\output\YOUR_FILE.prn`

100 x 15 mm jewellery tail printer share:

`TSC 244-2`

Print command:

`barcode\print-jewellery-to-tsc-244-2.bat barcode\output\YOUR_FILE.prn`
