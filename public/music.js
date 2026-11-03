/* ===== Chow Mission - background music with a mute button =====
   Put your song at  public/music/song.mp3  (use a song you have the right to play: see README.txt).
   Browsers do not allow sound until the visitor touches the page, so the music starts on their first
   tap, click or key press. The Music button turns it off and on, and the choice is remembered. */
(() => {
  "use strict";
  const SRC = "music/song.mp3";
  const VOLUME = 0.35;                       // 0 (silent) to 1 (loud)
  const PREF = "chowMusicOff", POS = "chowMusicPos";
  const get = (s, k) => { try { return s.getItem(k); } catch (e) { return null; } };
  const set = (s, k, v) => { try { s.setItem(k, v); } catch (e) { /* private mode: fine */ } };

  const audio = new Audio();
  audio.src = SRC; audio.loop = true; audio.volume = VOLUME; audio.preload = "auto";

  const css = document.createElement("style");     // the button's look lives here, so no other file needs changing
  css.textContent = ".music-btn{position:fixed;left:16px;bottom:16px;z-index:60;background:#2a0f0d;color:#fff;border:3px solid #c8261e;" +
    "border-radius:999px;padding:8px 16px;font:600 .85rem 'Oswald',sans-serif;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;" +
    "box-shadow:0 3px 0 #9e1b15}.music-btn:hover{background:#c8261e}.music-btn:focus-visible{outline:3px solid #fde8e6;outline-offset:2px}" +
    ".music-btn.hidden{display:none}body.has-cookie-banner .music-btn{bottom:84px}@media print{.music-btn{display:none}}";
  document.head.appendChild(css);

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "music-btn hidden";
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(btn));
  if (document.body) document.body.appendChild(btn);

  let wantsMusic = get(localStorage, PREF) !== "1";   // on unless the visitor turned it off
  let playing = false;

  function label() {
    btn.textContent = playing ? "Music: On" : (wantsMusic ? "Play music" : "Music: Off");
    btn.setAttribute("aria-pressed", String(playing));
    btn.setAttribute("aria-label", playing ? "Mute the music" : "Play the music");
  }

  async function start() {
    if (!wantsMusic || playing) return;
    try {
      const pos = parseFloat(get(sessionStorage, POS));   // carry on from where the last page stopped
      if (pos > 0 && audio.duration && pos < audio.duration) audio.currentTime = pos;
      await audio.play();
      playing = true;
    } catch (e) { playing = false; }                      // blocked until the visitor touches the page
    label();
  }

  function stop() { audio.pause(); playing = false; label(); }

  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (playing) { wantsMusic = false; set(localStorage, PREF, "1"); stop(); }
    else { wantsMusic = true; set(localStorage, PREF, "0"); start(); }
  });

  // First touch anywhere starts the music (browsers require this).
  const unlock = () => { start(); if (playing) removeUnlock(); };
  const events = ["pointerdown", "keydown", "touchstart", "scroll"];
  const removeUnlock = () => events.forEach(ev => window.removeEventListener(ev, unlock, true));
  events.forEach(ev => window.addEventListener(ev, unlock, { capture: true, passive: true }));

  const save = () => { if (!audio.paused) set(sessionStorage, POS, String(audio.currentTime)); };
  setInterval(save, 1000);
  window.addEventListener("pagehide", save);

  // If there is no song file, hide the button so visitors never see a broken control.
  audio.addEventListener("error", () => { btn.remove(); removeUnlock(); });
  audio.addEventListener("loadedmetadata", () => { btn.classList.remove("hidden"); label(); start(); });
})();