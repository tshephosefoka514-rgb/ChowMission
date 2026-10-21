/* ===== Chow Mission — customer-side script =====
   Orders and messages are saved through window.ChowDB (see db.js). */
const DELIVERY_FEE = 30;            // TODO: confirm real delivery fee with the kitchen
const PREORDER_DAYS = 14;           // how far ahead customers can pre-order
const PHONE_DISPLAY = "+27 78 312 1534";
// Link to the Chow Mission store page on Uber Eats. Open the store in the Uber Eats app or
// website, copy its link and paste it here. Set it to "" to hide every Uber Eats button.
const UBER_EATS_URL = "https://www.ubereats.com";
const CART_KEY = "chowMissionCart";

/* ---------- Menu data (single source of truth) ----------
   Server.java reads names and prices from this list, so keep every item in the
   same shape as the ones below (n = name, p = price) and restart the server after
   changing a price. */
const MENU = [
  { id: "smash", title: "American Smash", blurb: "Big, juicy smash-style burgers with bold flavours and seriously good toppings.",
    items: [{ n: "Beef Burger", p: 90 }, { n: "Chicken Burger", p: 80 }] },
  { id: "wings", title: "Wing Hub", blurb: "Juicy, crispy wings tossed in bold flavours.",
    items: [{ n: "Lemon Pepper Wings", p: 55 }, { n: "BBQ Wings", p: 55 }] },
  { id: "woods", title: "The Woods", blurb: "Pulled beef or shredded chicken.",
    items: [{ n: "Pulled Beef", p: 70 }, { n: "Shredded Chicken", p: 70 }] },
  { id: "fries", title: "Fry High", blurb: "Crispy golden fries.",
    items: [{ n: "Mini Shoestring Fries", p: 25 }, { n: "Large Shoestring Fries", p: 45 },
            { n: "Loaded Fries", p: 55 }, { n: "Nacho Fries", p: 65 }] },
  { id: "mains", title: "The Mains", blurb: "Proper comfort food, served with a carb and a side qoh.",
    items: [{ n: "Beef Stew", p: 89 }, { n: "Lamb Stew", p: 89 }, { n: "Chicken Curry", p: 89 }] },
  { id: "carbs", title: "The Carbs", blurb: "Pick your carb.",
    items: [{ n: "Pap", p: 25 }, { n: "Rice", p: 25 }, { n: "Samp", p: 25 }] },
  { id: "tacos", title: "Tacos", blurb: "Soft tortillas loaded with bold fillings.",
    items: [{ n: "Beef Tacos", p: 55 }, { n: "Chicken Tacos", p: 55 }] },
  { id: "sides", title: "Side Qoh", blurb: "Add a side to any meal.",
    items: [{ n: "Spinach", p: 15 }, { n: "Chakalaka", p: 15 }, { n: "Coleslaw", p: 15 },
            { n: "Butternut", p: 15 }, { n: "Fresh Green Salad", p: 35 }] },
  { id: "combos", title: "Chow For 2wo & Smash Feast", blurb: "Sharing combos.",
    items: [{ n: "Chow For 2wo", p: 300, d: "Mac & cheese, two single burgers, 8 wings & skinny fries" },
            { n: "Smash Feast", p: 220, d: "Smash burgers, 4 wings & skinny fries" }] },
  { id: "grill", title: "Off The Grill", blurb: "A South African braai plate.",
    items: [{ n: "Braai Plate – Grills", p: 175 }, { n: "Braai Plate – Wors", p: 175 }, { n: "Braai Plate – Chicken", p: 175 }] }
];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const ITEMS = {};
MENU.forEach(sec => sec.items.forEach(it => { it.id = slug(it.n); ITEMS[it.id] = it; }));
const money = n => "R" + n.toFixed(0);

