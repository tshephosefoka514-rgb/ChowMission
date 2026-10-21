/* ===== Chow Mission — talks to the backend (Server.java) =====
   - Normal use: the page is served by Server.java, so orders go to the manager's dashboard.
   - If a page is opened straight from a folder (file://) there is no server, so it runs in
     TEST mode, where everything is saved in this browser only.
   Pages use it through window.ChowDB. */
(function () {
  const LIMIT_DEFAULT = 40;
  const codeError = (code, msg) => Object.assign(new Error(msg), { code });
  const makeRef = () => "CM-T" + Date.now().toString(36).slice(-4).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();

  /* ---------- TEST mode: everything lives in this browser ---------- */
  function demoBackend() {
    const K = { orders: "chowDemoOrders", msgs: "chowDemoMessages", pre: "chowDemoPre", auth: "chowDemoAuth" };
    const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
    const watchers = new Set(), authCbs = new Set();
    const notify = () => watchers.forEach(f => f());
    window.addEventListener("storage", notify);          // other tabs
    const user = () => (read(K.auth, null) ? { email: "manager" } : null);
    const watch = fn => { watchers.add(fn); fn(); return () => watchers.delete(fn); };
    const newestFirst = (a, b) => b.createdAtMs - a.createdAtMs;

    return {
      mode: "demo", limit: LIMIT_DEFAULT,
      async placeOrder(o) {
        const taken = read(K.pre, 0);
        if (o.when === "preorder" && taken >= LIMIT_DEFAULT) throw codeError("full", "Sorry, pre-orders are full.");
        const ref = makeRef();
        const list = read(K.orders, []);
        list.push({ ...o, ref, status: "new", createdAtMs: Date.now() });
        write(K.orders, list);
        if (o.when === "preorder") write(K.pre, taken + 1);
        notify();
        return ref;
      },
      async getPreorderTaken() { return read(K.pre, 0); },
      async getPaymentConfig() { return { online: false }; },     // no online payment in test mode
      async getPaymentStatus() { return { paid: false }; },
      async markPaid(ref) {
        write(K.orders, read(K.orders, []).map(o => (o.ref === ref ? { ...o, payState: "paid", status: o.status === "unpaid" ? "new" : o.status } : o))); notify();
      },
      async sendMessage(m) {
        const list = read(K.msgs, []);
        list.push({ ...m, id: makeRef(), createdAtMs: Date.now() });
        write(K.msgs, list); notify();
      },
      async login(email, pw) {
        if (pw !== "demo") throw codeError("auth", "Wrong password");
        write(K.auth, "manager"); authCbs.forEach(f => f(user()));
      },
      async logout() { try { localStorage.removeItem(K.auth); } catch {} authCbs.forEach(f => f(null)); },
      onAuth(cb) { authCbs.add(cb); cb(user()); },
      watchOrders(cb) { return watch(() => cb(read(K.orders, []).slice().sort(newestFirst))); },
      async setOrderStatus(ref, status) {
        write(K.orders, read(K.orders, []).map(o => (o.ref === ref ? { ...o, status } : o))); notify();
      },
      watchMessages(cb) { return watch(() => cb(read(K.msgs, []).slice().sort(newestFirst))); },
      async deleteMessage(id) { write(K.msgs, read(K.msgs, []).filter(m => m.id !== id)); notify(); },
      async newPreorderBatch() { write(K.pre, 0); notify(); }
    };
  }

  /* ---------- SERVER mode: the real backend ---------- */
  const TOKEN_KEY = "chowAdminToken";
  let memToken = "";
  const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || memToken; } catch { return memToken; } };
  const setToken = t => {
    memToken = t;
    try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {}
  };

  function serverBackend() {
    const authCbs = new Set(), pollers = new Set();
    const api = { mode: "server", limit: LIMIT_DEFAULT };

    async function call(path, opts = {}) {
      const headers = {};
      let body;
      if (opts.body) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(opts.body).toString();
      }
      if (opts.auth && getToken()) headers.Authorization = "Bearer " + getToken();
      let r;
      try { r = await fetch(path, { method: opts.method || "GET", headers, body, cache: "no-store" }); }
      catch { throw codeError("offline", "Cannot reach the server."); }
      let data = {};
      try { data = await r.json(); } catch {}
      if (r.status === 401 && opts.auth) { setToken(""); authCbs.forEach(f => f(null)); }
      if (!r.ok) throw codeError(data.code || "http-" + r.status, data.error || "Request failed (" + r.status + ")");
      return data;
    }

    // Checks the server every 5 seconds so new orders appear by themselves.
    function watch(path, pick, cb, onErr) {
      const p = { stopped: false, busy: false, again: false, timer: null };
      p.tick = async () => {
        if (p.stopped) return;
        if (p.busy) { p.again = true; return; }
        p.busy = true; clearTimeout(p.timer);
        try { cb(pick(await call(path, { auth: true }))); }
        catch (e) { if (!p.stopped && onErr) onErr(e); }
        p.busy = false;
        if (p.stopped) return;
        if (p.again) { p.again = false; return p.tick(); }
        p.timer = setTimeout(p.tick, 5000);
      };
      pollers.add(p); p.tick();
      return () => { p.stopped = true; clearTimeout(p.timer); pollers.delete(p); };
    }
    const refreshAll = () => pollers.forEach(p => p.tick());

    return Object.assign(api, {
      async placeOrder(o) {
        const d = await call("/api/orders", {
          method: "POST",
          body: {
            type: o.type, name: o.name, phone: o.phone, address: o.address, suburb: o.suburb,
            when: o.when, date: o.date, time: o.time, payment: o.payment, notes: o.notes,
            items: o.items.map(i => i.id + ":" + i.qty).join(",")
          }
        });
        return d.pay ? d : d.ref;     // with online payment the server also sends what to post to PayFast
      },
      async getPaymentConfig() { return call("/api/payment-config"); },
      async getPaymentStatus(ref) { return call("/api/payment-status?ref=" + encodeURIComponent(ref)); },
      async markPaid(ref) {
        await call("/api/admin/mark-paid", { method: "POST", auth: true, body: { ref } });
        refreshAll();
      },
      async getPreorderTaken() {
        const d = await call("/api/preorder-status");
        api.limit = d.limit;
        return d.taken;
      },
      async sendMessage(m) {
        await call("/api/messages", { method: "POST", body: { name: m.name, contact: m.contact, message: m.message } });
      },

      async login(email, pw) {
        const d = await call("/api/admin/login", { method: "POST", body: { password: pw } });
        setToken(d.token);
        authCbs.forEach(f => f({ email: "manager" }));
      },
      async logout() {
        try { await call("/api/admin/logout", { method: "POST", auth: true }); } catch {}
        setToken("");
        authCbs.forEach(f => f(null));
      },
      onAuth(cb) {
        authCbs.add(cb);
        if (!getToken()) return cb(null);
        call("/api/admin/me", { auth: true }).then(() => cb({ email: "manager" })).catch(() => cb(null));
      },
      watchOrders(cb, onErr) { return watch("/api/admin/orders", d => { api.limit = d.limit; api.lastTaken = d.taken; return d.orders; }, cb, onErr); },
      watchMessages(cb, onErr) { return watch("/api/admin/messages", d => d.messages, cb, onErr); },
      async setOrderStatus(ref, status) {
        await call("/api/admin/status", { method: "POST", auth: true, body: { ref, status } });
        refreshAll();
      },
      async deleteMessage(id) {
        await call("/api/admin/message-delete", { method: "POST", auth: true, body: { id } });
        refreshAll();
      },
      async newPreorderBatch() {
        await call("/api/admin/new-batch", { method: "POST", auth: true, body: {} });
        refreshAll();
      }
    });
  }

  window.ChowDB = location.protocol === "file:" ? demoBackend() : serverBackend();
  window.dispatchEvent(new Event("chowdb-ready"));
})();