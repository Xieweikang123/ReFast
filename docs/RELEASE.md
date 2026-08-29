# 发版说明

ReFast 采用 **merge 到 master 自动发布** 的流程，本地打包上传（`npm run release`）仅作应急备用。

## 日常工作流

在 `dev` 上开发，发版时：

```powershell
# 1.（在 dev 上）bump 版本号，同步 package.json / Cargo.toml / tauri.conf.json
node scripts/sync-version.js patch    # 或 minor

# 2. 提交 bump + 推送 dev（CI 会跑 tsc + vitest + cargo check）
git add -A
git commit -m "chore: bump version to 1.0.x"
git push origin dev

# 3. 确认 dev 的 CI 绿后，合并到 master
git checkout master
git merge dev
git push origin master

# 4. 回到 dev 继续开发
git checkout dev
```

push 到 master 触发 `release.yml`：

1. 读取 `package.json` 版本号（如 `1.0.82`）
2. **幂等检查**：GitHub 已存在同名 Release → 直接跳过（忘 bump 就 merge 不会发重复版本）
3. 发布前门禁：`npm run build`（tsc）+ `npm test`
4. `npx tauri build` 产出 `src-tauri/target/release/bundle/msi/ReFast_<版本>_x64_zh-CN.msi`
5. `scripts/generate-notes.mjs` 从提交记录生成分组更新日志
6. 创建 Release（tag 与版本同名，无 `v` 前缀）并上传 MSI

## 更新日志规则

自动从 commit log 生成，按 conventional commits 前缀分组：

| 前缀 | 分组 |
|---|---|
| `feat:` | ✨ 新功能 |
| `fix:` | 🐛 修复 |
| `perf:` | ⚡ 性能优化 |
| `style:` | 🎨 界面改进 |
| `chore:` / `docs:` / `ci:` 等 | 🔧 内部改进 |
| `chore: bump version …` | 剔除不显示 |

所以 **commit message 要写用户能看懂的中文描述**，这直接决定 Release 页面的质量。

## 注意事项

- 忘 bump 就合并 master：workflow 会跳过发布（日志写明原因），下个版本 bump 后正常发。
- Rust 全量构建在 CI 上约 15–30 分钟（首跑无缓存更久），发版后留意 Actions 页面。
- 应急通道：本地打好的 MSI 仍可用 `npm run release` 手动上传（需要 `gh auth login`），发版前需确保对应版本 Release 不存在。
- 实现文件：`.github/workflows/release.yml`、`scripts/generate-notes.mjs`、`scripts/release.js`（本地应急）。