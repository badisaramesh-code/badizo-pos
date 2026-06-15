const fs = require('fs');
const http = require('http');
const path = require('path');

const appRoot = path.resolve(__dirname, '..', '..');
const buildDir = path.join(appRoot, 'frontend', 'build');
const indexPath = path.join(buildDir, 'index.html');
const port = Number(process.env.BADIZO_FRONTEND_PORT || 3000);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unable to read frontend file.');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': filePath === indexPath ? 'no-store' : 'public, max-age=31536000, immutable'
    });
    res.end(data);
  });
}

if (!fs.existsSync(indexPath)) {
  console.error(`Frontend build was not found at ${buildDir}. Run npm run build in frontend first.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://localhost:${port}`);
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  const safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(buildDir, safePath);

  if (!filePath.startsWith(buildDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(res, filePath);
      return;
    }

    sendFile(res, indexPath);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Badizo frontend serving ${buildDir} on http://localhost:${port}`);
});
