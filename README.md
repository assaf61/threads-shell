# threads

PWA אישי ללכידה מהירה של רעיון, הקלטה, תמונה או לינק אל OneDrive.

- קליינט בלבד, ללא build step: vanilla ES modules + MSAL.js מ-CDN.
- Auth: Entra SPA (single tenant), PKCE. אין סודות בקוד - clientId של SPA ציבורי by design.
- כתיבה: Microsoft Graph (PUT + uploadSession לקבצים גדולים).
- Offline-first: כל לכידה נכתבת ל-IndexedDB קודם ומסונכרנת ברקע.

זהו ריפו-פרסום (GitHub Pages) של הקליינט בלבד.
