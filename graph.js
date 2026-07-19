// Microsoft Graph uploads to OneDrive for Business (the signed-in user's drive).
import { CONFIG } from "./config.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

class RetryableError extends Error {
  constructor(msg, retryAfter) { super(msg); this.retryable = true; this.retryAfter = retryAfter; }
}
export { RetryableError };

function encPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function itemUrl(relPath, suffix) {
  return `${GRAPH}/me/drive/root:/${encPath(`${CONFIG.inboxPath}/${relPath}`)}:${suffix}`;
}

async function checkResponse(res) {
  if (res.ok) return res;
  if (res.status === 429 || res.status >= 500) {
    const ra = parseInt(res.headers.get("Retry-After") || "5", 10);
    throw new RetryableError(`Graph ${res.status}`, ra);
  }
  const text = await res.text().catch(() => "");
  throw new Error(`Graph ${res.status}: ${text.slice(0, 300)}`);
}

// content: string | Blob. relPath is relative to the inbox folder.
export async function uploadFile(token, relPath, content, contentType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: contentType || "text/markdown" });
  if (blob.size > CONFIG.smallUploadLimit) return uploadLarge(token, relPath, blob);
  const res = await fetch(itemUrl(relPath, "/content?@microsoft.graph.conflictBehavior=rename"), {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  await checkResponse(res);
  return res.json();
}

// List recent inbox items (for the history panel).
export async function listInbox(token, top = 20) {
  const url = `${GRAPH}/me/drive/root:/${encPath(CONFIG.inboxPath)}:/children?$top=${top}&$orderby=lastModifiedDateTime desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await checkResponse(res);
  return (await res.json()).value;
}

export async function getFileText(token, relPath) {
  const res = await fetch(itemUrl(relPath, "/content"), { headers: { Authorization: `Bearer ${token}` } });
  await checkResponse(res);
  return res.text();
}

export async function getFileBlob(token, relPath) {
  const res = await fetch(itemUrl(relPath, "/content"), { headers: { Authorization: `Bearer ${token}` } });
  await checkResponse(res);
  return res.blob();
}

// Overwrite an existing note in place (used by the history editor).
export async function putFileReplace(token, relPath, content) {
  const blob = new Blob([content], { type: "text/markdown" });
  const res = await fetch(itemUrl(relPath, "/content"), {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
    body: blob,
  });
  await checkResponse(res);
  return res.json();
}

// Resumable upload session, 5 MB chunks (multiple of 320 KiB per Graph spec).
async function uploadLarge(token, relPath, blob) {
  const sessRes = await fetch(itemUrl(relPath, "/createUploadSession"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
  });
  await checkResponse(sessRes);
  const { uploadUrl } = await sessRes.json();

  const CHUNK = 5 * 1024 * 1024; // 16 × 320 KiB
  let pos = 0, lastJson = null;
  while (pos < blob.size) {
    const end = Math.min(pos + CHUNK, blob.size);
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${pos}-${end - 1}/${blob.size}`,
        "Content-Length": String(end - pos),
      },
      body: blob.slice(pos, end),
    });
    await checkResponse(res);
    if (res.status === 200 || res.status === 201) lastJson = await res.json();
    pos = end;
  }
  return lastJson;
}
