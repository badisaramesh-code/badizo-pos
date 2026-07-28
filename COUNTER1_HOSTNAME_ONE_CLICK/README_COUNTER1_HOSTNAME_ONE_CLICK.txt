Badizo Counter1 One Click Setup

Configured server IP:
192.168.1.10

Counter1 can have any IP, but it must be on the same network.
Do not use old 192.168.1.9 or 192.168.1.16 packages for Counter1.

Expected login screen:
1. Counter1 fixed/sticky login
2. Counter person name or code entry
3. Password entry

Password:
counter123

Steps on Counter1 system:
1. Close Badizo app.
2. Copy COUNTER1_HOSTNAME_ONE_CLICK.zip to Desktop or Downloads.
3. Right-click the zip and choose Extract All.
4. Open extracted COUNTER1_HOSTNAME_ONE_CLICK folder.
5. Double-click RUN_COUNTER1_HOSTNAME_ONE_CLICK.bat.
6. If Windows asks permission, click Yes / Run anyway.
7. If installer window opens, complete install and wait.
8. Badizo opens automatically.

If login screen shows all counters/admins:
1. Close Badizo.
2. Run FIX_COUNTER1_LOGIN_ONLY.bat from this same folder.

This setup writes both current and legacy Badizo config folders:
%APPDATA%\badizo-desktop\app-config.json
%APPDATA%\Badizo\app-config.json

Do not run bat files directly inside WinRAR/zip preview.
