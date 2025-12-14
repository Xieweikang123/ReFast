import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// 恢复的版本号
const restoreVersion = "1.0.24";

console.log(`📦 恢复版本号: ${restoreVersion}`);

// 更新 package.json
const packageJsonPath = join(rootDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
packageJson.version = restoreVersion;
writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8');
console.log(`✓ 已更新 ${packageJsonPath}`);

// 更新 Cargo.toml
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
let cargoToml = readFileSync(cargoTomlPath, 'utf-8');
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${restoreVersion}"`);
writeFileSync(cargoTomlPath, cargoToml, 'utf-8');
console.log(`✓ 已更新 ${cargoTomlPath}`);

// 更新 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = restoreVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log(`✓ 已更新 ${tauriConfPath}`);

console.log(`\n✅ 版本号已恢复！`);
