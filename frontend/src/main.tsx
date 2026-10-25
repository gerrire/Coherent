import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./themes.css";
import "./upgrade.css";
import { applyTheme, loadTheme } from "./lib/theme";
import { isTauri } from "@tauri-apps/api/core";
import { installDesktopMediaConsent } from "./lib/desktopPermissions";
installDesktopMediaConsent();

applyTheme(loadTheme());
if (isTauri() && !new URLSearchParams(window.location.search).has("window")) {
  document.documentElement.classList.add("tauri-main-window");
}

type CaptureHandleMediaDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: {
    handle: string;
    exposeOrigin: boolean;
    permittedOrigins: string[];
  }) => void;
};

try {
  (navigator.mediaDevices as CaptureHandleMediaDevices | undefined)?.setCaptureHandleConfig?.({
    handle: "coherent",
    exposeOrigin: true,
    permittedOrigins: [window.location.origin],
  });
} catch {
  // Screen sharing still works in browsers without Capture Handle.
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
