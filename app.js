// threads-intake main UI. One screen, capture-first:
// open → tap → capture → "נקלט". Upload happens in the background via the queue.
import { CONFIG } from "./config.js";
import { buildNote, extFromMime } from "./note.js";
import * as Q from "./queue.js";
import * as Auth from "./auth.js";
import { uploadFile, listInbox, getFileText, getFileBlob, putFileReplace } from "./graph.js";

const $ = (id) => document.getElementById(id);

// ---------- state ----------
let sheet = { kind: "text", mediaBlob: null, mediaType: null, mediaFileName: "", sourceUrl: null };
let recorder = null, recChunks = [], recTimerId = null, recStart = 0;
let draining = false;

// ---------- toast ----------
let toastTimer = null;
function toast(msg, kind = "ok") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "ok" ? 2600 : 5000);
}

// ---------- status strip ----------
async function refreshStatus() {
  const n = await Q.queueCount().catch(() => 0);
  const qEl = $("chip-queue");
  qEl.textContent = n ? `בתור: ${n}` : "הכל סונכרן";
  qEl.classList.toggle("warn", n > 0);

  const aEl = $("chip-auth");
  let signedIn = false;
  if (!Auth.configured()) {
    aEl.textContent = "חסר client_id";
    aEl.className = "chip err";
  } else if (Auth.account()) {
    const tok = await Auth.getToken();
    signedIn = !!tok;
    aEl.textContent = tok ? "מחובר" : "התחבר מחדש";
    aEl.className = tok ? "chip ok" : "chip warn clickable";
  } else {
    aEl.textContent = "התחבר";
    aEl.className = "chip warn clickable";
  }

  // Without a token nothing leaves the phone, so say it in a banner, not only in a small chip.
  // Offline is left to the queue chip: the queue drains by itself when the network returns.
  const bEl = $("auth-banner");
  if (Auth.configured() && !signedIn && navigator.onLine) {
    bEl.textContent = n === 0 ? "לא מחובר: מה שתלכוד יישאר בטלפון. הקש כאן כדי להתחבר"
      : n === 1 ? "לכידה אחת מחכה בטלפון ולא נשלחה. הקש כאן כדי להתחבר"
      : `${n} לכידות מחכות בטלפון ולא נשלחו. הקש כאן כדי להתחבר`;
    bEl.classList.toggle("stuck", n > 0);
    bEl.hidden = false;
  } else {
    bEl.hidden = true;
  }
}

// ---------- edit sheet ----------
function openSheet({ kind, text = "", mediaBlob = null, mediaType = null, mediaFileName = "", sourceUrl = null }) {
  sheet = { kind, mediaBlob, mediaType, mediaFileName, sourceUrl };
  $("sheet-text").value = text;
  const prev = $("sheet-preview");
  prev.innerHTML = "";
  if (mediaBlob && mediaType?.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(mediaBlob);
    prev.appendChild(img);
  } else if (mediaBlob && mediaType?.startsWith("audio/")) {
    const au = document.createElement("audio");
    au.controls = true;
    au.src = URL.createObjectURL(mediaBlob);
    prev.appendChild(au);
  }
  $("sheet").classList.add("open");
  $("backdrop").classList.add("open");
  if (!mediaBlob) setTimeout(() => $("sheet-text").focus(), 50);
}

function closeSheet() {
  $("sheet").classList.remove("open");
  $("backdrop").classList.remove("open");
  $("sheet-text").value = "";
  $("sheet-preview").innerHTML = "";
  sheet = { kind: "text", mediaBlob: null, mediaType: null, mediaFileName: "", sourceUrl: null };
}

const URL_RE = /^https?:\/\/\S+$/;

async function sendCapture() {
  let text = $("sheet-text").value.trim();
  let { kind, mediaBlob, mediaType, mediaFileName, sourceUrl } = sheet;

  if (!text && !mediaBlob && !sourceUrl) { toast("אין מה לשלוח", "warn"); return; }

  // Pure URL typed/pasted as text → link capture.
  if (!sourceUrl && !mediaBlob && URL_RE.test(text)) {
    kind = "link"; sourceUrl = text; text = "";
  }

  const mediaExt = mediaBlob ? extFromMime(mediaType, mediaFileName) : null;
  const note = buildNote({ kind, text, mediaExt, sourceUrl });

  await Q.addCapture({
    kind,
    fileName: note.fileName,
    content: note.content,
    mediaName: note.mediaName,
    mediaType,
    mediaBlob,
  });

  closeSheet();
  // "נקלט" only when the capture can actually leave the phone; otherwise say plainly where it is.
  const tok = navigator.onLine ? await Auth.getToken().catch(() => null) : null;
  if (tok) toast("נקלט ✓");
  else if (!navigator.onLine) toast("נשמר בטלפון. יישלח כשיחזור האינטרנט", "warn");
  else toast("נשמר בטלפון ולא נשלח. צריך להתחבר", "err");
  refreshStatus();
  drain();
}

