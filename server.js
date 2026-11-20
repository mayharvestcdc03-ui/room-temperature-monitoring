const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'temperature-monitoring.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default initial state
const freshState = () => ({
  records: [],
  counterChecks: [],
  sheetSigs: {},
  counterSheetSigs: {},
  weeklyVerifications: {},
  lastUpdated: new Date().toISOString()
});

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(content);
      return {
        records: Array.isArray(parsed.records) ? parsed.records : [],
        counterChecks: Array.isArray(parsed.counterChecks) ? parsed.counterChecks : [],
        sheetSigs: parsed.sheetSigs && typeof parsed.sheetSigs === 'object' ? parsed.sheetSigs : {},
        counterSheetSigs: parsed.counterSheetSigs && typeof parsed.counterSheetSigs === 'object' ? parsed.counterSheetSigs : {},
        weeklyVerifications: parsed.weeklyVerifications && typeof parsed.weeklyVerifications === 'object' ? parsed.weeklyVerifications : {},
        lastUpdated: parsed.lastUpdated || new Date().toISOString()
      };
    }
  } catch (err) {
    console.error('Error reading data file:', err);
  }
  const init = freshState();
  saveData(init);
  return init;
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing data file:', err);
  }
}

// Safe two-way merge
function mergeData(serverState, incoming) {
  if (!incoming) return serverState;

  // 1. Records
  if (Array.isArray(incoming.records) && incoming.records.length > 0) {
    const recordMap = new Map();
    // Index existing server records by ID and composite key (date + time + area)
    serverState.records.forEach(r => {
      const key = r.id || `${r.date}_${r.time}_${r.area}`;
      recordMap.set(key, r);
    });
    incoming.records.forEach(r => {
      const key = r.id || `${r.date}_${r.time}_${r.area}`;
      const existing = recordMap.get(key);
      if (!existing) {
        recordMap.set(key, r);
      } else {
        // Merge without losing verification details
        recordMap.set(key, {
          ...existing,
          ...r,
          verification: r.verification || existing.verification,
          verifier: r.verifier || existing.verifier,
          verifyDate: r.verifyDate || existing.verifyDate,
          decisionRemarks: r.decisionRemarks || existing.decisionRemarks
        });
      }
    });
    serverState.records = Array.from(recordMap.values());
  }

  // 2. Counter Checks
  if (Array.isArray(incoming.counterChecks) && incoming.counterChecks.length > 0) {
    const cMap = new Map();
    serverState.counterChecks.forEach(c => {
      const key = c.id || `${c.date}_${c.time}_${c.area}`;
      cMap.set(key, c);
    });
    incoming.counterChecks.forEach(c => {
      const key = c.id || `${c.date}_${c.time}_${c.area}`;
      const existing = cMap.get(key);
      cMap.set(key, existing ? { ...existing, ...c } : c);
    });
    serverState.counterChecks = Array.from(cMap.values());
  }

  // 3. Sheet Signatures (key: "YYYY-MM-DD|Shift")
  if (incoming.sheetSigs && typeof incoming.sheetSigs === 'object') {
    if (!serverState.sheetSigs) serverState.sheetSigs = {};
    for (const [key, sigList] of Object.entries(incoming.sheetSigs)) {
      if (Array.isArray(sigList)) {
        const existingList = serverState.sheetSigs[key] || [];
        const mergedList = [...existingList];
        sigList.forEach(s => {
          const idx = mergedList.findIndex(e => e.name === s.name);
          if (idx >= 0) mergedList[idx] = s;
          else mergedList.push(s);
        });
        serverState.sheetSigs[key] = mergedList;
      }
    }
  }

  // 4. Counter Sheet Signatures (key: "YYYY-MM-DD")
  if (incoming.counterSheetSigs && typeof incoming.counterSheetSigs === 'object') {
    if (!serverState.counterSheetSigs) serverState.counterSheetSigs = {};
    for (const [key, sigList] of Object.entries(incoming.counterSheetSigs)) {
      if (Array.isArray(sigList)) {
        const existingList = serverState.counterSheetSigs[key] || [];
        const mergedList = [...existingList];
        sigList.forEach(s => {
          const idx = mergedList.findIndex(e => e.name === s.name);
          if (idx >= 0) mergedList[idx] = s;
          else mergedList.push(s);
        });
        serverState.counterSheetSigs[key] = mergedList;
      }
    }
  }

  // 5. Weekly Verifications (key: week start date)
  if (incoming.weeklyVerifications && typeof incoming.weeklyVerifications === 'object') {
    if (!serverState.weeklyVerifications) serverState.weeklyVerifications = {};
    for (const [key, verList] of Object.entries(incoming.weeklyVerifications)) {
      if (Array.isArray(verList)) {
        serverState.weeklyVerifications[key] = verList;
      }
    }
  }

  serverState.lastUpdated = new Date().toISOString();
  return serverState;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API Endpoints
  if (pathname === '/api/data' && req.method === 'GET') {
    const data = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body || '{}');
        const current = loadData();
        const merged = mergeData(current, incoming);
        saveData(merged);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: merged }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    const fresh = freshState();
    saveData(fresh);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'All records reset on server' }));
    return;
  }

  // Static File Serving
  let filePath = pathname === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, pathname);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`MHC Hourly Room Temperature Monitoring Server running on port ${PORT}`);
});
