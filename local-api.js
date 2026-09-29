// Phone app: runs the Python importer in the browser (Pyodide) and answers the page's /api/... calls,
// so no server is needed and statements never leave the device. Loaded before index.html's own script.
(() => {
  const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
  const PROFILES_FILE = '/data/profiles.json', PROFILES_KEY = 'expense-importer-profiles';

  if ('serviceWorker' in navigator && isSecureContext){
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    // A new version finished installing: switch to it now unless a statement is open (a reload would clear it).
    const updating = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if(updating && document.getElementById('results').hidden && document.getElementById('mapCard').hidden) location.reload();
    });
  }

  function status(text){
    const el = document.getElementById('llm');
    if(el){ el.className = 'pill'; el.textContent = text; }
  }
  function loadScript(src){
    return new Promise((ok, fail) => {
      const s = Object.assign(document.createElement('script'), {src, onload: ok, onerror: () => fail(new Error('could not download ' + src))});
      document.head.appendChild(s);
    });
  }
  const absolute = files => files.map(f => new URL('wheels/' + f, location.href).href);

  async function installWheels(py, urls){
    py.globals.set('WHEEL_URLS', py.toPy(urls));
    await py.runPythonAsync('import micropip\nawait micropip.install(WHEEL_URLS, deps=False)');
  }

  const engine = (async () => {
    status('Loading engine… (first time downloads ~20 MB)');
    const [, wheels, bundle] = await Promise.all([
      loadScript(PYODIDE + 'pyodide.js'),
      fetch('wheels.json').then(r => r.json()),
      fetch('py.zip').then(r => r.arrayBuffer()),
    ]);
    const py = await loadPyodide({indexURL: PYODIDE});
    await py.loadPackage(['micropip', 'pandas', 'lxml', 'xlrd']);
    await installWheels(py, absolute(wheels.core));
    py.unpackArchive(bundle, 'zip', {extractDir: '/app'});
    py.FS.mkdirTree('/data'); py.FS.mkdirTree('/tmp/uploads');
    try{ const saved = localStorage.getItem(PROFILES_KEY); if(saved) py.FS.writeFile(PROFILES_FILE, saved); }catch{}
    py.runPython('import sys; sys.path.insert(0, "/app"); import bridge');
    status('Engine ready');
    return {py, bridge: py.pyimport('bridge'), wheels};
  })();

  // PDF support needs a few more packages; fetch them in the background so PDFs also work offline later.
  let pdfReady = null;
  function ensurePdf({py, bridge, wheels}){
    pdfReady ??= (async () => {
      // pycryptodome, not Pyodide's cryptography (which crashes); see pwa/crypto_shim.py
      await py.loadPackage(['pillow', 'pycryptodome', 'charset-normalizer']);
      await installWheels(py, absolute(wheels.pdf));
      bridge.enable_pdf();
    })().catch(e => { pdfReady = null; throw e; });
    return pdfReady;
  }
  engine.then(e => setTimeout(() => ensurePdf(e).catch(() => {}), 2000), () => {});

  function saveProfiles(py){
    try{
      if(py.FS.analyzePath(PROFILES_FILE).exists)
        localStorage.setItem(PROFILES_KEY, py.FS.readFile(PROFILES_FILE, {encoding: 'utf8'}));
    }catch{}
  }

  const MIME = {xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf'};
  window.localExport = async body => {
    let e;
    try{ e = await engine; }catch(err){ return {error:`Couldn't load the engine (${err.message}). Connect to the internet once and reload.`}; }
    await new Promise(r => setTimeout(r, 30));      // let "Preparing…" paint
    try{
      if(body.format === 'pdf') await ensurePdf(e);  // reportlab ships with the PDF packages
      const out = e.bridge.export_file(JSON.stringify(body));
      const bytes = out.toJs(); out.destroy();
      return {blob: new Blob([bytes], {type: MIME[body.format]})};
    }catch(err){
      return {error:'Download failed: ' + String(err.message || err).trim().split('\n').pop()};
    }
  };

  window.localApi = async (path, opts = {}) => {
    let e;
    try{ e = await engine; }
    catch(err){ status('Engine failed to load'); return {ok:false, body:{message:`Couldn't load the engine (${err.message}). Connect to the internet once and reload.`}}; }
    const {py, bridge} = e, method = (opts.method || 'GET').toUpperCase();
    await new Promise(r => setTimeout(r, 30));      // let "Importing…" paint before Python blocks the page
    let res;
    try{
      if(path === '/api/llm') return {ok:true, body:{on_device:true}};
      else if(path === '/api/samples') res = bridge.list_samples();
      else if(path === '/api/import-sample') res = bridge.import_sample(JSON.parse(opts.body).name);
      else if(path === '/api/mapping') res = bridge.save_mapping(opts.body);
      else if(path === '/api/profiles') res = bridge.list_profiles();
      else if(path.startsWith('/api/profiles/') && method === 'DELETE') res = bridge.delete_profile(decodeURIComponent(path.slice(14)));
      else if(path === '/api/import'){
        const f = opts.body.get('file'), ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        if(ext === '.pdf') await ensurePdf(e);
        const dest = `/tmp/uploads/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        py.FS.writeFile(dest, new Uint8Array(await f.arrayBuffer()));
        res = bridge.import_file(dest, f.name, opts.body.get('password') || '');
      }
      else return {ok:false, body:{message:`Unknown call ${method} ${path}`}};
    }catch(err){
      return {ok:false, body:{message:'Import failed: ' + String(err.message || err).trim().split('\n').pop()}};
    }
    saveProfiles(py);
    const [code, body] = JSON.parse(res);
    return {ok: code < 400, body};
  };
})();