// ---------- queue drain ----------
async function drain() {
  if (draining || !navigator.onLine || !Auth.configured()) return;
  draining = true;
  try {
    const token = await Auth.getToken();
    if (!token) return; // chip already shows "התחבר"
    const items = await Q.listQueue();
    for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        // Media first: a note that references missing media is a broken capture.
        if (item.mediaBlob && item.mediaName)
          await uploadFile(token, `${CONFIG.mediaSubfolder}/${item.mediaName}`, item.mediaBlob, item.mediaType);
        await uploadFile(token, item.fileName, item.content, "text/markdown");
        await Q.removeItem(item.id);
        refreshStatus();
      } catch (e) {
        await Q.bumpAttempt(item.id);
        if (e.retryable) {
          await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
        } else {
          console.error("upload failed", item.fileName, e);
          toast("שגיאת העלאה - נשמר בתור", "warn");
          break; // leave in queue; next drain retries
        }
      }
    }
  } finally {
    draining = false;
    refreshStatus();
  }
}

// ---------- recording ----------
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    recChunks = [];
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTimerId);
      $("rec-overlay").classList.remove("open");
      const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size > 0)
        openSheet({ kind: "voice", mediaBlob: blob, mediaType: blob.type, mediaFileName: "rec.webm" });
    };
    recorder.start();
    recStart = Date.now();
    $("rec-timer").textContent = "0:00";
    $("rec-overlay").classList.add("open");
    recTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $("rec-timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  } catch (e) {
    toast("אין גישה למיקרופון", "err");
  }
}

// ---------- history panel (read / listen / edit sent captures) ----------
const KIND_LABEL = { text: "טקסט", voice: "קול", photo: "תמונה", link: "לינק", share: "שיתוף" };
let detail = null; // { name, frontmatter, body }

function splitNote(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[0], body: text.slice(m[0].length) };
}

async function openHistory() {
  $("history").classList.add("open");
  $("history-detail").hidden = true;
  $("history-list").hidden = false;
  const listEl = $("history-list");
  listEl.innerHTML = "<div class='t-caption'>טוען…</div>";
  try {
    const token = await Auth.getToken();
    if (!token) { listEl.innerHTML = "<div class='t-caption'>נדרשת התחברות</div>"; return; }
    const items = (await listInbox(token, 20)).filter((i) => i.name.endsWith(".md"));
    listEl.innerHTML = "";
    for (const it of items) {
      const kind = (it.name.match(/-(text|voice|photo|link|share)-/) || [])[1];
      const btn = document.createElement("button");
      btn.className = "history-item";
      btn.innerHTML = `<span class="hi-kind">${KIND_LABEL[kind] || "חוט"}</span>
        <span class="hi-snippet">${it.name.replace(".md", "")}</span>`;
      btn.onclick = () => openDetail(it.name);
      listEl.appendChild(btn);
    }
    if (!items.length) listEl.innerHTML = "<div class='t-caption'>אין חוטים עדיין</div>";
  } catch (e) {
    listEl.innerHTML = "<div class='t-caption'>שגיאה בטעינה - נסה שוב</div>";
    console.error(e);
  }
}

async function openDetail(name) {
  const token = await Auth.getToken();
  if (!token) return;
  $("history-list").hidden = true;
  $("history-detail").hidden = false;
  $("hd-name").textContent = name;
  $("hd-text").value = "טוען…";
  $("hd-media").innerHTML = "";
  try {
    const text = await getFileText(token, name);
    const { frontmatter, body } = splitNote(text);
    detail = { name, frontmatter, body };
    $("hd-text").value = body.trim();
    const mediaMatch = frontmatter.match(/^media:\s*(\S+)/m);
    if (mediaMatch) {
      const rel = mediaMatch[1];
      const blob = await getFileBlob(token, rel);
      const url = URL.createObjectURL(blob);
      if (/\.(webm|ogg|m4a|mp3)$/i.test(rel)) {
        const au = document.createElement("audio");
        au.controls = true; au.src = url;
        $("hd-media").appendChild(au);
      } else {
        const img = document.createElement("img");
        img.src = url;
        $("hd-media").appendChild(img);
      }
    }
  } catch (e) {
    $("hd-text").value = "שגיאה בקריאת החוט";
    console.error(e);
  }
}

async function saveDetail() {
  if (!detail) return;
  const token = await Auth.getToken();
  if (!token) { toast("נדרשת התחברות", "warn"); return; }
  try {
    await putFileReplace(token, detail.name, detail.frontmatter + $("hd-text").value.trim() + "\n");
    toast("נשמר ✓");
    $("history-detail").hidden = true;
    $("history-list").hidden = false;
  } catch (e) {
    toast("שגיאת שמירה", "err");
    console.error(e);
  }
}

