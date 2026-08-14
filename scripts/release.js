import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const repo = 'Xieweikang123/ReFast';

/** 若环境未设代理，则沿用 git 的 http(s).proxy（本机常见 Clash 端口） */
function applyGitProxyEnv() {
  if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY) {
    return;
  }
  const https = spawnSync('git', ['config', '--global', '--get', 'https.proxy'], {
    encoding: 'utf-8',
    shell: true,
  });
  const http = spawnSync('git', ['config', '--global', '--get', 'http.proxy'], {
    encoding: 'utf-8',
    shell: true,
  });
  const proxy = (https.stdout || http.stdout || '').trim();
  if (proxy) {
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    process.env.ALL_PROXY = proxy;
    console.log(`🌐 使用 git 代理: ${proxy}`);
  }
}

function run(cmd, args, options = {}) {
  // shell:false 直接以参数数组执行，避免经 shell 拼接命令导致通配符/空格被展开
  const result = spawnSync(cmd, args, {
    encoding: 'utf-8',
    shell: false,
    stdio: options.stdio ?? 'pipe',
    cwd: rootDir,
    env: process.env,
    ...options,
  });
  return result;
}

function ensureGh() {
  const check = run('gh', ['--version']);
  if (check.status !== 0) {
    console.error('❌ 未找到 GitHub CLI (gh)。请先安装: winget install --id GitHub.cli');
    process.exit(1);
  }

  const auth = run('gh', ['auth', 'status']);
  if (auth.status !== 0) {
    console.error('❌ 尚未登录 GitHub。请先运行: gh auth login');
    console.error('   建议选择: GitHub.com → HTTPS → Login with a web browser');
    process.exit(1);
  }
}

function findMsi(version) {
  const msiDir = join(rootDir, 'src-tauri', 'target', 'release', 'bundle', 'msi');
  if (!existsSync(msiDir)) {
    console.error(`❌ 未找到 MSI 目录: ${msiDir}`);
    console.error('   请先运行: npm run build:tauri');
    process.exit(1);
  }

  const expected = `ReFast_${version}_x64_zh-CN.msi`;
  const expectedPath = join(msiDir, expected);
  if (existsSync(expectedPath)) {
    return expectedPath;
  }

  const matches = readdirSync(msiDir).filter(
    (name) => name.startsWith(`ReFast_${version}_`) && name.endsWith('.msi')
  );
  if (matches.length === 1) {
    return join(msiDir, matches[0]);
  }
  if (matches.length > 1) {
    console.error(`❌ 找到多个匹配版本 ${version} 的 MSI:`);
    matches.forEach((m) => console.error(`   - ${m}`));
    process.exit(1);
  }

  console.error(`❌ 未找到版本 ${version} 的 MSI（期望类似 ${expected}）`);
  console.error('   请先运行: npm run build:tauri');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    notes: '',
    title: '',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--notes' || arg === '-n') {
      args.notes = argv[++i] ?? '';
    } else if (arg === '--title' || arg === '-t') {
      args.title = argv[++i] ?? '';
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node scripts/release.js [选项]

将当前版本的 MSI 发布到 GitHub Releases。
版本号读取自 package.json（需先 npm run build:tauri）。

选项:
  -n, --notes <文本>   Release 说明（默认用版本号）
  -t, --title <文本>   Release 标题（默认用版本号）
  --dry-run            只打印将要执行的命令，不实际上传
  -h, --help           显示帮助
`);
      process.exit(0);
    } else {
      console.error(`❌ 未知参数: ${arg}`);
      process.exit(1);
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  applyGitProxyEnv();
  ensureGh();

  const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  const version = packageJson.version;
  const tag = version; // 与现有 Release 一致，不用 v 前缀
  const msiPath = findMsi(version);
  const title = args.title || version;
  const notes = args.notes || `ReFast ${version}`;

  console.log(`📦 版本: ${version}`);
  console.log(`🏷️  Tag:  ${tag}`);
  console.log(`📄 MSI:  ${msiPath}`);
  console.log(`📝 标题: ${title}`);

  // 若 tag/release 已存在则提示
  const existing = run('gh', ['release', 'view', tag, '--repo', repo]);
  if (existing.status === 0) {
    console.error(`❌ Release ${tag} 已存在: https://github.com/${repo}/releases/tag/${tag}`);
    console.error('   如需覆盖，请先在 GitHub 删除该 Release，或升级版本后重新打包。');
    process.exit(1);
  }

  const ghArgs = [
    'release',
    'create',
    tag,
    msiPath,
    '--repo',
    repo,
    '--title',
    title,
    '--notes',
    notes,
  ];

  if (args.dryRun) {
    console.log('\n[dry-run] 将执行:');
    console.log(`gh ${ghArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    return;
  }

  console.log('\n🚀 正在创建 GitHub Release...');
  const result = run('gh', ghArgs, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('❌ 发布失败');
    process.exit(result.status ?? 1);
  }

  console.log(`\n✅ 已发布: https://github.com/${repo}/releases/tag/${tag}`);
}

main();
