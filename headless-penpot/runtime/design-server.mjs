import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {URL} from 'node:url';

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const dist = path.resolve(get('--dist', ''));
const workspace = path.resolve(get('--workspace', 'workspace'));
const port = Number(get('--port', '4310'));

if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Penpot index.html not found');
fs.mkdirSync(workspace, {recursive:true});

const mime = {
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.wasm':'application/wasm',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
  '.ttf':'font/ttf'
};

function safeFile(requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const clean = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(dist, clean);
  return candidate.startsWith(dist + path.sep) ? candidate : null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + port);

  if (u.pathname === '/__codelab/headless.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      protocol:'codelab-penpot-headless/v1',
      offline:true,
      workspace,
      nativeDocument:path.join(workspace, 'design.penpot.json')
    }));
    return;
  }

  let file = safeFile(u.pathname);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dist, 'index.html');
  }

  res.setHeader('content-type', mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log('Headless Penpot: http://127.0.0.1:' + port);
  console.log('Workspace: ' + workspace);
});
