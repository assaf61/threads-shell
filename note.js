// Builds spec-valid markdown notes for Alma.Threads/00-raw/inbox.
// Iron rules: ASCII kebab-case filename, target_vault: alma-threads,
// user text lives only in the body (never in frontmatter values).

const pad = (n) => String(n).padStart(2, "0");

export function shortId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => chars[b % 36]).join("");
}

export function device() {
  return /Android/i.test(navigator.userAgent) ? "android" : "desktop";
}

// kind: text | voice | photo | link | share
// mediaExt: e.g. "webm", "jpg" (media file will be media/<stem>.<ext>)
export function buildNote({ kind, text = "", mediaExt = null, sourceUrl = null }) {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stem = `${date}-${pad(d.getHours())}${pad(d.getMinutes())}-${kind}-${shortId()}`;
  const mediaName = mediaExt ? `${stem}.${mediaExt}` : null;

  const fm = [
    "---",
    "type: capture",
    `capture_kind: ${kind}`,
    "target_vault: alma-threads",
    "status: raw",
    `created: ${date}`,
    "owner: assaf",
    "tags: []",
    "enriched: false",
    `device: ${device()}`,
  ];
  if (sourceUrl) fm.push(`source_url: "${String(sourceUrl).replace(/["\n\r]/g, "")}"`);
  if (mediaName) fm.push(`media: media/${mediaName}`);
  fm.push("---", "");

  let body = "";
  if (mediaName) body += `![[media/${mediaName}]]\n\n`;
  if (sourceUrl) body += `${sourceUrl}\n\n`;
  if (text) body += `${text}\n`;
  if (!body) body = "\n";

  return { fileName: `${stem}.md`, stem, mediaName, content: fm.join("\n") + body };
}

export function extFromMime(type, fallbackName = "") {
  const map = {
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic",
  };
  const base = (type || "").split(";")[0].trim();
  if (map[base]) return map[base];
  const m = fallbackName.match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : "bin";
}
