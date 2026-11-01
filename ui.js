// Tiny shared UI helpers: toast + voice dictation.
// 01/11/2026 (oq-3c5a92ec8d18): micButton/withMic are copied as-is from
// alma-home/ui.js (commit cf150e9) so the capture card here dictates exactly like
// the one in בית עלמא. toast keeps this app's kinds (ok/warn/err).

let toastTimer = null;
export function toast(msg, kind = "ok") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "ok" ? 2600 : 5000);
}

// 5ni1: a 🎤 button bound to any <textarea>/<input>. Appends recognized speech
// to the field's current value. Returns the button element to place anywhere.
export function micButton(target, opts = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "iconbtn mic" + (opts.compact ? " compact" : "");
  btn.textContent = "🎤";
  btn.title = "הכתב"; btn.setAttribute("aria-label", "הכתבה קולית");
  let recog = null;
  btn.addEventListener("click", () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("הכתבה לא נתמכת בדפדפן הזה"); return; }
    if (recog) { recog.stop(); return; }
    recog = new SR(); recog.lang = "he-IL"; recog.interimResults = false; recog.continuous = true;
    const base = target.value ? target.value + " " : "";
    recog.onresult = (e) => {
      let acc = "";
      for (let i = e.resultIndex; i < e.results.length; i++) acc += e.results[i][0].transcript;
      target.value = base + acc;
      target.dispatchEvent(new Event("input"));
    };
    recog.onerror = () => toast("שגיאת הכתבה");
    recog.onend = () => { recog = null; btn.classList.remove("on"); btn.textContent = "🎤"; };
    recog.start(); btn.classList.add("on"); btn.textContent = "⏹";
  });
  return btn;
}

// Wrap a field with a mic button in a flex row. The field grows, the mic sits beside it.
export function withMic(inputEl, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "mic-wrap";
  wrap.appendChild(inputEl);
  wrap.appendChild(micButton(inputEl, opts));
  return wrap;
}
