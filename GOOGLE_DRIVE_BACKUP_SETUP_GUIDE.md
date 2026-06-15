# Badizo POS Google Drive Backup Setup Guide

This guide explains how to keep only the latest 3 SQL backups locally and in Google Drive.

## What This Feature Does

When a backup runs:

1. Badizo creates the MySQL `.sql` backup locally.
2. Badizo uploads that backup to Google Drive.
3. Only after Google Drive upload succeeds, Badizo deletes older backups beyond the latest 3.
4. If Google Drive upload fails, old local backups are not deleted.

Example:

```text
Monday backup uploaded
Tuesday backup uploaded
Wednesday backup uploaded
Thursday backup uploaded successfully
Monday backup deleted from local folder and Google Drive
```

This protects against server hard disk failure because the latest successful backups are stored in Google Drive.

## Cost

This uses Google Drive API and your own Google account through OAuth. There is no paid SQL or paid backup software required.

Storage uses your Google Drive storage quota.

## Server Files

Local backup folder:

```text
D:\BadizoPOSBackups
```

Keep OAuth client secret and refresh token private. Do not commit them into Git.

## Google Setup

### 1. Create Google Drive Folder

In your Google Drive, create a folder:

```text
Badizo POS Backups
```

Open the folder and copy the folder ID from the URL.

Example URL:

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
```

Folder ID:

```text
1AbCdEfGhIjKlMnOpQrStUvWxYz
```

### 2. Create Google Cloud Project

Open:

```text
https://console.cloud.google.com/
```

Create a project:

```text
Badizo POS Backup
```

### 3. Enable Google Drive API

In Google Cloud Console:

```text
APIs & Services > Library > Google Drive API > Enable
```

### 4. Create OAuth Client

Go to:

```text
APIs & Services > OAuth consent screen
```

Choose:

```text
External
```

Fill required app details. For testing, add your Gmail account as a test user.

Then go to:

```text
APIs & Services > Credentials > Create Credentials > OAuth client ID
```

Application type:

```text
Desktop app
```

Name:

```text
Badizo POS Backup
```

Copy:

```text
Client ID
Client Secret
```

### 5. Generate Refresh Token

Edit:

```text
D:\badizo-pos-main\backend\.env
```

Add temporarily:

```env
GOOGLE_DRIVE_CLIENT_ID=PASTE_CLIENT_ID_HERE
GOOGLE_DRIVE_CLIENT_SECRET=PASTE_CLIENT_SECRET_HERE
```

Run:

```powershell
cd D:\badizo-pos-main\backend
& "C:\Program Files\nodejs\node.exe" scripts\googleDriveOAuth.js
```

The script prints a Google login URL.

1. Open that URL in Chrome.
2. Login to the Google account that owns the backup folder.
3. Approve Drive access.
4. The browser will show completion.
5. The terminal prints:

```env
GOOGLE_DRIVE_REFRESH_TOKEN=...
```

Copy that full line into:

```text
D:\badizo-pos-main\backend\.env
```

Keep this token private.

### 6. No Folder Sharing Needed For OAuth

Because OAuth uploads as your own Google account, you do not need to share the folder with a service account.

## Badizo .env Setup

Edit:

```text
D:\badizo-pos-main\backend\.env
```

Add:

```env
GOOGLE_DRIVE_BACKUP_ENABLED=true
GOOGLE_DRIVE_AUTH_MODE=oauth
GOOGLE_DRIVE_CLIENT_ID=PASTE_CLIENT_ID_HERE
GOOGLE_DRIVE_CLIENT_SECRET=PASTE_CLIENT_SECRET_HERE
GOOGLE_DRIVE_REFRESH_TOKEN=PASTE_REFRESH_TOKEN_HERE
GOOGLE_DRIVE_BACKUP_FOLDER_ID=PASTE_YOUR_GOOGLE_DRIVE_FOLDER_ID_HERE
GOOGLE_DRIVE_BACKUP_KEEP_COUNT=3
```

Example:

```env
GOOGLE_DRIVE_BACKUP_ENABLED=true
GOOGLE_DRIVE_AUTH_MODE=oauth
GOOGLE_DRIVE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_DRIVE_CLIENT_SECRET=GOCSPX-example
GOOGLE_DRIVE_REFRESH_TOKEN=1//example-refresh-token
GOOGLE_DRIVE_BACKUP_FOLDER_ID=1AbCdEfGhIjKlMnOpQrStUvWxYz
GOOGLE_DRIVE_BACKUP_KEEP_COUNT=3
```

## Restart Backend

After changing `.env`, restart backend:

```powershell
schtasks /End /TN "Badizo POS Backend"
schtasks /Run /TN "Badizo POS Backend"
```

If running manually:

```powershell
cd D:\badizo-pos-main\backend
& "C:\Program Files\nodejs\node.exe" server.js
```

## Test Backup Upload

Open Badizo:

```text
System > Database Backup > Backup Now
```

After backup completes:

1. Check local folder:

```text
D:\BadizoPOSBackups
```

2. Check Google Drive folder:

```text
Badizo POS Backups
```

3. Check logs:

```text
D:\badizo-pos-main\backend\logs\system.log
D:\badizo-pos-main\backend\logs\error.log
```

Success log includes:

```text
Google Drive backup uploaded
```

Failure log includes:

```text
Google Drive backup upload failed
```

## Retention Rule

Only the latest 3 backups are kept.

Deletion happens only after a new backup uploads successfully to Google Drive.

If Google Drive upload fails:

- New local backup remains.
- Old local backups remain.
- Old Google Drive backups remain.
- Error is written to `backend\logs\error.log`.

## Changing Daily Backup Time

Open:

```text
System > Database Backup
```

Change:

```text
Daily Backup Time
```

Click:

```text
Save Backup Time
```

Restart backend once after changing the time, because the daily scheduler is created when backend starts.

## Important Safety Notes

- Do not commit OAuth client secret or refresh token into Git.
- Keep server internet working during backup time.
- Keep enough Google Drive storage free.
- Keep enough `D:` drive space for at least a few failed-upload days.

## Official References

Google Drive API upload documentation:

```text
https://developers.google.com/workspace/drive/api/guides/manage-uploads
```

Google OAuth documentation:

```text
https://developers.google.com/identity/protocols/oauth2
```
