import { AppCenterContent } from "./AppCenterContent";

interface PluginListModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPluginClick: (pluginId: string) => Promise<void>;
  openAppIndexWithSearch?: string | null;
  onOpenAppIndexSearchConsumed?: () => void;
}

export function PluginListModal({
  isOpen,
  onClose,
  onPluginClick,
  openAppIndexWithSearch,
  onOpenAppIndexSearchConsumed,
}: PluginListModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl flex flex-col m-4" style={{ maxHeight: '90vh', height: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-800">应用中心</h2>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded transition-colors"
          >
            关闭
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          <AppCenterContent
            onPluginClick={onPluginClick}
            onClose={onClose}
            openAppIndexWithSearch={openAppIndexWithSearch}
            onOpenAppIndexSearchConsumed={onOpenAppIndexSearchConsumed}
          />
        </div>
      </div>
    </div>
  );
}
