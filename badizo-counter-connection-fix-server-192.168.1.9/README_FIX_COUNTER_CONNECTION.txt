Badizo Counter Connection Fix

Use this on counter PCs when Badizo opens localhost or an old server/POS.

Server IP:
192.168.1.9

Run:
fix-counter-connection-one-click.bat

This script:
- Tests server frontend port 3000
- Tests server backend port 5000
- Rewrites %APPDATA%\Badizo\app-config.json
- Points Badizo to http://192.168.1.9:3000
- Sets login mode to counter

Important:
localhost on a counter PC is not expected to work.
Only server PC should run backend/frontend/MySQL.
