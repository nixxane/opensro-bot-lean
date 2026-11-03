// Optional bridge to a player-run LLM server (LM Studio and friends, any OpenAI-compatible
// endpoint on the player's own machine). This first slice only remembers where that server
// listens and checks that it answers: the test asks for the models listing and nothing else,
// no request happens without the button press, and no game data leaves the page.
const Assistant = {
  // The page's fetch; tests replace this with a stub. Only ever called by probe().
  fetchImpl: typeof fetch === 'function' ? fetch : null,
  testing: false,
  // Collapse anything the player typed into a bare base address (scheme + host + port).
  // Addresses without a scheme are http, paths and queries are dropped, and credentials
  // never reach the stored settings.
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
    return url.protocol + '//' + url.host;
  },
  modelsUrl(base) { return base.replace(/\/+$/, '') + '/v1/models'; },
  async probe(rawEndpoint, timeoutMs = 5000) {
    const base = this.base(rawEndpoint);
    if (!base) return { ok: false, error: 'Enter an endpoint address first.' };
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
      // A plain http address on another machine is mixed content on this https page, and the
      // server must also allow cross-origin requests; both surface as a failed fetch here.
      return { ok: false, error: 'Could not reach the endpoint. Run the server on this machine (127.0.0.1) or serve it over https, and allow cross-origin requests in it.' };
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