/* ---------- Cart (localStorage with safe fallback) ---------- */
let memoryCart = {};
function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return memoryCart; }
}
function saveCart(c) {
  memoryCart = c;
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch {}
  updateCartCount();
}
function addToCart(id) {
  const c = getCart(); c[id] = (c[id] || 0) + 1; saveCart(c);
  toast(ITEMS[id].n + " added");
}
function changeQty(id, delta) {
  const c = getCart(); c[id] = (c[id] || 0) + delta;
  if (c[id] <= 0) delete c[id];
  saveCart(c);
}
const cartCount = () => Object.values(getCart()).reduce((a, b) => a + b, 0);
const cartSubtotal = () => Object.entries(getCart()).reduce((s, [id, q]) => s + (ITEMS[id] ? ITEMS[id].p * q : 0), 0);
function updateCartCount() {
  document.querySelectorAll("[data-cart-count]").forEach(el => el.textContent = cartCount());
}

/* ---------- UI helpers ---------- */
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
}
const setInvalid = (form, name, bad) => {
  const f = form.querySelector(`[data-field="${name}"]`);
  if (f) f.classList.toggle("invalid", bad);
};

/* ---------- Database access (db.js) ---------- */
function getDb(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (window.ChowDB) return resolve(window.ChowDB);
    const t = setTimeout(() => reject(new Error("The ordering system did not load.")), timeoutMs);
    window.addEventListener("chowdb-ready", () => { clearTimeout(t); resolve(window.ChowDB); }, { once: true });
  });
}
function friendlyError(err) {
  if (err && ["full", "invalid", "rate"].includes(err.code)) return err.message;
  return "We could not send that right now. Please try again, or call us on " + PHONE_DISPLAY + ".";
}

let preorderLeft = null;   // null = unknown
async function refreshPreorder() {
  const els = document.querySelectorAll("[data-preorder-left]");
  const demoNotes = document.querySelectorAll("[data-demo-note]");
  if (!els.length && !demoNotes.length && !document.getElementById("when")) return;
  let db = null;
  try {
    db = await getDb();
    const taken = await db.getPreorderTaken();
    preorderLeft = taken === null ? null : Math.max(0, db.limit - taken);
  } catch { preorderLeft = null; }
  const limit = db ? db.limit : 40;
  els.forEach(el => {
    el.textContent = preorderLeft === null ? `Limited to ${limit} pre-orders.`
      : preorderLeft > 0 ? `Limited to ${limit} pre-orders. ${preorderLeft} spot${preorderLeft === 1 ? "" : "s"} left.`
      : "Pre-orders are full.";
  });
  demoNotes.forEach(el => el.classList.toggle("hidden", !(db && db.mode === "demo")));
  const sel = document.getElementById("when");
  if (sel) {
    const opt = sel.querySelector('option[value="preorder"]');
    if (preorderLeft === 0) { opt.disabled = true; opt.textContent = "Pre-order (full)"; if (sel.value === "preorder") sel.value = "asap"; sel.dispatchEvent(new Event("change")); }
  }
}

/* ---------- Page start ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.querySelector(".menu-toggle"), links = document.querySelector(".nav-links");
  if (btn) btn.addEventListener("click", () => {
    const open = links.classList.toggle("open"); btn.setAttribute("aria-expanded", open);
  });
  document.querySelectorAll("[data-year]").forEach(el => el.textContent = new Date().getFullYear());
  document.querySelectorAll("[data-uber]").forEach(a => {
    if (!UBER_EATS_URL) { (a.closest("[data-uber-wrap]") || a).classList.add("hidden"); return; }
    a.href = UBER_EATS_URL; a.target = "_blank"; a.rel = "noopener";
  });
  updateCartCount();
  renderMenuPage();
  renderFeatured();
  initOrderPage();
  initContactForm();
  refreshPreorder();
});

/* ---------- Menu page ---------- */
function renderMenuPage() {
  const root = document.getElementById("menu-root");
  if (!root) return;
  root.innerHTML = MENU.map(sec => `
    <section class="menu-card" id="${sec.id}">
      <h3>${sec.title}</h3>
      <p class="blurb">${sec.blurb}</p>
      ${sec.items.map(it => `
        <div class="menu-item">
          <span class="name">${it.n}${it.d ? `<span class="desc">${it.d}</span>` : ""}</span>
          <span class="price">${money(it.p)}</span>
          <button class="btn small" data-add="${it.id}" aria-label="Add ${it.n} to order">Add</button>
        </div>`).join("")}
    </section>`).join("");
  root.addEventListener("click", e => {
    const b = e.target.closest("[data-add]"); if (b) addToCart(b.dataset.add);
  });
}

