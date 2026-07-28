Counter2 Desktop POS Ready

Run this on the Counter2 computer:

1. Extract this folder.
2. Double-click RUN_COUNTER2_DESKTOP_POS_READY.bat.
3. After it finishes, use desktop shortcut:
   Badizo Counter2 Desktop POS

This package:
- Installs the latest Badizo desktop app.
- Locks Counter2 to:
  http://192.168.1.9:5000?loginMode=counter&loginUser=counter2
- Writes AppData config with frontendPort/backendPort 5000.
- Creates a clean desktop shortcut that sets 5000 environment variables before opening Badizo.
- Uses desktop direct thermal print instead of browser print preview.

After setup, test:
1. Scan a few products.
2. Press F12 cash.
3. Check print paper feed.
4. Close and reopen the shortcut.
