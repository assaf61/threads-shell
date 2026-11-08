// The capture screen - the SAME collector as the capture tab in בית עלמא.
// 01/11/2026 (הכרעת אסף, oq-3c5a92ec8d18): "שניהם נשארים ושניהם מתפקדים בדיוק כמו
// הלוכד בתוך בית עלמא". This file is alma-home/capture.js (commit cf150e9) carried
// over: the open envelope, the + row, mic dictation, auto-seal after an hour, and
// triage-from-memory with a lock op. Map of what each collector did before:
// docs/CAPTURE-PARITY-2026-11-01.md.
// What stays from this app (nothing it already took in is dropped):
//   1. "שגר" and "נעל ותייק" go to the IndexedDB queue, not straight to Graph, so a
//      capture never fails offline or signed out. A lock is queued after its note.
//   2. Shared images/audio/video from the Android share menu enter the envelope as parts.
//   3. A sixth button, הדבק, reads the clipboard into the envelope.
// No demo mode here: this app has no sign-in gate to demo behind.
//
// 21/07 - "הלכידה הפתוחה" (הכרעת אסף): לכידה היא מעטפה אחת פתוחה. מתחילים מכל כיוון
// מוביל (טקסט/קול/תמונה/מיקום/לינק), מוסיפים פנימה עוד חלקים, וחותמים פעם אחת ("שגר").
// שכחת לחתום? אחרי שעה של שקט היא נחתמת לבדה ואסף פוגש אותה בנול.
// A capture is always a NEW unique file, never an edit of an existing one, so it can
// never fork (aligned with the single-writer cure).
import { getToken } from "./auth.js";
import * as Q from "./queue.js";
import { toast, withMic } from "./ui.js";
import { domains } from "./domains.js";

const pad = (n) => String(n).padStart(2, "0");
const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const URL_RE = /^https?:\/\/\S+$/;
const URL_ANY_RE = /https?:\/\/\S+/;

// Instant triage from memory (Assaf 24/06: the phone is a pipeline - capture fast,
// then route on the spot from memory, no waiting for the transcript). A lock here
// writes a single-writer op; enrich fills the transcript in async.
// הרשימה נטענת מ-alma-paths.json אחרי הזדהות (domains.js) ולא יושבת כאן.
const DOMES = () => domains().capture_domes;
const PRIOS = [["p1", "P1"], ["p2", "P2"], ["p3", "P3"]];
const domeLabel = (v) => (DOMES().find((d) => d[0] === v) || [, v])[1];
const idOf = (fileName) => { const m = fileName.match(/-([0-9a-z]{4})\.md$/); return m ? m[1] : fileName.replace(/\.md$/, ""); };
function nowStamp() { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }

function shortId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  const buf = new Uint8Array(4); crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % 36]).join("");
}
function device() { return /Android/i.test(navigator.userAgent) ? "android" : "desktop"; }

function extFromMime(type, fallbackName = "") {
  const map = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
    // 08/11/2026: a video shared from the phone (enrich.py VIDEO_EXT transcribes its speech)
    "video/mp4": "mp4", "video/quicktime": "mov", "video/3gpp": "3gp", "video/x-matroska": "mkv" };
  const base = (type || "").split(";")[0].trim();
  if (map[base]) return map[base];
  const m = fallbackName.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "bin";
}

// Same note grammar + frontmatter as alma-home, so the worker (enrich/distribute)
// treats both collectors identically. media is a LIST - the first (primary) lands in
// the `media:` key (the one enrich transcribes/analyzes); every part is embedded in
// the body so distribute moves them all with the thread.
function buildNote({ kind, text = "", mediaParts = [], sourceUrl = null }) {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stem = `${date}-${pad(d.getHours())}${pad(d.getMinutes())}-${kind}-${shortId()}`;
  const mediaNames = mediaParts.map((p, i) => `${stem}${i ? "-" + (i + 1) : ""}.${p.ext}`);
  const fm = ["---", "type: capture", `capture_kind: ${kind}`, "target_vault: alma-threads",
    "status: raw", `created: ${date}`, "owner: assaf", "tags: []", "enriched: false", `device: ${device()}`];
  if (sourceUrl) fm.push(`source_url: "${String(sourceUrl).replace(/["\n\r]/g, "")}"`);
  if (mediaNames.length) fm.push(`media: media/${mediaNames[0]}`);
  fm.push("---", "");
  let body = "";
  mediaNames.forEach((n) => { body += `![[media/${n}]]\n`; });
  if (mediaNames.length) body += "\n";
  if (sourceUrl) body += `${sourceUrl}\n\n`;
  if (text) body += `${text}\n`;
  if (!body) body = "\n";
  return { fileName: `${stem}.md`, mediaNames, content: fm.join("\n") + body };
}

