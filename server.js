const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const INITIAL_PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

/**
 * Exact Windows/macOS native file-clipboard trick used by SilverFeit/StikSound (apps/desktop/src-tauri/src/lib.rs):
 * Writes the generated .mp4 / .webm / .webp file to a temp folder and places the REAL FILE (CF_HDROP)
 * on the OS clipboard using PowerShell `Set-Clipboard -LiteralPath`, so pressing Ctrl+V directly in
 * WhatsApp PC or WhatsApp Web pastes the actual video file with audio!
 */
function handleCopyFileToOsClipboard(req, res) {
  const chunks = [];
  let total = 0;
  const MAX_BODY = 35 * 1024 * 1024;

  req.on('data', (chunk) => {
    total += chunk.length;
    if (total <= MAX_BODY) chunks.push(chunk);
  });

  req.on('end', () => {
    if (total > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'File too large' }));
      return;
    }

    const rawName = String(req.headers['x-file-name'] || 'stiksound-whatsapp.mp4');
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_') || 'stiksound-whatsapp.mp4';
    const clipDir = path.join(os.tmpdir(), 'AudioStickerClipboard');

    try {
      fs.mkdirSync(clipDir, { recursive: true });
      const destPath = path.join(clipDir, safeName);
      fs.writeFileSync(destPath, Buffer.concat(chunks));

      if (process.platform === 'win32') {
        const escaped = destPath.replace(/'/g, "''");
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${escaped}'`],
          (err) => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, path: destPath }));
          }
        );
      } else if (process.platform === 'darwin') {
        const escaped = destPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        execFile('osascript', ['-e', `set the clipboard to (POSIX file "${escaped}")`], (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: destPath }));
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unsupported OS clipboard command' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  });
}

function createAppServer() {
  return http.createServer((req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];

    if (req.method === 'POST' && reqUrl === '/api/copy-file-clipboard') {
      handleCopyFileToOsClipboard(req, res);
      return;
    }

    const safePath = decodeURIComponent(reqUrl);
    const relPath = safePath === '/' ? 'index.html' : safePath.replace(/^\/+/, '');
    const filePath = path.join(ROOT, relPath);

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });
}

function startServer(port) {
  const server = createAppServer();
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log(`⚠️ Puerto ${port} ocupado, probando puerto ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error(err);
    }
  });
  server.listen(port, () => {
    console.log(`\n✅ AudioSticker Studio (PWA + Native Windows File Clipboard) en: http://localhost:${port}\n`);
  });
}

startServer(INITIAL_PORT);
