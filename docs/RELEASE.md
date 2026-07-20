# 发版说明

将本地打好的 MSI 发布到 [GitHub Releases](https://github.com/Xieweikang123/ReFast/releases)。

## 一次性准备

1. 安装 [GitHub CLI](https://cli.github.com/)：

```powershell
winget install --id GitHub.cli
```

2. 登录（需能访问 GitHub；若本机 git 已配代理，发版脚本会自动沿用）：

```powershell
# 若直连超时，先设代理（按本机 Clash 等端口调整）
$env:HTTP_PROXY = "http://127.0.0.1:10809"
$env:HTTPS_PROXY = "http://127.0.0.1:10809"

gh auth login --hostname github.com --git-protocol https --web
```

按提示打开 https://github.com/login/device ，输入终端里的一次性验证码并授权。

## 日常发版

```powershell
# 1. 打包（自动 bump patch 版本）
npm run build:tauri

# 2. 上传到 GitHub Releases
npm run release
```

`npm run build:tauri` 会自动 patch 递增版本号，并同步到 `package.json`、`Cargo.toml`、`tauri.conf.json`，产物在：

`src-tauri/target/release/bundle/msi/ReFast_<版本>_x64_zh-CN.msi`

### 可选参数

```powershell
npm run release -- --notes "修复 xxx" --title "1.0.71"
npm run release -- --dry-run   # 只预览，不实际上传
```

## 说明

- 脚本读取当前 `package.json` 版本，上传对应 MSI，创建同名 tag（如 `1.0.71`，无 `v` 前缀）。
- 若该 Release 已存在会报错，需先删旧 Release，或升版本后重新打包。
- 实现脚本：`scripts/release.js`。
