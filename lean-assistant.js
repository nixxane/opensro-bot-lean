// Optional bridge to a player-run LLM server (LM Studio and friends, any OpenAI-compatible
// endpoint on the player's own machine). This first slice only remembers where that server
// listens and checks that it answers: the test asks for the models listing and nothing else,
// no request happens without the button press, and no game data leaves the page.
const Assistant = {
  // The page's fetch; tests replace this with a stub. Only ever called by probe().
  fetchImpl: typeof fetch === 'function' ? fetch : null,
  testing: false,
  // Collapse anything the player typed into a bare base address. The assistant stays
  // local: loopback, the private network ranges, or an mDNS name — a public host is
  // refused outright, so nothing can point the bot at someone else's server. Addresses
  // without a scheme are http, paths and queries are dropped, and credentials never
  // reach the stored settings.
  isLocalHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1') return true;
    if (/\.local$/.test(host)) return true;
    // The private ranges only ever match a complete dotted-quad literal: a public DNS
    // name such as 10.example.com or 127.attacker.net must not slip through a prefix.
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    const a = host.split('.').map(Number);
    if (a.some(n => n > 255)) return false;
    return a[0] === 127 || a[0] === 10 || (a[0] === 192 && a[1] === 168) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 169 && a[1] === 254);
  },
  base(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    // Another explicit scheme (ftp, ws…) can never serve a model; only http may be implied.
    if (!/^https?:\/\//i.test(value)) {
      if (/:\/\//i.test(value)) return '';
      value = 'http://' + value;
    }
    let url;
    try { url = new URL(value); } catch { return ''; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!this.isLocalHost(url.hostname)) return '';
    return url.protocol + '//' + url.host;
  },
  modelsUrl(base) { return base.replace(/\/+$/, '') + '/v1/models'; },
  async probe(rawEndpoint, timeoutMs = 5000) {
    const base = this.base(rawEndpoint);
    if (!base) return { ok: false, error: String(rawEndpoint || '').trim() ? 'The assistant only talks to this machine or your local network; public addresses are refused.' : 'Enter an endpoint address first.' };
    if (!this.fetchImpl) return { ok: false, error: 'This browser exposes no fetch; the assistant cannot connect.' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.modelsUrl(base), { signal: controller.signal });
      if (!response.ok) return { ok: false, error: 'The server answered with HTTP ' + response.status + '.' };
      const data = await response.json().catch(() => null);
      const models = Array.isArray(data?.data) ? data.data.map(m => String(m?.id || '')).filter(Boolean) : [];
      if (!models.length) return { ok: false, error: 'The endpoint answered, but listed no models — is it an OpenAI-compatible server?' };
      return { ok: true, base, models };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'No answer within ' + Math.round(timeoutMs / 1000) + ' s.' };
      // A plain http address on another machine is mixed content on this https page: the
      // browser blocks it even though it is on the local network, and the server must also
      // allow cross-origin requests. Both surface as a failed fetch here.
      return { ok: false, error: 'Could not reach the endpoint. The game page is https, so the browser blocks plain http on other machines: run the server on this machine, or forward its port to 127.0.0.1 (netsh interface portproxy), and allow cross-origin requests in it.' };
    } finally {
      clearTimeout(timer);
    }
  },
  modelNote(probe, configured) {
    if (!configured) return 'No model set; the server lists ' + probe.models.length + '.';
    return probe.models.includes(configured) ? 'Model "' + configured + '" is listed.' : 'Model "' + configured + '" is not listed; the server offers ' + probe.models.length + ' models.';
  },
  // Wired to the Settings page button; keeps the section free of request logic.
  async test(status, button) {
    if (this.testing) return;
    this.testing = true;
    button.disabled = true;
    status.textContent = 'Testing…';
    const A = Settings.profile.assistant;
    const result = await this.probe(A.endpoint);
    status.textContent = result.ok ? 'OK — ' + result.models.length + ' models. ' + this.modelNote(result, A.model.trim()) : result.error;
    this.testing = false;
    button.disabled = false;
  },
};
