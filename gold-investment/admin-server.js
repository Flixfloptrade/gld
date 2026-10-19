const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const row of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const PORT = Number(process.env.ADMIN_PORT || 3002);
const BACKEND = new URL(process.env.ADMIN_BACKEND_URL || 'http://127.0.0.1:3001');
const PUBLIC_ROOT = path.join(ROOT, 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://i.pinimg.com https://images.pexels.com https://thumb.wikimedia.org https://upload.wikimedia.org; media-src 'self' blob: https://v1.pinimg.com; style-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com https://countriesnow.space; worker-src 'self' blob:; frame-src blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function proxyApi(req, res) {
  const headers = { ...req.headers, host: BACKEND.host };
  delete headers.connection;
  const upstream = http.request({ protocol: BACKEND.protocol, hostname: BACKEND.hostname, port: BACKEND.port || undefined, method: req.method, path: req.url, headers }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'The admin service cannot reach the main application server. Start the main server and check ADMIN_BACKEND_URL.' })); }
  });
  req.pipe(upstream);
}

function serveApp(req, res, pathname) {
  const relative = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
  const file = path.resolve(PUBLIC_ROOT, relative);
  if (!file.startsWith(path.resolve(PUBLIC_ROOT) + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (error, content) => {
    if (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Admin page files are missing. Run npm run build first.'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return proxyApi(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed'); }
  if (url.pathname === '/') { res.writeHead(302, { Location: '/admin/login', 'Cache-Control': 'no-store' }); return res.end(); }
  if (url.pathname.startsWith('/assets/')) return serveApp(req, res, url.pathname);
  if (url.pathname.startsWith('/admin')) return serveApp(req, res, '/admin/login');
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found. Open /admin/login.');
});

server.listen(PORT, '0.0.0.0', () => console.log(`Gold Investment staff portal running at http://localhost:${PORT}/admin/login (API: ${BACKEND.origin})`));