// ---------- module state ----------
let recorder = null, recChunks = [], recTimerId = null, recStart = 0;
let onQueued = () => {};   // app.js: refresh the status chips and drain the queue

// Where a queued capture stands right now, said plainly (21/10: never "נקלט" when it
// cannot leave the phone).
async function sentNow() { return navigator.onLine ? !!(await getToken().catch(() => null)) : false; }
const whereItIs = () => (navigator.onLine ? "נשמר בטלפון ולא נשלח, צריך להתחבר" : "נשמר בטלפון, יישלח כשיחזור האינטרנט");

// ---------- the open capture (המעטפה הפתוחה) ----------
// capOpen holds everything until שגר. Text survives an app kill (localStorage);
// media blobs live in memory only - if the page dies before sealing, the text is
// sealed on the next visit and the media is honestly lost (v1 limitation).
const CAP_DRAFT_KEY = "open-capture-draft";
const AUTO_SEAL_MS = 60 * 60 * 1000;   // הכרעת אסף: שעה של שקט = נחתמת לבדה
let capOpen = null;
let sealTimerId = null;

function persistDraft() {
  try {
    if (capOpen && (capOpen.text || "").trim()) {
      localStorage.setItem(CAP_DRAFT_KEY, JSON.stringify({ startedAt: capOpen.startedAt, lastTouch: capOpen.lastTouch, text: capOpen.text }));
    } else if (!capOpen || !capOpen.media.length) {
      localStorage.removeItem(CAP_DRAFT_KEY);
    }
  } catch { /* storage blocked - non-fatal */ }
}
function touchDraft() { if (capOpen) { capOpen.lastTouch = Date.now(); persistDraft(); } }
function ensureOpen() {
  if (!capOpen) capOpen = { startedAt: Date.now(), lastTouch: Date.now(), text: "", media: [] };
  return capOpen;
}
function discardOpen() { capOpen = null; try { localStorage.removeItem(CAP_DRAFT_KEY); } catch {} closeSheet(); }
function restoreDraft() {
  if (capOpen) return;
  try {
    const raw = localStorage.getItem(CAP_DRAFT_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if ((d.text || "").trim()) capOpen = { startedAt: d.startedAt || Date.now(), lastTouch: d.lastTouch || Date.now(), text: d.text, media: [] };
  } catch { /* corrupt draft - ignore */ }
}
function capAge() { return capOpen ? Date.now() - (capOpen.lastTouch || capOpen.startedAt) : 0; }
function hasContent() { return !!(capOpen && ((capOpen.text || "").trim() || capOpen.media.length)); }

// auto-seal loop: checks every 5 minutes; also fired on load (stale draft from a
// killed page). The queue holds it, so unlike alma-home it does not wait for sign-in.
function armAutoSeal() {
  if (sealTimerId) return;
  sealTimerId = setInterval(() => { autoSealIfStale(); }, 5 * 60 * 1000);
}
async function autoSealIfStale() {
  if (!hasContent() || capAge() < AUTO_SEAL_MS) return;
  await sealCapture({ auto: true });
}

// ---------- overlay helpers (built on demand, removed on close) ----------
function removeOverlay(id) { const el = document.getElementById(id); if (el) el.remove(); }
function closeSheet() { removeOverlay("cap-sheet-wrap"); }

// The open envelope card. Every entry point lands here; additions join the SAME card.
function openCard(prefill = {}) {
  ensureOpen();
  if (prefill.text) { capOpen.text = (capOpen.text ? capOpen.text.replace(/\n+$/, "") + "\n" : "") + prefill.text; }
  if (prefill.media) capOpen.media.push(prefill.media);
  touchDraft();
  armAutoSeal();

  removeOverlay("cap-sheet-wrap");
  const wrap = mk("div", "cap-overlay"); wrap.id = "cap-sheet-wrap";
  const back = mk("div", "cap-backdrop");
  back.addEventListener("click", () => { closeSheet(); toast("הלכידה נשארת פתוחה · חזור אליה מתי שתרצה"); });
  const sheet = mk("div", "cap-sheet");

  sheet.appendChild(mk("div", "cap-sheet-title", "לכידה פתוחה"));
  const hint = mk("p", "hint", "הוסף פנימה מה שבא - הכל נחתם יחד ב\"שגר\". שכחת? אחרי שעה היא נחתמת לבדה ותפגוש אותה בנול.");
  sheet.appendChild(hint);

  // previews of every collected part
  const prev = mk("div", "cap-prev"); sheet.appendChild(prev);
  function renderPrev() {
    prev.innerHTML = "";
    capOpen.media.forEach((p, i) => {
      const row = mk("div", "cap-part");
      if ((p.type || "").startsWith("image/")) {
        const img = mk("img", "cap-prev-img"); img.src = URL.createObjectURL(p.blob); row.appendChild(img);
      } else if ((p.type || "").startsWith("audio/")) {
        const au = mk("audio", "cap-prev-audio"); au.controls = true; au.src = URL.createObjectURL(p.blob); row.appendChild(au);
      } else if ((p.type || "").startsWith("video/")) {
        const vi = mk("video", "cap-prev-img"); vi.controls = true; vi.preload = "metadata"; vi.src = URL.createObjectURL(p.blob); row.appendChild(vi);
      }
      const rm = mk("button", "btn-ghost cap-part-rm", "הסר"); rm.type = "button";
      rm.addEventListener("click", () => { capOpen.media.splice(i, 1); touchDraft(); renderPrev(); });
      row.appendChild(rm);
      prev.appendChild(row);
    });
  }
  renderPrev();

  const ta = mk("textarea", "cap-ta"); ta.id = "cap-ta";
  ta.placeholder = "כתוב, הדבק לינק, או הכתב במיקרופון…";
  ta.value = capOpen.text || "";
  ta.addEventListener("input", () => { capOpen.text = ta.value; touchDraft(); });
  // wvg4 (21/07): מיקרופון-הכתבה בחלון הלוכד.
  sheet.appendChild(withMic(ta));

  // + row: grow THIS capture from any direction
  const addRow = mk("div", "cap-addrow");
  const addBtn = (label, fn) => { const b = mk("button", "btn-ghost", label); b.type = "button"; b.addEventListener("click", fn); addRow.appendChild(b); };
  addBtn("+ הקלטה", () => startRec());
  addBtn("+ תמונה", () => pickPhoto());
  addBtn("+ מיקום", () => addLocation(ta));
  sheet.appendChild(addRow);

  const row = mk("div", "cap-sheet-row");
  const send = mk("button", "btn-primary", "שגר ✓"); send.type = "button";
  send.addEventListener("click", async () => {
    capOpen.text = ta.value;
    send.disabled = true; send.textContent = "שולח…";
    const ok = await sealCapture({});
    if (!ok) { send.disabled = false; send.textContent = "שגר ✓"; }
  });
  const drop = mk("button", "btn-ghost", "מחק"); drop.type = "button";
  drop.addEventListener("click", () => { discardOpen(); toast("הלכידה נמחקה"); });
  row.appendChild(send); row.appendChild(drop);
  sheet.appendChild(row);

  wrap.appendChild(back); wrap.appendChild(sheet);
  document.body.appendChild(wrap);
  if (!capOpen.media.length && !prefill.noFocus) setTimeout(() => ta.focus(), 50);
}

function mediaPart(blob, type, name) { return { blob, type, name: name || "part", ext: extFromMime(type, name || "") }; }
function addMedia(blob, type, name) {
  const part = mediaPart(blob, type, name);
  if (document.getElementById("cap-sheet-wrap")) { ensureOpen().media.push(part); touchDraft(); openCard({ noFocus: true }); }
  else openCard({ media: part, noFocus: true });
}

// ---------- location: a line inside the open envelope (8wnc + הלכידה הפתוחה) ----------
function addLocation(ta) {
  const put = (line) => {
    ensureOpen();
    capOpen.text = (ta && ta.value ? ta.value.replace(/\n+$/, "") + "\n" : (capOpen.text || "")) + line;
    if (ta) ta.value = capOpen.text;
    touchDraft();
    if (!ta) openCard({ noFocus: true });
  };
  if (!navigator.geolocation) { toast("מיקום לא נתמך במכשיר", "err"); return; }
  toast("מאתר מיקום…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const lat = latitude.toFixed(6), lng = longitude.toFixed(6);
      put(`📍 מיקום: ${lat}, ${lng} (±${Math.round(accuracy)} מ׳)\nhttps://maps.google.com/?q=${lat},${lng}\n`);
    },
    () => toast("אין גישה למיקום", "err"),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ---------- seal: one envelope -> one queued thread file (+ media parts) ----------
async function sealCapture({ auto = false }) {
  if (!hasContent()) { toast("אין מה לשלוח", "warn"); return false; }
  let text = (capOpen.text || "").trim();
  const media = capOpen.media.slice();

  // leading direction decides the kind; a lone URL (or URL + note) becomes a link
  let sourceUrl = null;
  const um = text.match(URL_ANY_RE);
  if (um) { sourceUrl = um[0]; if (URL_RE.test(text)) text = ""; }
  const audio = media.find((p) => (p.type || "").startsWith("audio/"));
  const kind = audio ? "voice" : media.length ? "photo" : sourceUrl ? "link" : "text";
  // primary media first (enrich transcribes/analyzes the `media:` key)
  media.sort((a, b) => (a === audio ? -1 : b === audio ? 1 : 0));
  if (sourceUrl && text) text = text.replace(sourceUrl, "").replace(/\n{3,}/g, "\n\n").trim();

  const note = buildNote({ kind, text, mediaParts: media, sourceUrl });

  try {
    // the queue uploads media first: a note that references missing media is a broken capture
    await Q.addCapture({ kind, fileName: note.fileName, content: note.content,
      media: media.map((p, i) => ({ name: note.mediaNames[i], type: p.type, blob: p.blob })) });
  } catch (e) {
    if (!auto) toast("לא נשמר בטלפון · " + (e.message || ""), "err");
    return false;
  }
  capOpen = null; try { localStorage.removeItem(CAP_DRAFT_KEY); } catch {}
  onQueued();
  if (auto) { closeSheet(); toast("הלכידה נחתמה לבדה אחרי שעה · תפגוש אותה בנול"); }
  else showTriage(note.fileName, await sentNow());   // hand straight to triage-from-memory
  return true;
}

// After send: hand straight to triage. Routing decision is captured at peak context
// (right after speaking, from memory), written as a single-writer lock op; the
// transcript catches up async. "אחר כך / במחשב" defers the drill-down to the cockpit.
function showTriage(fileName, sent) {
  const wrap = document.getElementById("cap-sheet-wrap");
  const sheet = wrap && wrap.querySelector(".cap-sheet");
  if (!sheet) { toast(sent ? "נקלט ✓" : whereItIs(), sent ? "ok" : "warn"); return; }
  sheet.innerHTML = "";
  sheet.appendChild(mk("div", "cap-sheet-title", (sent ? "נקלט ✓" : whereItIs()) + " · מיין מהזיכרון (או אחר כך במחשב)"));

  let dome = "alma-r", prio = "";
  sheet.appendChild(mk("div", "cap-flbl", "דום"));
  const domeWrap = mk("div", "cap-pills");
  DOMES().forEach(([v, l]) => {
    const b = mk("button", "cap-pill" + (v === dome ? " sel" : ""), l); b.type = "button";
    b.addEventListener("click", () => { domeWrap.querySelectorAll(".cap-pill").forEach((p) => p.classList.remove("sel")); b.classList.add("sel"); dome = v; });
    domeWrap.appendChild(b);
  });
  sheet.appendChild(domeWrap);

  sheet.appendChild(mk("div", "cap-flbl", "עדיפות"));
  const prioWrap = mk("div", "cap-pills");
  PRIOS.forEach(([v, l]) => {
    const b = mk("button", "cap-pill", l); b.type = "button";
    b.addEventListener("click", () => { const was = b.classList.contains("sel"); prioWrap.querySelectorAll(".cap-pill").forEach((p) => p.classList.remove("sel")); prio = was ? "" : v; if (!was) b.classList.add("sel"); });
    prioWrap.appendChild(b);
  });
  sheet.appendChild(prioWrap);

  const ta = mk("textarea", "cap-ta"); ta.placeholder = "הערה מהזיכרון (לא חובה)…"; ta.style.minHeight = "70px";
  // wvg4 (21/07): גם שדה הערת-הנעילה מקבל הכתבה קולית.
  sheet.appendChild(withMic(ta));

  const row = mk("div", "cap-sheet-row");
  const lock = mk("button", "btn-primary", "נעל ותייק"); lock.type = "button";
  lock.addEventListener("click", async () => {
    lock.disabled = true; lock.textContent = "נועל…";
    try {
      const id = idOf(fileName);
      const op = { op: "lock", thread: fileName, id, vault: dome, priority: prio, remark: ta.value || "", at: nowStamp() };
      const rand = Math.random().toString(36).slice(2, 8);
      // queued after its note, so the worker never meets a lock before the thread
      await Q.addCapture({ kind: "op", fileName: `_ops/op-${nowStamp().replace(/[^0-9]/g, "")}-${id}-${rand}.json`,
        content: JSON.stringify(op, null, 2), contentType: "application/json" });
      onQueued();
      closeSheet(); toast("נעול → " + domeLabel(dome) + " · יתויק בסבב הבא");
    } catch (e) { lock.disabled = false; lock.textContent = "נעל ותייק"; toast("נעילה נכשלה · " + (e.message || ""), "err"); }
  });
  const later = mk("button", "btn-ghost", "אחר כך / במחשב"); later.type = "button";
  later.addEventListener("click", () => { closeSheet(); toast(sent ? "נשלח ✓ · תמיין במחשב" : "נשמר בטלפון · תמיין במחשב"); });
  row.appendChild(lock); row.appendChild(later);
  sheet.appendChild(row);
}

// ---------- photo: camera / gallery chooser ----------
function pickPhoto() {
  removeOverlay("cap-photo-wrap");
  const wrap = mk("div", "cap-overlay"); wrap.id = "cap-photo-wrap";
  const back = mk("div", "cap-backdrop"); back.addEventListener("click", () => removeOverlay("cap-photo-wrap"));
  const menu = mk("div", "cap-menu");
  const cam = mk("input"); cam.type = "file"; cam.accept = "image/*"; cam.capture = "environment"; cam.hidden = true;
  const gal = mk("input"); gal.type = "file"; gal.accept = "image/*,video/*"; gal.hidden = true;
  const onPick = (e) => { const f = e.target.files && e.target.files[0]; removeOverlay("cap-photo-wrap"); if (f) addMedia(f, f.type, f.name); };
  cam.onchange = onPick; gal.onchange = onPick;
  const bCam = mk("button", "btn-primary", "📷 מצלמה"); bCam.type = "button"; bCam.addEventListener("click", () => cam.click());
  const bGal = mk("button", "btn-ghost", "🖼 גלריה"); bGal.type = "button"; bGal.addEventListener("click", () => gal.click());
  menu.appendChild(bCam); menu.appendChild(bGal); menu.appendChild(cam); menu.appendChild(gal);
  wrap.appendChild(back); wrap.appendChild(menu);
  document.body.appendChild(wrap);
}

// ---------- voice recording ----------
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    recChunks = [];
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimerId);
      removeOverlay("cap-rec-wrap");
      const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size > 0) addMedia(blob, blob.type, "rec.webm");
    };
    recorder.start();
    recStart = Date.now();

    const wrap = mk("div", "cap-overlay"); wrap.id = "cap-rec-wrap";
    const box = mk("div", "cap-rec");
    box.appendChild(mk("div", "cap-rec-dot"));
    const timer = mk("div", "cap-rec-timer", "0:00");
    box.appendChild(timer);
    const stop = mk("button", "btn-primary", "⏹ עצור"); stop.type = "button";
    stop.addEventListener("click", () => recorder && recorder.state !== "inactive" && recorder.stop());
    const cancel = mk("button", "btn-ghost", "בטל"); cancel.type = "button";
    cancel.addEventListener("click", () => {
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = () => { recorder.stream && recorder.stream.getTracks && recorder.stream.getTracks().forEach((t) => t.stop()); clearInterval(recTimerId); removeOverlay("cap-rec-wrap"); };
        recorder.stop();
      } else { removeOverlay("cap-rec-wrap"); }
    });
    box.appendChild(stop); box.appendChild(cancel);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    recTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  } catch (e) {
    toast("אין גישה למיקרופון", "err");
  }
}

