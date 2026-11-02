/* ===== Chow Mission - order tracking page ===== */
(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const form = $("#track-form");
  if (!form) return;
  let timer = null;

  function stepsFor(type) {
    return type === "Delivery"
      ? ["Order received", "Being prepared", "On its way", "Delivered"]
      : ["Order received", "Being prepared", "Ready for collection", "Collected"];
  }
  function stepIndex(o) {
    if (o.status === "unpaid") return -1;
    if (o.status === "new") return 0;
    if (o.status === "preparing") return 1;
    if (o.status === "ready" || o.status === "ontheway") return 2;
    if (o.status === "completed") return 3;
    return -1;
  }
  function message(o) {
    const delivery = o.type === "Delivery";
    const pre = o.when === "preorder" ? " This is a pre-order for " + o.date + " at " + o.time + "." : "";
    switch (o.status) {
      case "unpaid": return ["Waiting for your payment", "Your order is held until the card payment is confirmed. Orders that are not paid within 30 minutes are cancelled." + pre];
      case "new": return ["We have received your order", "The kitchen has your order and will start preparing it." + pre];
      case "preparing": return ["Your order is being prepared", "The kitchen is cooking your food now." + pre];
      case "ready": return delivery
        ? ["Your order is ready", "It is packed and will be on its way shortly."]
        : ["Your order is ready for collection", "Collect it at 12 Main Road, Mellville."];
      case "ontheway": return ["Your order is on its way", "Our driver is bringing your food. Keep your phone close in case we call."];
      case "completed": return [delivery ? "Your order was delivered" : "Your order was collected", "Thank you for ordering from Chow Mission."];
      case "cancelled": return ["This order was cancelled", "If you did not expect this, please call us on " + (window.PHONE_DISPLAY || "+27 78 312 1534") + "."];
      default: return ["Order " + o.ref, ""];
    }
  }

  function show(o) {
    const [title, text] = message(o);
    $("#track-title").textContent = title + " (" + o.ref + ")";
    $("#track-text").textContent = text;
    const list = $("#track-steps");
    list.replaceChildren();
    if (o.status !== "cancelled") {
      const now = stepIndex(o);
      stepsFor(o.type).forEach((label, i) => {
        const li = document.createElement("li");
        li.textContent = label;
        if (i < now || (i === now && o.status === "completed")) li.className = "done";
        else if (i === now) li.className = "now";
        list.append(li);
      });
    }
    $("#track-updated").textContent = "Last checked " + new Date().toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) +
      (["completed", "cancelled"].includes(o.status) ? "." : ". This page updates by itself.");
    $("#track-result").classList.remove("hidden");
  }

  async function check(quiet) {
    clearTimeout(timer);
    const ref = $("#t-ref").value.trim(), phone = $("#t-phone").value.trim();
    const err = $("#track-error");
    if (!quiet) err.textContent = "";
    if (!ref || !phone) { if (!quiet) err.textContent = "Please enter your order number and phone number."; return; }
    try {
      const db = await new Promise(res => window.ChowDB ? res(window.ChowDB) : window.addEventListener("chowdb-ready", () => res(window.ChowDB), { once: true }));
      const o = await db.trackOrder(ref, phone);
      err.textContent = "";
      show(o);
      if (!["completed", "cancelled"].includes(o.status)) timer = setTimeout(() => check(true), 20000);
    } catch (e) {
      if (!quiet) { err.textContent = e && e.message ? e.message : "Could not check the order. Please try again."; $("#track-result").classList.add("hidden"); }
      else timer = setTimeout(() => check(true), 20000);
    }
  }

  form.addEventListener("submit", e => { e.preventDefault(); check(false); });

  // Fill in from the link (?ref=CM-0012) or from the last order placed on this device.
  const params = new URLSearchParams(location.search);
  let last = {};
  try { last = JSON.parse(localStorage.getItem("chowLastOrder")) || {}; } catch (e) { last = {}; }
  $("#t-ref").value = (params.get("ref") || last.ref || "").slice(0, 20);
  $("#t-phone").value = last.phone || "";
  if ($("#t-ref").value && $("#t-phone").value) check(false);
})();
