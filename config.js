// threads-intake configuration
// clientId: filled after Entra app registration (public by design for SPA).
export const CONFIG = {
  clientId: "9a084397-f3c5-4982-ad7a-f83a87c8acf2",
  authority: "https://login.microsoftonline.com/33886826-9914-4ae1-ad7e-9c093e058b05",
  scopes: ["Files.ReadWrite", "User.Read"],
  // OneDrive for Business path, relative to drive root. ASCII filenames only (vault iron rule).
  inboxPath: "Alma Mind/Alma.Threads/00-raw/inbox",
  mediaSubfolder: "media",
  // Simple PUT limit; above this we use an upload session (resumable).
  smallUploadLimit: 3.5 * 1024 * 1024,
};
