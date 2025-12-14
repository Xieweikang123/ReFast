import { LauncherWindow } from "./components/LauncherWindow";
import { UpdateChecker } from "./components/UpdateChecker";
import { useEffect, useState } from "react";
import { tauriApi } from "./api/tauri";
import "./styles.css";

function LauncherApp() {
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);

  // 加载设置以确定是否启用自动检查更新
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const settings = await tauriApi.getSettings();
        setAutoCheckUpdate(settings.auto_check_update ?? true);
      } catch (error) {
        console.error("加载设置失败:", error);
        // 默认启用自动检查
        setAutoCheckUpdate(true);
      }
    };
    loadSettings();
  }, []);

  return (
    <div 
      className="h-screen w-screen" 
      style={{ 
        backgroundColor: 'transparent', 
        margin: 0, 
        padding: 0,
        overflow: 'hidden'
      }}
    >
      <LauncherWindow />
      {/* 自动更新检查器 */}
      {autoCheckUpdate && <UpdateChecker autoCheck={true} checkInterval={24} />}
    </div>
  );
}

export default LauncherApp;