// ---------- paste: the clipboard into the envelope (this app's הדבק, 11/06) ----------
async function pasteClip() {
  let text = "";
  try { text = await navigator.clipboard.readText(); } catch {}
  openCard(text ? { text } : {});
  if (!text) toast("הדבק לתוך תיבת הטקסט", "warn");
}

// ---------- incoming shares (Android share_target, stored by sw.js) ----------
// Same reading as alma-home's consumePendingShare: Instagram puts the URL in `text`,
// not `url`, so the URL is pulled from the text too. Shared files (image/audio) join
// the same envelope as parts.
export async function receiveShares() {
  const shares = await Q.takeShares().catch(() => []);
  shares.forEach((s) => {
    const inText = ((s.text || "") + " " + (s.title || "")).match(URL_ANY_RE);
    const url = s.url || (inText && inText[0]) || "";
    const note = [s.title, s.text].filter(Boolean).join("\n").replace(url, "").trim();
    // s.files from this sw.js; s.fileBlob from the previous one (a share stored before the update)
    const files = s.files || (s.fileBlob ? [{ blob: s.fileBlob, type: s.fileType, name: s.fileName }] : []);
    files.forEach((f) => ensureOpen().media.push(mediaPart(f.blob, f.type, f.name)));
    const text = [url, note].filter(Boolean).join("\n");
    if (text || files.length) openCard({ text, noFocus: files.length > 0 });
  });
}