/* ---------- Home page featured items ---------- */
function renderFeatured() {
  const root = document.getElementById("featured");
  if (!root) return;
  const ids = ["beef-burger", "lemon-pepper-wings", "smash-feast", "chow-for-2wo", "beef-stew", "loaded-fries"];
  root.innerHTML = ids.map(id => { const it = ITEMS[id]; return `
    <article class="card">
      <h3>${it.n}</h3>
      <p>${it.d || "A Chow Mission favourite."}</p>
      <p style="display:flex;justify-content:space-between;align-items:center;margin-top:14px">
        <span class="price">${money(it.p)}</span>
        <button class="btn small" data-add="${id}">Add to order</button>
      </p>
    </article>`; }).join("");
  root.addEventListener("click", e => { const b = e.target.closest("[data-add]"); if (b) addToCart(b.dataset.add); });
}

/* ---------- Order page ---------- */
function initOrderPage() {
  const root = document.getElementById("order-root");
  if (!root) return;
  const lines = document.getElementById("cart-lines"), totals = document.getElementById("totals");
  const form = document.getElementById("order-form");
  const modeInputs = form.querySelectorAll('input[name="mode"]');
  const addrBlock = document.getElementById("address-block");
  const placeBtn = document.getElementById("place-order");
  const errBox = document.getElementById("order-error");
  const mode = () => form.querySelector('input[name="mode"]:checked').value;
  const orderLayout = document.getElementById("order-layout");

  function render() {
    const c = getCart(), ids = Object.keys(c).filter(id => ITEMS[id]);
    lines.innerHTML = ids.length ? ids.map(id => `
      <div class="cart-line">
        <div class="info">${ITEMS[id].n}<small>${money(ITEMS[id].p)} each</small></div>
        <div class="qty">
          <button type="button" data-dec="${id}" aria-label="Remove one ${ITEMS[id].n}">−</button>
          <strong>${c[id]}</strong>
          <button type="button" data-inc="${id}" aria-label="Add one ${ITEMS[id].n}">+</button>
        </div>
        <strong>${money(ITEMS[id].p * c[id])}</strong>
      </div>`).join("") : `<p class="empty">Your order is empty. <a href="menu.html">Browse the menu</a> or tap a quick-add below.</p>`;
    const delivery = mode() === "Delivery", sub = cartSubtotal(), fee = delivery && sub ? DELIVERY_FEE : 0;
    totals.innerHTML = `
      <div><span>Subtotal</span><span>${money(sub)}</span></div>
      <div><span>${delivery ? "Delivery fee" : "Collection"}</span><span>${delivery ? money(fee) : "Free"}</span></div>
      <div class="grand"><span>Total</span><span>${money(sub + fee)}</span></div>`;
    addrBlock.classList.toggle("hidden", !delivery);
    document.getElementById("collect-note").classList.toggle("hidden", delivery);
    document.getElementById("time-label").textContent = delivery ? "Delivery timing" : "Collection timing";
    updateCartCount();
  }

  lines.addEventListener("click", e => {
    const inc = e.target.closest("[data-inc]"), dec = e.target.closest("[data-dec]");
    if (inc) changeQty(inc.dataset.inc, 1);
    if (dec) changeQty(dec.dataset.dec, -1);
    render();
  });
  document.getElementById("quick-add").addEventListener("click", e => {
    const b = e.target.closest("[data-add]"); if (b) { addToCart(b.dataset.add); render(); }
  });
  modeInputs.forEach(i => i.addEventListener("change", render));

  // pre-order toggle + date limits (today up to PREORDER_DAYS ahead)
  const when = document.getElementById("when"), preBlock = document.getElementById("preorder-block");
  const dateInput = document.getElementById("date");
  const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const today = new Date(), max = new Date(); max.setDate(max.getDate() + PREORDER_DAYS);
  dateInput.min = iso(today); dateInput.max = iso(max);
  const showPre = () => preBlock.classList.toggle("hidden", when.value !== "preorder");
  when.addEventListener("change", showPre);
  if (new URLSearchParams(location.search).get("preorder") === "1") when.value = "preorder";
  showPre();

  form.addEventListener("submit", async e => {
    e.preventDefault();
    errBox.textContent = "";
    const d = Object.fromEntries(new FormData(form)), delivery = d.mode === "Delivery";
    const pre = d.when === "preorder";
    const okName = d.name.trim().length >= 2;
    const okPhone = /^(\+?27|0)\d{9}$/.test(d.phone.replace(/[\s-]/g, ""));
    const okAddr = !delivery || d.address.trim().length >= 6;
    const okDate = !pre || (!!d.date && d.date >= dateInput.min && d.date <= dateInput.max);
    const okTime = !pre || !!d.time;
    setInvalid(form, "name", !okName); setInvalid(form, "phone", !okPhone); setInvalid(form, "address", !okAddr);
    setInvalid(form, "date", !okDate); setInvalid(form, "time", !okTime);
    if (!cartCount()) { toast("Add something to your order first"); return; }
    if (!(okName && okPhone && okAddr && okDate && okTime)) { toast("Please fix the highlighted fields"); return; }
    if (d.website) { return; }   // hidden spam trap: real people never fill this in

    const c = getCart(), sub = cartSubtotal(), fee = delivery ? DELIVERY_FEE : 0;
    const order = {
      type: d.mode,
      name: d.name.trim().slice(0, 80),
      phone: d.phone.trim().slice(0, 20),
      address: delivery ? d.address.trim().slice(0, 200) : "",
      suburb: delivery ? (d.suburb || "").trim().slice(0, 80) : "",
      when: pre ? "preorder" : "asap",
      date: pre ? d.date : "",
      time: pre ? d.time : "",
      payment: d.payment,
      notes: (d.notes || "").trim().slice(0, 500),
      items: Object.keys(c).filter(id => ITEMS[id]).map(id => ({ id, name: ITEMS[id].n, qty: c[id], price: ITEMS[id].p })),
      subtotal: sub, fee, total: sub + fee
    };

    placeBtn.disabled = true; placeBtn.textContent = "Sending...";
    let leaving = false;
    try {
      const db = await getDb();
      const res = await db.placeOrder(order);
      if (res && res.pay) {       // online payment: hand over to the PayFast page, keep the cart until it is paid
        leaving = true;
        placeBtn.textContent = "Taking you to the payment page...";
        goToPayFast(res.pay);
        return;
      }
      const ref = typeof res === "string" ? res : res.ref;
      saveCart({});
      showConfirmation(ref, order, db.mode);
    } catch (err) {
      console.error(err);
      errBox.textContent = friendlyError(err);
      if (err && err.code === "full") refreshPreorder();
    } finally {
      if (!leaving) { placeBtn.disabled = false; placeBtn.textContent = "Place order"; }
    }
  });

  document.getElementById("order-again").addEventListener("click", () => location.reload());
  render();
  setupOnlinePayment(form);
  handlePaymentReturn(errBox, orderLayout);
}

