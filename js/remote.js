/*
 * Google Apps Script backend client (optional).
 * Reads use JSONP (a <script> tag), which works from file:// and is not blocked by third-party
 * cookie rules on the googleusercontent redirect. Writes use a text/plain POST (no CORS preflight).
 */
(function () {
  const LS_REMOTE = "npiGantt.remote.v1";
  const TIMEOUT_MS = 30000;
  // Built-in Apps Script web app URL (ending in /exec). When set, every page load starts in cloud mode
  // and the browser's local copy (last cloud snapshot or seed) is only a fallback while the cloud is unreachable.
  // Leave empty to default to local mode.
  const DEFAULT_URL = "https://script.google.com/macros/s/AKfycbz7EmhkOt6uxBDPmyvV1ric4cXfnBAWvZUCkNN4zOOA-HwOYY__6CdNsRjZWHsIUPDa/exec";

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_REMOTE) || "{}");
    } catch {
      /* unreadable settings: fall back to defaults */
    }
    const config = Object.assign({ url: "", key: "", enabled: false }, saved);
    if (DEFAULT_URL) {
      config.url = config.url || DEFAULT_URL;
      config.enabled = true; // switching to local mode only lasts until the next page load
    }
    return config;
  }

  const Remote = {
    config: loadConfig(),
    builtIn: !!DEFAULT_URL,

    saveConfig(patch) {
      Object.assign(this.config, patch);
      try {
        localStorage.setItem(LS_REMOTE, JSON.stringify(this.config));
      } catch {
        /* storage unavailable: config lives for this session only */
      }
    },

    get active() {
      return !!(this.config.enabled && this.config.url);
    },

    jsonp(params, url) {
      url = url || this.config.url;
      return new Promise((resolve, reject) => {
        const cb = "__npiCb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const qs = new URLSearchParams({ ...params, callback: cb, t: Date.now() });
        const script = document.createElement("script");
        const cleanup = () => {
          delete window[cb];
          script.remove();
          clearTimeout(timer);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("連線逾時：請確認 Apps Script 已部署為「所有人」可存取，且網址結尾是 /exec"));
        }, TIMEOUT_MS);
        window[cb] = (data) => {
          cleanup();
          resolve(data);
        };
        script.onerror = () => {
          cleanup();
          reject(new Error("無法連線到 Apps Script 網址"));
        };
        script.src = url + (url.includes("?") ? "&" : "?") + qs.toString();
        document.head.appendChild(script);
      });
    },

    async post(payload) {
      const body = JSON.stringify({ ...payload, key: this.config.key || "" });
      const res = await fetch(this.config.url, { method: "POST", body, redirect: "follow" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Apps Script 回傳格式錯誤：" + text.slice(0, 120));
      }
      if (!json.ok && !json.conflict) throw new Error(json.error || "Apps Script 回報錯誤");
      return json;
    },

    async ping(url) {
      const r = await this.jsonp({ action: "ping" }, url);
      if (!r || !r.ok) throw new Error((r && r.error) || "回應異常");
      return r;
    },

    async loadAll() {
      const r = await this.jsonp({ action: "bundle" });
      if (!r || !r.ok) throw new Error((r && r.error) || "讀取失敗");
      return r.data;
    },

    uploadAll(data) {
      return this.post({ action: "importAll", data });
    },

    savePfam(pfam, force) {
      const { tasks, _rev, ...meta } = pfam;
      return this.post({ action: "savePfam", pfam: meta, tasks, baseVersion: force ? null : pfam.version || 0 });
    },

    deletePfam(id) {
      return this.post({ action: "deletePfam", id });
    },

    saveCalendars(calendars) {
      return this.post({ action: "saveCalendars", calendars });
    },
  };

  window.Remote = Remote;
})();
