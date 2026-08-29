/**
 * 生成分组更新日志：取「上个 Release tag..当前 HEAD」之间的提交，
 * 按 conventional commits 前缀分组，剔除版本号 bump 等内部噪音提交。
 *
 * 用法: node scripts/generate-notes.mjs <当前版本>
 * 输出: Markdown 文本（stdout）
 *
 * 逻辑：
 * 1. 用 `gh release list` 找到上一个 Release 的 tag 作为起点
 * 2. git log <上tag>..HEAD --oneline 取提交
 * 3. 按前缀 feat/fix/perf 分组，chore/docs/ci 折叠为「内部改进」
 * 4. bump version 提交直接剔除
 */

import { execFileSync } from 'child_process';

const repo = 'Xieweikang123/ReFast';

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    shell: false,
    cwd: joinRoot(),
    ...options,
  }).trim();
}

function joinRoot() {
  // 脚本可能被 CI 在任意 cwd 调用，固定到仓库根
  return new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/generate-notes.mjs <版本号，如 1.0.82>');
  process.exit(1);
}

// 找上一个 Release tag（排除当前版本自身和杂项 tag）
let prevTag = '';
try {
  const list = run('gh', ['release', 'list', '--repo', repo, '--limit', '30', '--json', 'tagName']);
  const tags = JSON.parse(list)
    .map((r) => r.tagName)
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t) && t !== version)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pb[i] - pa[i];
      }
      return 0;
    });
  prevTag = tags[0] || '';
} catch {
  // gh 不可用时退化为无对比区间
}

// 取提交列表
let commits = [];
try {
  const range = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const out = run('git', ['log', range, '--pretty=format:%H%x09%s'], { maxBuffer: 10 * 1024 * 1024 });
  if (out) {
    commits = out.split('\n').map((line) => {
      const [hash, ...rest] = line.split('\t');
      return { hash: hash.slice(0, 7), subject: rest.join('\t') };
    });
  }
} catch (e) {
  console.error(`⚠️ 获取提交列表失败: ${e.message}`);
}

// 分类规则（顺序敏感，前缀后必须跟冒号）
const groups = [
  { key: 'feat', title: '## ✨ 新功能', filter: (s) => /^feat(\(|:)/.test(s) },
  { key: 'fix', title: '## 🐛 修复', filter: (s) => /^fix(\(|:)/.test(s) },
  { key: 'perf', title: '## ⚡ 性能优化', filter: (s) => /^perf(\(|:)/.test(s) },
  { key: 'style', title: '## 🎨 界面改进', filter: (s) => /^style(\(|:)/.test(s) },
  {
    key: 'internal',
    title: '## 🔧 内部改进',
    filter: (s) => /^(chore|docs|ci|refactor|test|build)(\(|:)/.test(s),
  },
];

// 噪音提交：版本号 bump
const isNoise = (s) => /^chore: bump version/i.test(s);

const bucket = {};
for (const c of commits) {
  if (isNoise(c.subject)) continue;
  for (const g of groups) {
    if (g.filter(c.subject)) {
      (bucket[g.key] ||= []).push({ ...c, subject: c.subject.replace(/^[a-z]+(\([^)]*\))?:\s*/, '') });
      break;
    }
  }
  // 不匹配任何前缀的提交（如 merge commit）忽略
}

let md = '';
if (prevTag) {
  md += `**完整变更**: https://github.com/${repo}/compare/${prevTag}...${version}\n\n`;
}

for (const g of groups) {
  const items = bucket[g.key];
  if (!items || items.length === 0) continue;
  md += `${g.title}\n`;
  for (const item of items) {
    md += `- ${item.subject} (${item.hash})\n`;
  }
  md += '\n';
}

if (!md) {
  md = `ReFast ${version}\n`;
}

console.log(md.trimEnd());