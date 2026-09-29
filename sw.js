// Offline support: app files are cached at install; Pyodide files from the CDN are cached on first use.
const VERSION = '9e13dcf44b40';            // build_pwa.py stamps a content hash, so each build refreshes the cache
const APP_FILES = ["./", "icon-180.png", "icon-192.png", "icon-512.png", "index.html", "local-api.js", "manifest.webmanifest", "py.zip", "wheels/et_xmlfile-2.0.0-py3-none-any.whl", "wheels/openpyxl-3.1.5-py2.py3-none-any.whl", "wheels/pdfminer_six-20260107-py3-none-any.whl", "wheels/pdfplumber-0.11.10-py3-none-any.whl", "wheels/reportlab-5.0.1-py3-none-any.whl", "wheels.json"];
const CACHE = 'expense-importer-' + VERSION;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('expense-importer-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req, {ignoreSearch: true});
    if(hit) return hit;
    const res = await fetch(req);
    if(res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }));
});
