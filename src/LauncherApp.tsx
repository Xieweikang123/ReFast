import { LauncherWindow } from "./components/LauncherWindow";
import { UpdateChecker } from "./components/UpdateChecker";
import { useEffect, useState } from "react";
import { tauriApi } from "./api/tauri";
import type { UpdateCheckResult } from "./types";
import "./styles.css";

function LauncherApp() {
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);

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

  // 处理更新检查结果
  const handleUpdateFound = (info: UpdateCheckResult) => {
    // 检查是否已忽略此版本
    const ignoredVersion = localStorage.getItem("ignored_update_version");
    if (ignoredVersion !== info.latest_version) {
      setUpdateInfo(info);
    }
  };

  return (
    <div 
      className="w-screen" 
      style={{ 
        backgroundColor: 'transparent', 
        margin: 0, 
        padding: 0,
        overflow: 'hidden'
      }}
    >
      <LauncherWindow updateInfo={updateInfo} />
      {/* 自动更新检查器 */}
      {autoCheckUpdate && <UpdateChecker autoCheck={true} checkInterval={24} onUpdateFound={handleUpdateFound} />}
    </div>
  );
}

export default LauncherApp;

