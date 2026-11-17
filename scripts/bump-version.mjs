// 同步版本号：node scripts/bump-version.mjs 1.0.4
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("用法: node scripts/bump-version.mjs <semver>，例如 1.0.4");
  process.exit(1);
}

for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file} → ${version}`);
}

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const next = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
if (next === cargo) {
  console.error("Cargo.toml 里没找到 [package] version，未修改");
  process.exit(1);
}
writeFileSync(cargoPath, next);
console.log(`${cargoPath} → ${version}`);
