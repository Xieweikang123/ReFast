import { ShortcutsConfig } from "./components/ShortcutsConfig";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import "./styles.css";

function ShortcutsConfigApp() {
  useEffect(() => {
    console.log("[前端] ShortcutsConfigApp: Component mounted");
    return () => {
      console.log("[前端] ShortcutsConfigApp: Component unmounting");
    };
  }, []);

  const handleClose = async () => {
    console.log("[前端] ShortcutsConfigApp: Close button clicked");
    try {
      const window = getCurrentWindow();
      // Close the window - backend will recreate it if needed
      console.log("[前端] ShortcutsConfigApp: Calling window.close()...");
      await window.close();
      console.log("[前端] ShortcutsConfigApp: Window.close() completed");
    } catch (error) {
      console.error("[前端] ShortcutsConfigApp: ERROR closing window:", error);
    }
  };

  return (
    <div 
      className="h-screen w-screen" 
      style={{ 
        backgroundColor: '#f3f4f6', 
        margin: 0, 
        padding: 0,
        overflow: 'hidden'
      }}
    >
      <ShortcutsConfig onClose={handleClose} />
    </div>
  );
}

export default ShortcutsConfigApp;

