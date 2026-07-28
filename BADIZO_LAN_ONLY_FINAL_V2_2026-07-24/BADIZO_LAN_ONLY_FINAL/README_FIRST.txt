BADIZO POS - INTERNET-FREE LAN SETUP
====================================

This setup runs Badizo in a browser using only the local network.
Internet is not required for login, billing, inventory, reports, or printing.

NETWORK
  Router / switch: 192.168.1.x LAN
  Server PC:        192.168.1.10
  Badizo URL:       http://192.168.1.10:5000

SERVER PC (run once)
  1. Connect the server PC to the LAN router/switch with an Ethernet cable.
  2. Right-click 1_SETUP_SERVER_LAN_ONLY.bat and choose Run as administrator.
  3. Keep MySQL installed and running on the server PC.

EVERY ADMIN / SYSTEM PC (run once)
  1. Connect the PC to the same LAN router/switch.
  2. Double-click 2_INSTALL_BROWSER_SHORTCUTS.bat.
  3. Use the required Badizo shortcut created on the Desktop.

SHORTCUTS CREATED
  Badizo - All Logins
  Badizo - Admin 1 / Admin 2
  Badizo - System 1 through System 6
  Badizo - Security 1 / Security 2
  Badizo - LAN Connection Test

IMPORTANT
  The router/switch must remain powered on. Its WAN/internet cable may be absent.
  Do not use a mobile hotspot as the shop LAN.
  The client PCs should use automatic IP (DHCP). Only the server uses 192.168.1.10.

Local backups always continue without internet. Google Drive backup runs when
internet is available. If internet is down at backup time, Badizo retries the
pending cloud backup automatically after internet returns.