/* ---------- Online card payment (only offered when the server has PayFast switched on) ---------- */
async function setupOnlinePayment(form) {
  try {
    const db = await getDb();
    if (!db.getPaymentConfig) return;
    const cfg = await db.getPaymentConfig();
    if (!cfg || !cfg.online) return;
    const sel = form.querySelector("#payment");
    const opt = document.createElement("option");
    opt.value = "Online"; opt.textContent = "Pay by card online now (secure)";
    sel.prepend(opt); sel.value = "Online";
    document.getElementById("pay-note").textContent = cfg.sandbox
      ? "TEST SYSTEM: online payments are in test mode, so no real money is taken."
      : "Card payments are handled on the secure PayFast page. We never see or store your card details.";
  } catch (e) { /* no online payment: the other options still work */ }
}

function goToPayFast(pay) {
  const f = document.createElement("form");
  f.method = "POST"; f.action = pay.url;
  Object.entries(pay.fields).forEach(([k, v]) => {
    const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; f.appendChild(i);
  });
  document.body.appendChild(f);
  f.submit();
}

/** The customer lands back on order.html?paid=REF or ?cancelled=REF after the PayFast page. */
async function handlePaymentReturn(errBox, orderLayout) {
  const params = new URLSearchParams(location.search);
  const paidRef = params.get("paid"), cancelledRef = params.get("cancelled");
  if (cancelledRef) {
    errBox.textContent = "Your payment was cancelled, so order " + cancelledRef + " was not sent to the kitchen. Your items are still here if you want to try again.";
    return;
  }
  if (!paidRef) return;
  const ref = paidRef.replace(/[^A-Za-z0-9-]/g, "").slice(0, 20);
  orderLayout.classList.add("hidden");
  const box = document.getElementById("pay-return");
  const title = document.getElementById("pay-title"), text = document.getElementById("pay-text");
  box.classList.remove("hidden");
  title.textContent = "Checking your payment";
  text.textContent = "Order " + ref + ". Please wait a moment while the payment is confirmed.";
  const db = await getDb();
  for (let i = 0; i < 20; i++) {
    try {
      const st = await db.getPaymentStatus(ref);
      if (st && st.paid) {
        saveCart({});
        title.textContent = "Payment received";
        text.textContent = "Thank you. Order " + ref + " is paid and has gone to the kitchen. They will call you if anything needs confirming.";
        return;
      }
    } catch (e) { /* try again */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  title.textContent = "Waiting for confirmation";
  text.textContent = "Order " + ref + " has not been confirmed yet. If you paid, it can take a few minutes. " +
    "If it still does not show, call " + PHONE_DISPLAY + " and quote this order number.";
}

function showConfirmation(ref, o, mode) {
  document.getElementById("order-layout").classList.add("hidden");
  const box = document.getElementById("confirmation");
  box.classList.remove("hidden");
  document.getElementById("conf-number").textContent = ref;
  const where = o.type === "Delivery" ? "We will deliver to " + o.address + "." : "Collect at 12 Main Road, Mellville.";
  const whenText = o.when === "preorder" ? "Pre-order for " + o.date + " at " + o.time + "." : "We are preparing it now.";
  document.getElementById("conf-text").textContent =
    `${whenText} ${where} Total: ${money(o.total)} (pay on ${o.type === "Delivery" ? "delivery" : "collection"}: ${o.payment}). ` +
    `The kitchen will call ${o.phone} if anything needs confirming.`;
  document.getElementById("conf-demo").classList.toggle("hidden", mode !== "demo");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Contact form ---------- */
function initContactForm() {
  const form = document.getElementById("contact-form");
  if (!form) return;
  const done = document.getElementById("contact-done");
  const errBox = document.getElementById("contact-error");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    errBox.textContent = ""; done.classList.add("hidden");
    const d = Object.fromEntries(new FormData(form));
    const okName = d.name.trim().length >= 2, okContact = d.contact.trim().length >= 5, okMsg = d.message.trim().length >= 5;
    setInvalid(form, "name", !okName); setInvalid(form, "contact", !okContact); setInvalid(form, "message", !okMsg);
    if (!(okName && okContact && okMsg)) { toast("Please fill in all fields"); return; }
    if (d.website) { return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = "Sending...";
    try {
      const db = await getDb();
      await db.sendMessage({ name: d.name.trim().slice(0, 80), contact: d.contact.trim().slice(0, 80), message: d.message.trim().slice(0, 1000) });
      form.reset(); done.classList.remove("hidden");
    } catch (err) {
      console.error(err); errBox.textContent = friendlyError(err);
    } finally { btn.disabled = false; btn.textContent = "Send message"; }
  });
}