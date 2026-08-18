/**
 * Charlie Print Relay
 * ============================================================================
 * Runs LOCALLY on a till PC — not on the Zeabur server, not reachable from
 * the internet. Solves the problem where WebUSB (Zadig/WinUSB) gives Charlie
 * exclusive access to a receipt printer, breaking any other program (e.g.
 * Humble, used as the fallback till system) that also needs to print to it.
 *
 * How it avoids that conflict: this relay does NOT talk to the printer over
 * USB directly. It sends raw ESC/POS bytes to the printer's SHARE NAME using
 * Windows' native "copy /b" raw-print trick — the same mechanism any normal
 * Windows program (including Humble) uses. The printer stays a completely
 * ordinary shared Windows printer the whole time; nothing claims it
 * exclusively, so both programs can print to it, including at the same time.
 *
 * Requires: the printer's normal Windows driver installed as usual, with
 * printer SHARING turned on (Control Panel → Devices and Printers → right-
 * click the printer → Printer properties → Sharing tab → Share this printer).
 * Put that share name into config.json next to this file.
 *
 * No npm install needed — uses only Node's built-in modules, deliberately,
 * so this can just be copied to a till and run with `node relay.js`.
 * ============================================================================
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 9123;
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg.printerShareName || cfg.printerShareName === 'YOUR_PRINTER_SHARE_NAME_HERE') {
      console.error('[relay] config.json exists but printerShareName is not set yet.');
      console.error('[relay] Edit config.json — see README.md for how to find the share name.');
    }
    return cfg;
  } catch (e) {
    console.error('[relay] Could not read config.json:', e.message);
    console.error('[relay] Copy config.example.json to config.json and set your printer share name.');
    return { printerShareName: null };
  }
}

let config = loadConfig();

// Sends raw bytes to a Windows-shared printer via the classic binary-copy
// trick: `copy /b <file> \\<hostname>\<shareName>`. This bypasses GDI/driver
// text rendering entirely — the printer receives the ESC/POS bytes exactly
// as sent, which is required for thermal receipt formatting and the cash
// drawer kick command to work. Requires the printer to be shared (see above).
function printRaw(bytes, cb) {
  if (!config.printerShareName) {
    return cb(new Error('printerShareName not configured — edit config.json'));
  }
  const tmpFile = path.join(os.tmpdir(), `charlie-relay-${Date.now()}.prn`);
  fs.writeFile(tmpFile, bytes, (writeErr) => {
    if (writeErr) return cb(writeErr);
    const target = `\\\\${os.hostname()}\\${config.printerShareName}`;
    execFile('cmd.exe', ['/c', 'copy', '/b', tmpFile, target], (err, stdout, stderr) => {
      fs.unlink(tmpFile, () => {}); // best-effort cleanup, don't block the response on it
      if (err) return cb(new Error(`copy to printer share failed: ${stderr || err.message}`));
      cb(null);
    });
  });
}

function setCors(res) {
  // Charlie is served over HTTPS from lorenco.zeabur.app; this relay is a
  // plain HTTP localhost service. Browsers allow HTTPS pages to fetch
  // http://127.0.0.1 as a deliberate carve-out for local hardware-bridge
  // tools like this one, but the cross-origin request still needs CORS
  // headers on both the preflight and the real response.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req, cb) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => cb(Buffer.concat(chunks)));
  req.on('error', (e) => cb(null, e));
}

const server = http.createServer((req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      printerShareName: config.printerShareName || null,
      hostname: os.hostname(),
    }));
  }

  if (req.method === 'POST' && (req.url === '/print' || req.url === '/drawer-kick')) {
    readBody(req, (body, err) => {
      if (err || !body || body.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No print data received' }));
      }
      printRaw(body, (printErr) => {
        if (printErr) {
          console.error('[relay] print failed:', printErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: printErr.message }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] Charlie Print Relay listening on http://127.0.0.1:${PORT}`);
  console.log(`[relay] Printer share: ${config.printerShareName || '(not configured — edit config.json)'}`);
  console.log('[relay] Leave this window open. Minimize it, or add it to Windows Startup — see README.md.');
});
