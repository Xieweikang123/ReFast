import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 解析命令行参数
const bumpType = process.argv[2]; // 'patch', 'minor', 'major', 或 undefined

// 读取 package.json 中的版本号
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
let version = packageJson.version;

// 如果指定了 bumpType，则递增版本号
if (bumpType) {
  const validTypes = ['patch', 'minor', 'major'];
  if (!validTypes.includes(bumpType)) {
    console.error(`❌ 无效的版本类型: ${bumpType}`);
    console.error(`   支持的类型: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  const versionParts = version.split('.').map(Number);
  if (versionParts.length !== 3) {
    console.error(`❌ 无效的版本号格式: ${version}`);
    console.error(`   版本号应为 x.y.z 格式（如 1.0.0）`);
    process.exit(1);
  }

  const [major, minor, patch] = versionParts;

  let newVersion;
  switch (bumpType) {
    case 'major':
      newVersion = `${major + 1}.0.0`;
      break;
    case 'minor':
      newVersion = `${major}.${minor + 1}.0`;
      break;
    case 'patch':
      newVersion = `${major}.${minor}.${patch + 1}`;
      break;
  }

  console.log(`📦 版本号 ${version} → ${newVersion} (${bumpType})`);
  version = newVersion;

  // 更新 package.json 中的版本号
  packageJson.version = version;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
  console.log(`✓ 已更新 ${packageJsonPath}`);
}

// 同步到 Cargo.toml
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
let cargoToml = readFileSync(cargoTomlPath, 'utf-8');
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoTomlPath, cargoToml, 'utf-8');
console.log(`✓ 已更新 ${cargoTomlPath}`);

// 同步到 Cargo.lock（CI 使用 cargo check --locked，版本不一致会失败）
const cargoLockPath = join(rootDir, 'src-tauri', 'Cargo.lock');
let cargoLock = readFileSync(cargoLockPath, 'utf-8');
cargoLock = cargoLock.replace(
  /(\[\[package\]\]\nname = "re-fast"\nversion = ")[^"]+(")/,
  `$1${version}$2`
);
writeFileSync(cargoLockPath, cargoLock, 'utf-8');
console.log(`✓ 已更新 ${cargoLockPath}`);

// 同步到 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log(`✓ 已更新 ${tauriConfPath}`);

console.log(`✅ 版本号已同步到 ${version}`);

