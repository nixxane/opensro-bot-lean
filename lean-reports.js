// Manual reports only. No startup requests, saved drafts, or automatic retries.
// A rate-limit wait outlives the page: stored as a wall-clock deadline, converted to this page's clock on load.
const REPORT_COOLDOWN_SAVED = Number(Store.get('reportCooldown', 0)) || 0;
const Reports = {
  endpoint: 'https://nixbot.nixxane.workers.dev/report',
  draft: null, sending: false, capturing: false, stream: null,
  cooldownUntil: REPORT_COOLDOWN_SAVED > Date.now() ? now() + REPORT_COOLDOWN_SAVED - Date.now() : 0,
  open() {
    if (this.sending || this.capturing) return;
    if (!this.draft) this.draft = { base: JSON.parse(Diagnostics.report()), description: '', image: null, url: '', sent: false };
    UI.showReport();
    this.render();
  },
  text() {
    if (!this.draft) return '';
    return JSON.stringify({ ...this.draft.base, ...(this.draft.description ? { description: this.draft.description } : {}) }, null, 2);
  },
  describe(value) {
    if (!this.draft || this.sending || this.draft.sent) return;
    this.draft.description = String(value).slice(0, 1000);
    this.render();
  },
  notice(text) { if (UI.reportStatus) UI.reportStatus.textContent = text; },
  render() {
    if (!UI.reportBox || !this.draft) return;
    UI.reportText.value = this.text();
    UI.reportDescription.disabled = this.sending || this.draft.sent;
    UI.reportCapture.disabled = this.sending || this.capturing || this.draft.sent;
    UI.reportRemove.disabled = this.sending || this.capturing || !this.draft.image || this.draft.sent;
    UI.reportSend.disabled = this.sending || this.capturing || this.draft.sent || now() < this.cooldownUntil;
    UI.reportSend.textContent = this.sending ? 'Sending…' : this.draft.sent ? 'Report sent' : now() < this.cooldownUntil ? 'Wait ' + Math.ceil((this.cooldownUntil - now()) / 1000) + 's' : 'Send to developer';
    UI.reportClose.disabled = this.sending;
    UI.reportImage.hidden = !this.draft.url;
    if (this.draft.url) UI.reportImage.src = this.draft.url;
    else UI.reportImage.removeAttribute('src');
  },
  removeImage() {
    if (!this.draft || this.sending || this.draft.sent) return;
    if (this.draft.url) URL.revokeObjectURL(this.draft.url);
    this.draft.image = null; this.draft.url = '';
    this.render();
  },
  close() {
    if (this.sending) return;
    if (this.draft?.url) URL.revokeObjectURL(this.draft.url);
    this.draft = null;
    this.stream?.getTracks().forEach(track => track.stop());
    if (UI.reportImage) UI.reportImage.removeAttribute('src');
    if (UI.reportText) UI.reportText.value = '';
    if (UI.reportDescription) UI.reportDescription.value = '';
    if (UI.reportBox) UI.reportBox.hidden = true;
  },
  async frame(stream) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    let timer, frameId;
    try {
      const blob = await Promise.race([
        (async () => {
          await video.play();
          if (video.requestVideoFrameCallback) await new Promise(resolve => { frameId = video.requestVideoFrameCallback(resolve); });
          if (!video.videoWidth || !video.videoHeight) throw Error('empty frame');
          const scale = Math.min(1, 1280 / video.videoWidth, 1280 / video.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('capture timeout')), 10000); })
      ]);
      if (!blob || !['image/jpeg', 'image/png'].includes(blob.type) || blob.size > 2 * 1024 * 1024 || !blob.size) throw Error('invalid capture');
      return blob;
    } finally {
      clearTimeout(timer);
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      video.pause(); video.srcObject = null;
    }
  },
  async capture() {
    if (!this.draft || this.sending || this.capturing || this.draft.sent) return;
    if (!W.navigator?.mediaDevices?.getDisplayMedia) { this.notice('Screenshot capture is unavailable in this browser. You can send diagnostics alone.'); return; }
    const draft = this.draft;
    let stream;
    this.capturing = true; this.render();
    this.notice('Choose the game tab or window in the browser picker.');
    try {
      // Invoked directly from a click; every capture asks for fresh browser permission.
      stream = await W.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
      if (this.draft !== draft) return;
      this.stream = stream;
      const image = await this.frame(stream);
      if (this.draft !== draft) return;
      this.removeImage();
      draft.image = image; draft.url = URL.createObjectURL(image);
      this.notice('Screenshot captured. Review it below; remove it if it shows anything private.');
    } catch {
      if (this.draft === draft) this.notice('Screenshot cancelled or unavailable. Nothing was uploaded; diagnostics can still be sent.');
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (this.stream === stream) this.stream = null;
      this.capturing = false; this.render();
    }
  },
  async send() {
    if (!this.draft || this.sending || this.capturing || this.draft.sent || now() < this.cooldownUntil) return;
    const text = this.text();
    if (new Blob([text]).size > 128 * 1024) { this.notice('Report is too large. Remove the screenshot or shorten the explanation.'); return; }
    const body = new FormData(); body.append('report', text);
    if (this.draft.image) body.append('screenshot', this.draft.image, this.draft.image.type === 'image/png' ? 'screenshot.png' : 'screenshot.jpg');
    this.sending = true; this.render(); this.notice('Sending report…');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await W.fetch(this.endpoint, { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After'));
        this.cooldownUntil = now() + (Number.isFinite(seconds) && seconds > 0 ? clamp(seconds, 1, 3600) : 60) * 1000;
        Store.set('reportCooldown', Date.now() + this.cooldownUntil - now());
        this.notice('Too many reports. Wait before trying again.');
      } else if (response.ok && (await response.json()).ok === true) {
        this.draft.sent = true;
        if (this.draft.url) URL.revokeObjectURL(this.draft.url);
        this.draft.image = null; this.draft.url = '';
        this.notice('Report sent to the developer’s Discord. Thank you.');
      } else if (response.status === 400 || response.status === 413) {
        this.notice('Report rejected. Remove the screenshot and try again.');
      } else if (response.status === 403 || response.status === 503) {
        this.notice('Reporting is unavailable right now. Try again later.');
      } else {
        this.notice('Delivery could not be confirmed. Check with the developer before sending again.');
      }
    } catch {
      this.notice('Delivery could not be confirmed. Check with the developer before sending again.');
    } finally {
      clearTimeout(timer); this.sending = false; this.render();
    }
  },
};
