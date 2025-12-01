import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import LauncherApp from "./LauncherApp";
import ShortcutsConfigApp from "./ShortcutsConfigApp";
import "./styles.css";

// Determine which app to render based on window label
function initApp() {
  const root = document.getElementById("root");
  if (!root) {
    console.error("Root element not found!");
    return;
  }
  
  try {
    const window = getCurrentWindow();
    const label = window.label;
    
    if (label === "launcher") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <LauncherApp />
        </StrictMode>
      );
    } else if (label === "shortcuts-config") {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <ShortcutsConfigApp />
        </StrictMode>
      );
    } else {
      ReactDOM.createRoot(root).render(
        <StrictMode>
          <App />
        </StrictMode>
      );
    }
  } catch (error: unknown) {
    console.error("Failed to get window label:", error);
    // Fallback to main app
    ReactDOM.createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  }
}

// Initialize immediately, don't wait for async
initApp();
