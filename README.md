# Input Macro Recorder

基于 Tauri 2 的 Windows 桌面应用，用于录制和回放鼠标键盘操作。

## 技术栈

- **框架**: Tauri 2.x
- **前端**: React + TypeScript + Tailwind CSS
- **后端**: Rust
- **平台**: Windows (录制和回放功能仅在 Windows 上支持)

## 项目结构

```
re-fast/
├── src/                    # 前端代码
│   ├── api/               # Tauri API 封装
│   ├── components/        # React 组件
│   ├── types/             # TypeScript 类型定义
│   ├── App.tsx            # 主应用组件
│   └── main.tsx           # 入口文件
├── src-tauri/             # Tauri 后端代码
│   ├── src/
│   │   ├── commands.rs    # Tauri 命令定义
│   │   ├── recording.rs   # 录制功能
│   │   ├── replay.rs      # 回放功能
│   │   ├── hotkey.rs      # 全局快捷键
│   │   ├── error.rs       # 错误处理
│   │   └── main.rs        # 应用入口
│   └── Cargo.toml         # Rust 依赖配置
└── package.json           # 前端依赖配置
```

## 开发

### 前置要求

- Node.js (v14+)
- Rust (最新稳定版)
- Windows 开发环境 (用于完整功能)

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run tauri dev
```

### 构建

```bash
npm run tauri build
```

## 功能状态

### 已完成
- ✅ 项目骨架和基础结构
- ✅ Tauri 命令接口定义
- ✅ 前端 UI 组件
- ✅ 类型定义和 API 封装

### 待实现
- ⏳ Windows 全局 Hook (鼠标和键盘)
- ⏳ 事件录制和保存
- ⏳ 输入模拟和回放
- ⏳ 全局快捷键注册
- ⏳ 录制文件管理

## 许可证

MIT



