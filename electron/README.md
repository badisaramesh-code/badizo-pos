# Badizo POS Desktop App

This Electron app opens Badizo POS as a Windows desktop application.

## Local testing on this laptop

1. Start backend:
   ```powershell
   cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\backend
   npm run dev
   ```

2. Start frontend:
   ```powershell
   cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\frontend
   npm start
   ```

3. Start desktop app:
   ```powershell
   cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\electron
   npm start
   ```

## Server PC URL

For another PC, edit `app-config.json`:

```json
{
  "appUrl": "http://SERVER-PC-IP:3000",
  "kiosk": false,
  "devTools": false
}
```

Example:

```json
{
  "appUrl": "http://192.168.1.10:3000",
  "kiosk": false,
  "devTools": false
}
```

## Build Windows installer

```powershell
cd C:\Users\badis\Downloads\BADIZO_COMPLETE_APPLICATION\electron
npm run dist
```

Installer output will be in `electron\dist`.