// ---------- public entry ----------
export function loadCapture(container, opts = {}) {
  if (opts.onQueued) onQueued = opts.onQueued;
  container.innerHTML = "";
  restoreDraft();
  armAutoSeal();
  autoSealIfStale();

  const head = mk("div", "thr-head");
  head.appendChild(mk("span", "over", "לכידה"));
  head.appendChild(mk("span", "thr-count", "מה עולה לך?"));
  container.appendChild(head);

  // the open envelope, if one is waiting
  if (hasContent()) {
    const strip = mk("button", "cap-open-strip");
    const mins = Math.round(capAge() / 60000);
    strip.appendChild(mk("span", null, "✉️ לכידה פתוחה ממתינה" + (mins > 0 ? ` · ${mins} דק'` : "")));
    strip.appendChild(mk("span", "muted", "המשך להוסיף או שגר"));
    strip.addEventListener("click", () => openCard({ noFocus: true }));
    container.appendChild(strip);
  }

  const grid = mk("div", "cap-grid");
  const actions = [
    ["✍️", "כתוב", () => openCard({})],
    ["🎤", "הקלט", () => startRec()],
    ["📷", "צלם", () => pickPhoto()],
    ["📍", "מיקום", () => addLocation(null)],
    ["🔗", "לינק", () => openCard({})],
    ["📋", "הדבק", () => pasteClip()],
  ];
  actions.forEach(([ico, label, fn]) => {
    const b = mk("button", "cap-btn"); b.type = "button";
    b.appendChild(mk("span", "cap-ico", ico));
    b.appendChild(mk("span", "cap-lbl", label));
    b.addEventListener("click", fn);
    grid.appendChild(b);
  });
  container.appendChild(grid);

  container.appendChild(mk("p", "hint",
    "לכידה = מעטפה פתוחה: התחל מכל כיוון, הוסף פנימה, ושגר פעם אחת. הכל נשמר ל-OneDrive ועובר תמלול ומיון אוטומטי. בלי רשת היא מחכה בטלפון ויוצאת לבד."));

  receiveShares();
}
