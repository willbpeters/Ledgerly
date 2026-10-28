// Writes one version into every file that carries Tally's version.
// Usage: node scripts/set-version.mjs 0.2.0   (the Release workflow runs this)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);

const stringify = (obj) => JSON.stringify(obj, null, 2) + "\n";

export function bumpJson(text, version) {
  return stringify({ ...JSON.parse(text), version });
}

export function bumpPackageLock(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return stringify(lock);
}

// The first `version = ` line is the [package] one; dependency versions sit in
// inline tables. No `$`: a Windows checkout ends lines with \r\n.
export function bumpCargoToml(text, version) {
  return text.replace(/^version = "[^"]*"/m, `version = "${version}"`);
}

export function bumpCargoLock(text, version) {
  return text.replace(/(name = "ledgerly"\r?\nversion = )"[^"]*"/, `$1"${version}"`);
}

const FILES = [
  ["package.json", bumpJson],
  ["package-lock.json", bumpPackageLock],
  ["src-tauri/tauri.conf.json", bumpJson],
  ["src-tauri/Cargo.toml", bumpCargoToml],
  ["src-tauri/Cargo.lock", bumpCargoLock],
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2] ?? "";
  if (!isVersion(version)) {
    console.error(`"${version}" isn't a version. Use three numbers, like 0.2.0.`);
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const [file, bump] of FILES) {
    const path = root + file;
    writeFileSync(path, bump(readFileSync(path, "utf8"), version));
  }
  console.log(`Tally is now version ${version}.`);
}
