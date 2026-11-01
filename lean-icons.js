// Lazy, shared image cache using the game's verified packs. No catalogue downloads.
const Icons = {
  port: null, ready: null, forcePage: false, seq: 0,
  pending: new Map(), urls: new Map(), failures: new Map(),
  iconPath(ddj) {
    if (!ddj) return '';
    let path = String(ddj).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '').replace(/^icon\//, '').replace(/\.ddj$/, '.png');
    if (!/\.[a-z0-9]+$/.test(path)) path += '.png'; // setup rows name icons without an extension
    if (!path.endsWith('.png') || path.split('/').includes('..') || !/^[a-z0-9_./ -]+$/.test(path)) return '';
    return '/assets/images/Media_extracted/icon/' + path;
  },
  boot() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => {
      let worker = null, url = '', timer = 0, settled = false;
      const finish = port => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.port = port;
        port.post({ op: 'init', origin: W.location.origin });
        resolve(port);
      };
      const page = () => {
        if (settled) return;
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        const host = { postMessage: result => this.reply(result) };
        assetLoaderMain(host);
        finish({ post: msg => host.onmessage({ data: msg }) });
      };
      if (this.forcePage) { page(); return; }
      try {
        url = URL.createObjectURL(new Blob(['(' + assetLoaderMain.toString() + ')(self)'], { type: 'text/javascript' }));
        worker = new (Hook.NativeWorker || W.Worker)(url, { name: 'sro-lean-icons' });
        const port = { post: msg => worker.postMessage(msg) };
        worker.onmessage = e => {
          if (e.data?.ready) { if (!settled) { URL.revokeObjectURL(url); finish(port); } }
          else this.reply(e.data);
        };
        worker.onerror = e => {
          e.preventDefault();
          if (!settled) { page(); return; }
          worker.terminate(); this.forcePage = true; this.ready = null; this.port = null;
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Icon worker stopped')); this.pending.delete(id); }
        };
        timer = setTimeout(page, 8000);
        port.post({ op: 'init', origin: W.location.origin });
      } catch { page(); }
    });
    return this.ready;
  },
  reply(result) {
    if (!result?.id) return;
    const pending = this.pending.get(result.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(result.id);
    result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error || 'Icon unavailable'));
  },
  async request(path, op = 'blob') {
    const port = await this.boot();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Icon request timed out')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      port.post({ id, op, path });
    });
  },
  url(path) {
    if (!path) return Promise.resolve('');
    if (this.urls.has(path)) return this.urls.get(path);
    if ((this.failures.get(path) || 0) > now()) return Promise.resolve('');
    const result = this.request(path).then(blob => { this.failures.delete(path); return URL.createObjectURL(blob); }, error => {
      this.urls.delete(path); this.failures.set(path, now() + 30000);
      Log.warn('Skill icon unavailable: ' + path + ' (' + error.message + ')');
      return '';
    });
    this.urls.set(path, result);
    return result;
  },
  paint(node, icon, attempt = 0) {
    const path = this.iconPath(icon);
    node.dataset.iconPath = path;
    if (!path) return;
    this.url(path).then(url => {
      if (node.dataset.iconPath !== path || !node.isConnected) return;
      if (url) {
        const image = document.createElement('img'); image.alt = ''; image.draggable = false;
        image.src = url; image.addEventListener('load', () => { node.dataset.iconLoaded = 'true'; });
        node.prepend(image);
      } else if (attempt < 2) setTimeout(() => { if (node.isConnected) this.paint(node, icon, attempt + 1); }, 31000);
    });
  },
};
