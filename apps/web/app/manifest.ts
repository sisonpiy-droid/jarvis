import type { MetadataRoute } from "next";

// Makes the dashboard installable (Android: "Install app"; iPhone: Share → Add to Home Screen).
// iPhone only allows web push for home-screen apps, so installing is what enables notifications there.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "JARVIS",
    short_name: "JARVIS",
    description: "Personal chief of staff: MESA deadlines, classes, drafts and alerts.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111214",
    theme_color: "#111214",
    // "JARVIS" in the phone's Share menu (Android, installed app). The service worker catches the POST and hands
    // the shared text, link and files to /share. iPhone has no web share targets: there, 📎 in chat does the same.
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["image/*", "application/pdf", ".pdf", ".docx", ".pptx", ".xlsx", "text/plain", ".txt", ".csv"] }],
      },
    },
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512?maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
