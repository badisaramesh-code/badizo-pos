const http = require('http');
const { URL } = require('url');
require('dotenv').config();

const PORT = Number(process.env.GOOGLE_DRIVE_OAUTH_PORT || 53682);
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive';

function requireEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required in backend\\.env before running this script.`);
  }
  return value;
}

async function exchangeCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_DRIVE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_DRIVE_CLIENT_SECRET'),
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed: HTTP ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const clientId = requireEnv('GOOGLE_DRIVE_CLIENT_ID');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, REDIRECT_URI);
      if (requestUrl.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');
      if (error) throw new Error(error);
      if (!code) throw new Error('Google did not return an authorization code.');

      const token = await exchangeCode(code);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Badizo Google Drive authorization completed. You can close this tab.');

      console.log('');
      console.log('Add this line to backend\\.env:');
      console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${token.refresh_token}`);
      console.log('');
      console.log('Keep this token private.');
      server.close();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
      console.error(err.message);
      server.close();
      process.exitCode = 1;
    }
  });

  server.listen(PORT, () => {
    console.log('Open this URL in Chrome, login to your Google account, and approve Drive access:');
    console.log('');
    console.log(authUrl.toString());
    console.log('');
    console.log(`Waiting for Google callback on ${REDIRECT_URI}`);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
