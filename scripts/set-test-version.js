import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 测试版本号（低于线上版本 1.0.21）
const testVersion = "1.0.20";

console.log(`📦 设置测试版本号: ${testVersion}`);

// 更新 package.json
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
packageJson.version = testVersion;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
console.log(`✓ 已更新 ${packageJsonPath}`);

// 更新 Cargo.toml
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
let cargoToml = readFileSync(cargoTomlPath, 'utf-8');
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${testVersion}"`);
writeFileSync(cargoTomlPath, cargoToml, 'utf-8');
console.log(`✓ 已更新 ${cargoTomlPath}`);

// 更新 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = testVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log(`✓ 已更新 ${tauriConfPath}`);

console.log(`\n✅ 测试版本号设置完成！`);
console.log(`现在可以运行 npm run dev:tauri 来测试更新检查功能`);
console.log(`\n⚠️  测试完成后，记得运行以下命令恢复版本号：`);
console.log(`   node scripts/restore-version.js`);
