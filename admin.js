/* ===== Chow Mission — manager dashboard ===== */
(() => {
  "use strict";
  const $ = s => document.querySelector(s);

  // Builds elements with textContent only, so customer text can never run as HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const STATUS = { unpaid: "Awaiting payment", new: "New", preparing: "Preparing", ready: "Ready", completed: "Completed", cancelled: "Cancelled" };
  const NEXT = { new: ["preparing", "Start preparing"], preparing: ["ready", "Mark ready"], ready: ["completed", "Mark completed"] };
  const FILTERS = [["active", "Active"], ["unpaid", "Awaiting payment"], ["preorders", "Pre-orders"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["all", "All"]];
  const MATCH = {
    active: o => ["new", "preparing", "ready"].includes(o.status),
    unpaid: o => o.status === "unpaid",
    preorders: o => o.when === "preorder" && o.status !== "cancelled",
    completed: o => o.status === "completed",
    cancelled: o => o.status === "cancelled",
    all: () => true
  };

  let db, orders = [], messages = [], taken = 0;
  let filter = "active", tab = "orders", seen = null, audio = null;   // seen: order ref -> status last time
  let stopOrders = null, stopMessages = null;

  const money = n => "R" + Number(n || 0).toFixed(0);
  const fmtTime = ms => new Date(ms).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  function fmtWhen(o) {
    if (o.when !== "preorder") return "As soon as possible";
    const d = new Date(o.date + "T00:00:00");
    const day = isNaN(d) ? o.date : d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
    return "PRE-ORDER: " + day + " at " + o.time;
  }

  /* ---------- sound ---------- */
  function unlockAudio() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch {}
  }
  function beep() {
    if (!$("#sound").checked) return;
    try {
      unlockAudio();
      const o = audio.createOscillator(), g = audio.createGain();
      o.connect(g); g.connect(audio.destination);
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.7);
      o.start(); o.stop(audio.currentTime + 0.7);
    } catch {}
  }

  /* ---------- start up ---------- */
  const ready = window.ChowDB ? Promise.resolve(window.ChowDB)
    : new Promise(res => window.addEventListener("chowdb-ready", () => res(window.ChowDB), { once: true }));
  ready.then(init);

  function init(d) {
    db = d;
    $("#loading").classList.add("hidden");
    const banner = $("#mode-banner");
    if (db.mode === "demo") {
      banner.textContent = "TEST MODE: this page was opened straight from a folder, so there is no server. Orders are saved in this browser only. Start the server (see README.txt) for real orders.";
      banner.classList.remove("hidden");
      $("#demo-hint").textContent = "Test mode: type any username, and the password is demo.";
    }
    db.onAuth(user => (user ? showDash() : showLogin()));
  }

  function showLogin() {
    stopWatching();
    $("#dash-view").classList.add("hidden");
    $("#admin-actions").classList.add("hidden");
    $("#login-view").classList.remove("hidden");
  }

  function showDash() {
    $("#login-view").classList.add("hidden");
    $("#dash-view").classList.remove("hidden");
    $("#admin-actions").classList.remove("hidden");
    stopWatching();
    seen = null;
    stopOrders = db.watchOrders(list => {
      orders = list;
      if (seen) {
        const fresh = list.filter(o => o.status === "new" && (!seen.has(o.ref) || seen.get(o.ref) === "unpaid"));
        if (fresh.length) beep();
      }
      seen = new Map(list.map(o => [o.ref, o.status]));
      $("#dash-error").textContent = "";
      if (typeof db.lastTaken === "number") taken = db.lastTaken; else refreshTaken();
      render();
    }, showError);
    stopMessages = db.watchMessages(list => { messages = list; render(); }, showError);
  }

  function stopWatching() {
    if (stopOrders) { stopOrders(); stopOrders = null; }
    if (stopMessages) { stopMessages(); stopMessages = null; }
  }

  function showError(err) {
    console.error(err);
    $("#dash-error").textContent = err && err.code === "offline"
      ? "Cannot reach the server. Check that it is running and that your internet is working. Trying again..."
      : "Could not load orders: " + (err && err.message ? err.message : "unknown problem");
  }

  async function refreshTaken() {
    try { const t = await db.getPreorderTaken(); if (t !== null && t !== taken) { taken = t; render(); } } catch {}
  }

  /* ---------- login / logout ---------- */
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    unlockAudio();
    const err = $("#login-error"); err.textContent = "";
    try {
      await db.login($("#username").value.trim(), $("#password").value);
      $("#password").value = "";
    } catch (ex) {
      err.textContent = ex && (ex.code === "offline" || ex.code === "rate") ? ex.message : "Wrong username or password.";
    }
  });
  $("#logout").addEventListener("click", () => db.logout());
  $("#sound").addEventListener("change", unlockAudio);

  /* ---------- actions ---------- */
  async function setStatus(o, status) {
    try { await db.setOrderStatus(o.ref, status); } catch (err) { showError(err); }
  }
  function printCard(card) {
    document.body.classList.add("printing"); card.classList.add("print-me");
    window.print();
    card.classList.remove("print-me"); document.body.classList.remove("printing");
  }
  async function newBatch() {
    if (!confirm("Start a new pre-order batch? The counter goes back to 0. Existing orders stay in the list.")) return;
    try { await db.newPreorderBatch(); taken = 0; render(); } catch (err) { showError(err); }
  }

  /* ---------- drawing ---------- */
  const line = (label, value) => h("div", {}, h("strong", {}, label + ": "), value);

  function payText(o) {
    if (o.payment === "Online") {
      if (o.payState === "paid") return "PAID online by card";
      if (o.payState === "pending") return "AWAITING ONLINE PAYMENT (not paid yet)";
      return "Online payment was not completed";
    }
    return "Pay on " + (o.type === "Delivery" ? "delivery" : "collection") + ": " + o.payment;
  }

  function orderCard(o) {
    const delivery = o.type === "Delivery";
    const actions = h("div", { class: "card-actions no-print" });
    if (o.payment === "Online" && o.payState !== "paid") {
      actions.append(h("button", { class: "btn small", type: "button", onclick: async () => {
        if (!confirm("Only do this if you have checked in PayFast that order " + o.ref + " was paid. Mark it as paid?")) return;
        try { await db.markPaid(o.ref); } catch (err) { showError(err); }
      } }, "Mark as paid"));
    }
    if (NEXT[o.status]) actions.append(h("button", { class: "btn small", type: "button", onclick: () => setStatus(o, NEXT[o.status][0]) }, NEXT[o.status][1]));
    if (o.status !== "completed" && o.status !== "cancelled") {
      actions.append(h("button", { class: "btn small ghost", type: "button", onclick: () => { if (confirm("Cancel order " + o.ref + "?")) setStatus(o, "cancelled"); } }, "Cancel order"));
    } else {
      actions.append(h("button", { class: "btn small ghost", type: "button", onclick: () => setStatus(o, "new") }, "Reopen"));
    }
    const card = h("article", { class: "order-card" + (o.status === "new" ? " is-new" : "") });
    actions.append(h("button", { class: "btn small ghost", type: "button", onclick: () => printCard(card) }, "Print"));
    card.append(...[
      h("div", { class: "order-head" },
        h("span", { class: "order-no" }, "#" + o.ref),
        h("span", {},
          h("span", { class: "badge dark" }, o.type), " ",
          o.when === "preorder" ? h("span", { class: "badge solid" }, "Pre-order") : null, " ",
          h("span", { class: "badge" + (o.status === "new" ? " solid" : "") }, STATUS[o.status] || o.status))),
      h("p", { class: "muted" }, "Received " + fmtTime(o.createdAtMs)),
      h("div", { class: "order-grid" },
        line("Customer", o.name),
        h("div", {}, h("strong", {}, "Phone: "), h("a", { href: "tel:" + String(o.phone).replace(/[^\d+]/g, "") }, o.phone)),
        line(delivery ? "Deliver to" : "Collection", delivery ? [o.address, o.suburb].filter(Boolean).join(", ") : "Customer collects at the shop"),
        line("When", fmtWhen(o)),
        line("Payment", payText(o))),
      h("ul", { class: "order-items" },
        (o.items || []).map(i => h("li", {}, h("span", {}, i.qty + " x " + i.name), h("span", {}, money(i.qty * i.price))))),
      h("div", { class: "order-total" },
        h("span", {}, "Subtotal " + money(o.subtotal) + (o.fee ? " + delivery " + money(o.fee) : "")),
        h("strong", {}, "Total " + money(o.total))),
      o.notes ? h("p", { class: "order-notes" }, h("strong", {}, "Notes: "), o.notes) : null,
      actions].filter(Boolean));
    return card;
  }

  function messageCard(m) {
    return h("article", { class: "order-card" },
      h("div", { class: "order-head" },
        h("span", { class: "order-no" }, m.name),
        h("span", { class: "muted" }, fmtTime(m.createdAtMs))),
      h("p", {}, h("strong", {}, "Contact: "), m.contact),
      h("p", { class: "order-notes" }, m.message),
      h("div", { class: "card-actions no-print" },
        h("button", { class: "btn small ghost", type: "button", onclick: async () => {
          if (!confirm("Delete this message?")) return;
          try { await db.deleteMessage(m.id); } catch (err) { showError(err); }
        } }, "Delete")));
  }

  function render() {
    if (!db) return;
    const newCount = orders.filter(o => o.status === "new").length;
    document.title = (newCount ? "(" + newCount + ") " : "") + "Manager | Chow Mission";

    const stat = (label, value, extra) => h("div", { class: "stat" }, h("span", {}, label), h("b", {}, value), extra);
    $("#stats").replaceChildren(
      stat("New orders", newCount),
      stat("Active orders", orders.filter(MATCH.active).length),
      stat("Pre-orders taken", taken + " / " + db.limit,
        h("button", { class: "linkbtn", type: "button", onclick: newBatch }, "Start new batch")),
      stat("Messages", messages.length));

    $("#tabs").replaceChildren(
      h("button", { class: "chip" + (tab === "orders" ? " on" : ""), type: "button", onclick: () => { tab = "orders"; render(); } }, "Orders"),
      h("button", { class: "chip" + (tab === "messages" ? " on" : ""), type: "button", onclick: () => { tab = "messages"; render(); } }, "Messages (" + messages.length + ")"));

    const filters = $("#filters");
    const list = $("#list");
    if (tab === "orders") {
      filters.classList.remove("hidden");
      filters.replaceChildren(...FILTERS.map(([key, label]) =>
        h("button", { class: "chip" + (filter === key ? " on" : ""), type: "button", onclick: () => { filter = key; render(); } },
          label + " (" + orders.filter(MATCH[key]).length + ")")));
      const shown = orders.filter(MATCH[filter]);
      list.replaceChildren(...(shown.length ? shown.map(orderCard) : [h("p", { class: "empty" }, "No orders here yet.")]));
    } else {
      filters.classList.add("hidden");
      list.replaceChildren(...(messages.length ? messages.map(messageCard) : [h("p", { class: "empty" }, "No messages.")]));
    }
  }
})();