import { useEffect, useState, useCallback } from "react";
import { tauriApi } from "../api/tauri";
import { UpdateCheckDialog } from "./UpdateCheckDialog";
import type { UpdateCheckResult } from "../types";

interface UpdateCheckerProps {
  autoCheck?: boolean;
  checkInterval?: number; // 检查间隔（小时），默认 24 小时
  onUpdateFound?: (updateInfo: UpdateCheckResult) => void;
}

/**
 * 更新检查组件
 * 支持自动检查和手动检查
 */
export function UpdateChecker({
  autoCheck = true,
  checkInterval = 24,
  onUpdateFound,
}: UpdateCheckerProps) {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [lastCheckTime, setLastCheckTime] = useState<number | null>(null);

  // 检查更新
  const checkUpdate = useCallback(async (showDialog = true) => {
    // 防止重复检查
    if (isChecking) {
      return;
    }

    setIsChecking(true);
    try {
      const result = await tauriApi.checkUpdate();
      setUpdateInfo(result);
      setLastCheckTime(Date.now());

      if (result.has_update) {
        if (onUpdateFound) {
          onUpdateFound(result);
        }
        if (showDialog) {
          setIsDialogOpen(true);
        }
      }
    } catch (error) {
      console.error("检查更新失败:", error);
      // 静默失败，不打扰用户
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, onUpdateFound]);

  // 自动检查更新
  useEffect(() => {
    if (!autoCheck) {
      return;
    }

    // 从 localStorage 读取上次检查时间
    const storedLastCheck = localStorage.getItem("last_update_check_time");
    const storedLastCheckTime = storedLastCheck ? parseInt(storedLastCheck, 10) : null;

    // 检查是否需要更新（距离上次检查超过指定间隔）
    const shouldCheck = !storedLastCheckTime || 
      (Date.now() - storedLastCheckTime) > (checkInterval * 60 * 60 * 1000);

    if (shouldCheck) {
      // 延迟 5 秒检查，避免影响启动速度
      const timer = setTimeout(() => {
        checkUpdate(true);
      }, 5000);

      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, checkInterval]);

  // 保存检查时间到 localStorage
  useEffect(() => {
    if (lastCheckTime !== null) {
      localStorage.setItem("last_update_check_time", lastCheckTime.toString());
    }
  }, [lastCheckTime]);

  const handleClose = () => {
    setIsDialogOpen(false);
  };

  const handleIgnore = async () => {
    if (updateInfo) {
      // 保存忽略的版本号
      localStorage.setItem("ignored_update_version", updateInfo.latest_version);
    }
  };

  // 检查是否已忽略此版本
  const isIgnored = updateInfo && 
    localStorage.getItem("ignored_update_version") === updateInfo.latest_version;

  // 如果已忽略，不显示弹窗
  if (isIgnored && isDialogOpen) {
    setIsDialogOpen(false);
  }

  return (
    <>
      <UpdateCheckDialog
        isOpen={isDialogOpen && !isIgnored}
        onClose={handleClose}
        updateInfo={updateInfo}
        onIgnore={handleIgnore}
      />
      {/* 暴露手动检查方法（通过 ref 或 props） */}
    </>
  );
}

// 导出手动检查函数供外部调用
export const checkUpdateManually = async (): Promise<UpdateCheckResult | null> => {
  try {
    const result = await tauriApi.checkUpdate();
    return result;
  } catch (error) {
    console.error("手动检查更新失败:", error);
    return null;
  }
};
