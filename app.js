// threads-intake main UI. One screen, capture-first.
// 01/11/2026: the capture itself is capture.js - the same collector as the capture
// tab in בית עלמא (docs/CAPTURE-PARITY-2026-11-01.md). This file keeps what is this
// app's own: the status strip, the offline queue drain, history, and incoming shares.
import { CONFIG } from "./config.js";
import * as Q from "./queue.js";
import * as Auth from "./auth.js";
import { uploadFile, listInbox, getFileText, getFileBlob, putFileReplace } from "./graph.js";
import { toast, withMic } from "./ui.js";
import { loadCapture, receiveShares } from "./capture.js";
import { primeDomains } from "./domains.js";

const $ = (id) => document.getElementById(id);

let draining = false, drainAgain = false;

// ---------- status strip ----------
async function refreshStatus() {
  // the banner counts captures; a queued lock op rides with its capture and is not one
  const queued = await Q.listQueue().catch(() => []);
  const n = queued.length, caps = queued.filter((i) => i.kind !== "op").length;
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
    bEl.textContent = caps === 0 ? "לא מחובר: מה שתלכוד יישאר בטלפון. הקש כאן כדי להתחבר"
      : caps === 1 ? "לכידה אחת מחכה בטלפון ולא נשלחה. הקש כאן כדי להתחבר"
      : `${caps} לכידות מחכות בטלפון ולא נשלחו. הקש כאן כדי להתחבר`;
    bEl.classList.toggle("stuck", n > 0);
    bEl.hidden = false;
  } else {
    bEl.hidden = true;
  }
}

// ---------- queue drain ----------
// A queued item is a capture note with its media parts, or a lock op (_ops/...json).
// A capture queued while a drain runs is picked up by one more pass (drainAgain).
async function drain() {
  if (draining) { drainAgain = true; return; }
  if (!navigator.onLine || !Auth.configured()) return;
  draining = true; drainAgain = false;
  try {
    const token = await Auth.getToken();
    if (!token) return; // chip already shows "התחבר"
    const items = await Q.listQueue();
    for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        // Media first: a note that references missing media is a broken capture.
        // item.media (list) since 01/11; mediaBlob/mediaName is an item queued before the update.
        const media = item.media || (item.mediaBlob && item.mediaName ? [{ name: item.mediaName, type: item.mediaType, blob: item.mediaBlob }] : []);
        for (const m of media)
          await uploadFile(token, `${CONFIG.mediaSubfolder}/${m.name}`, m.blob, m.type);
        await uploadFile(token, item.fileName, item.content, item.contentType || "text/markdown");
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
  if (drainAgain) drain();
}

// ---------- capture screen ----------
const onQueued = () => { refreshStatus(); drain(); };
const renderCapture = () => loadCapture($("capture"), { onQueued });

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
    // 08/11/2026: a shared video is not downloaded again just to show the history; its name is enough.
    if (mediaMatch && /\.(mp4|mov|3gp|mkv)$/i.test(mediaMatch[1])) {
      const p = document.createElement("p"); p.className = "hint"; p.textContent = "🎬 סרטון: " + mediaMatch[1];
      $("hd-media").appendChild(p);
    } else if (mediaMatch) {
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

// ---------- append a timestamped remark to an existing thread (l1um) ----------
const _pad2 = (n) => String(n).padStart(2, "0");

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
  $("btn-history").onclick = openHistory;
  $("history-close").onclick = () => $("history").classList.remove("open");
  $("hd-back").onclick = () => { $("history-detail").hidden = true; $("history-list").hidden = false; };
  $("hd-remark").onclick = appendRemark;
  $("hd-save").onclick = saveDetail;
  // the history editor dictates too (every text field gets a mic)
  const hd = $("hd-text"), after = hd.nextSibling, parent = hd.parentNode;
  parent.insertBefore(withMic(hd), after);

  const signInNow = () => {
    if (Auth.configured() && !Auth.account()) Auth.signIn();
    else if (Auth.configured()) Auth.getToken({ interactive: true });
  };
  $("chip-auth").onclick = signInNow;
  $("auth-banner").onclick = signInNow;

  window.addEventListener("online", () => (refreshStatus(), drain()));
  window.addEventListener("offline", refreshStatus);
  // back in front: a waiting envelope shows its strip again, as when alma-home re-enters the tab
  document.addEventListener("visibilitychange", () => !document.hidden && (refreshStatus(), drain(), renderCapture()));
}

async function main() {
  bind();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("sw", e));
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data === "share-received") receiveShares();
    });
  }
  await Auth.initAuth();
  // the triage dome list sits behind sign-in (alma-paths.json); until it loads, the public fallback
  Auth.getToken().then((t) => t && primeDomains(t)).catch(() => {});
  await refreshStatus();
  renderCapture();
  drain();
}

main();
