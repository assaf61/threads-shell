// MSAL.js wrapper. msal-browser v3 is loaded globally from CDN (see index.html).
import { CONFIG } from "./config.js";
import { kvSet } from "./queue.js";

let app = null;

function redirectUri() {
  // Normalize so it matches the registered URI on both localhost and GitHub Pages.
  return window.location.href.split(/[?#]/)[0].replace(/index\.html$/, "");
}

export function configured() {
  return CONFIG.clientId && !CONFIG.clientId.startsWith("REPLACE");
}

export async function initAuth() {
  if (!configured()) return null;
  app = new msal.PublicClientApplication({
    auth: {
      clientId: CONFIG.clientId,
      authority: CONFIG.authority,
      redirectUri: redirectUri(),
    },
    cache: { cacheLocation: "localStorage" },
  });
  await app.initialize();
  const result = await app.handleRedirectPromise().catch((e) => {
    console.warn("redirect error", e);
    return null;
  });
  if (result?.account) app.setActiveAccount(result.account);
  else if (!app.getActiveAccount() && app.getAllAccounts().length)
    app.setActiveAccount(app.getAllAccounts()[0]);
  return app.getActiveAccount();
}

export function account() {
  return app?.getActiveAccount() || null;
}

export async function signIn() {
  if (!app) return;
  await app.loginRedirect({ scopes: CONFIG.scopes });
}

// Silent token. interactive=false → returns null instead of redirecting
// (capture flow must never be hijacked by auth).
export async function getToken({ interactive = false } = {}) {
  if (!app) return null;
  const acc = account();
  if (!acc) {
    if (interactive) await signIn();
    return null;
  }
  try {
    const r = await app.acquireTokenSilent({ scopes: CONFIG.scopes, account: acc });
    // Cache for the service worker (background sync drains with this if still valid).
    kvSet("graph-token", { accessToken: r.accessToken, exp: r.expiresOn?.getTime() || 0 }).catch(() => {});
    return r.accessToken;
  } catch (e) {
    if (interactive) await app.acquireTokenRedirect({ scopes: CONFIG.scopes, account: acc });
    return null;
  }
}