// ---------- incoming shares (Android share_target via SW) ----------
async function consumeShares() {
  const shares = await Q.takeShares().catch(() => []);
  for (const s of shares) {
    if (s.fileBlob) {
      openSheet({
        kind: s.fileType?.startsWith("audio/") ? "voice" : "photo",
        text: [s.title, s.text].filter(Boolean).join("\n"),
        mediaBlob: s.fileBlob, mediaType: s.fileType, mediaFileName: s.fileName || "",
      });
    } else {
      const url = s.url || (URL_RE.test((s.text || "").trim()) ? s.text.trim() : null);
      openSheet({
        kind: url ? "link" : "share",
        text: [s.title, url ? "" : s.text].filter(Boolean).join("\n"),
        sourceUrl: url,
      });
    }
    break; // one share per arrival in practice
  }
}

// ---------- location capture (8wnc) ----------
const _pad2 = (n) => String(n).padStart(2, "0");

function captureLocation() {
  if (!navigator.geolocation) { toast("מיקום לא נתמך במכשיר", "err"); return; }
  toast("מאתר מיקום…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const lat = latitude.toFixed(6), lng = longitude.toFixed(6);
      const maps = `https://maps.google.com/?q=${lat},${lng}`;
      openSheet({ kind: "text", text: `📍 מיקום: ${lat}, ${lng} (±${Math.round(accuracy)} מ׳)\n${maps}\n\n` });
    },
    () => toast("אין גישה למיקום", "err"),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// ---------- append a timestamped remark to an existing thread (l1um) ----------
function appendRemark() {
  const ta = $("hd-text");
  if (!ta) return;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())} ${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
  const sep = ta.value && !ta.value.endsWith("\n") ? "\n" : "";
  ta.value += `${sep}\n## הערה (${stamp})\n`;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.scrollTop = ta.scrollHeight;
}

// ---------- wire up ----------
function bind() {
  $("btn-write").onclick = () => openSheet({ kind: "text" });

  $("btn-record").onclick = startRecording;
  $("rec-stop").onclick = () => recorder?.state !== "inactive" && recorder.stop();
  $("rec-cancel").onclick = () => {
    if (recorder?.state !== "inactive") { recorder.onstop = () => {
      recorder.stream?.getTracks?.().forEach((t) => t.stop());
      clearInterval(recTimerId);
      $("rec-overlay").classList.remove("open");
    }; recorder.stop(); }
  };

  // צלם opens a submenu: real-time camera or gallery (Assaf's feedback 11/06)
  const closePhotoMenu = () => { $("photo-menu").classList.remove("open"); $("backdrop").classList.remove("open"); };
  $("btn-photo").onclick = () => { $("photo-menu").classList.add("open"); $("backdrop").classList.add("open"); };
  $("pm-camera").onclick = () => { closePhotoMenu(); $("camera-input").click(); };
  $("pm-gallery").onclick = () => { closePhotoMenu(); $("photo-input").click(); };
  $("pm-cancel").onclick = closePhotoMenu;
  const onPhotoPicked = (e) => {
    const f = e.target.files?.[0];
    if (f) openSheet({ kind: "photo", mediaBlob: f, mediaType: f.type, mediaFileName: f.name });
    e.target.value = "";
  };
  $("photo-input").onchange = onPhotoPicked;
  $("camera-input").onchange = onPhotoPicked;

  $("btn-history").onclick = openHistory;
  $("history-close").onclick = () => $("history").classList.remove("open");
  $("hd-back").onclick = () => { $("history-detail").hidden = true; $("history-list").hidden = false; };
  $("hd-remark").onclick = appendRemark;
  $("hd-save").onclick = saveDetail;

  $("btn-paste").onclick = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch {}
    openSheet({ kind: "text", text });
    if (!text) toast("הדבק לתוך תיבת הטקסט", "warn");
  };

  $("btn-location").onclick = captureLocation;

  $("sheet-send").onclick = sendCapture;
  $("sheet-cancel").onclick = closeSheet;
  $("backdrop").onclick = () => { closeSheet(); $("photo-menu").classList.remove("open"); };
  const signInNow = () => {
    if (Auth.configured() && !Auth.account()) Auth.signIn();
    else if (Auth.configured()) Auth.getToken({ interactive: true });
  };
  $("chip-auth").onclick = signInNow;
  $("auth-banner").onclick = signInNow;

  window.addEventListener("online", () => (refreshStatus(), drain()));
  window.addEventListener("offline", refreshStatus);
  document.addEventListener("visibilitychange", () => !document.hidden && (refreshStatus(), drain()));
}

async function main() {
  bind();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("sw", e));
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data === "share-received") consumeShares();
    });
  }
  await Auth.initAuth();
  await refreshStatus();
  await consumeShares();
  drain();
}

main();
