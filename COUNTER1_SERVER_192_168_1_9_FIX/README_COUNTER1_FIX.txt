Badizo Counter1 Fix
===================

Use this folder on the Counter1 computer.

1. Copy the whole COUNTER1_SERVER_192_168_1_9_FIX folder to Counter1.
2. Double-click FIX_COUNTER1_TO_SERVER_192_168_1_9.bat.
3. When it completes, open "Badizo Counter1" from the Desktop.

This fix changes Counter1 from the old local URL:
  http://192.168.1.14:3000

to the current server URL:
  http://192.168.1.9:5000?loginMode=counter&loginUser=counter1

It also disables local frontend startup on port 3000 and creates a forced
5000 launcher on the Desktop, which fixes:
  listen EADDRINUSE: address already in use :::3000
