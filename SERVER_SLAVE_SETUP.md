# Server-Slave Setup

## Server PC

1. Run one-click server setup:

   ```text
   scripts\windows\setup-server-lan-one-click.bat
   ```

2. Allow Administrator permission when Windows asks.

3. It will set up:

   - Backend auto-start
   - Frontend auto-start
   - Firewall ports `3000` and `5000`
   - LAN tests

4. Keep server IP fixed as:

   ```text
   192.168.1.12
   ```

5. After setup, server should open:

   ```text
   http://192.168.1.12:3000
   http://192.168.1.12:5000/api/health
   ```

## Slave PC

1. Copy these 3 files from server to slave, same folder:

   ```text
   setup-slave-one-click.bat
   setup-slave-app.ps1
   Badizo Setup 1.0.0.exe
   ```

2. Double-click:

   ```text
   setup-slave-one-click.bat
   ```

3. It will:

   - Check server connection
   - Install Badizo
   - Create slave config pointing to `192.168.1.12`
   - Open Badizo app

## Important

- Server runs backend/frontend always.
- Slaves do not run backend/frontend/MySQL.
- Slaves only connect to server.
