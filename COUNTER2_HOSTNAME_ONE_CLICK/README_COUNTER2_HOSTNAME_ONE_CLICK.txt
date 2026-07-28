Badizo Counter2 Hostname One Click Setup

Use this package when IP addresses keep changing.

Server computer name:
DESKTOP-085I1KT

Counter2 can have any IP, but it must be on the same network.
Do not use old 192.168.1.16-only packages for Counter2. This package first tries the server computer name, then falls back to server IP addresses.

Expected login screen:
1. Counter2 fixed/sticky login
2. Counter person name or code entry
3. Password entry

Password:
counter123

Steps on Counter2 system:
1. Close Badizo app.
2. Copy COUNTER2_HOSTNAME_ONE_CLICK.zip to Desktop or Downloads.
3. Right-click the zip and choose Extract All.
4. Open extracted COUNTER2_HOSTNAME_ONE_CLICK folder.
5. Double-click RUN_COUNTER2_HOSTNAME_ONE_CLICK.bat.
6. If Windows asks permission, click Yes / Run anyway.
7. If installer window opens, complete install and wait.
8. Badizo opens automatically.

If setup cannot reach server:
Open browser on Counter2 and test:
http://DESKTOP-085I1KT:3000
http://192.168.1.9:3000

If that does not open, use router DHCP reservation/static IP for server system.

This setup writes both current and legacy Badizo config folders:
%APPDATA%\badizo-desktop\app-config.json
%APPDATA%\Badizo\app-config.json

Do not run the bat file directly inside WinRAR/zip preview.
