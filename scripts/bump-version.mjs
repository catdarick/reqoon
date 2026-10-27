// Sets the app version everywhere it is declared and prints it.
// Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>
import fs from "node:fs";

const arg = process.argv[2];
const conf = "src-tauri/tauri.conf.json";
const current = JSON.parse(fs.readFileSync(conf, "utf8")).version;

function next(cur, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = cur.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`Expected patch, minor, major or x.y.z, got "${how ?? ""}"`);
  process.exit(1);
}

const version = next(current, arg);
if (version === current) {
  console.error(`Already at ${current}`);
  process.exit(1);
}

/** Replaces exactly one match in a file, so a changed layout fails loudly instead of silently. */
function edit(file, pattern, replace, count = 1) {
  const text = fs.readFileSync(file, "utf8");
  const hits = text.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))?.length ?? 0;
  if (hits !== count) {
    console.error(`${file}: expected ${count} version field(s), found ${hits}`);
    process.exit(1);
  }
  fs.writeFileSync(file, text.replace(pattern, replace));
}

edit(conf, /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
// The root entry and packages[""] in the lockfile.
edit("package-lock.json", /(\n  "name": "reqoon",\n  "version": ")[^"]+(")/, `$1${version}$2`);
edit("package-lock.json", /(\n    "": \{\n      "name": "reqoon",\n      "version": ")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/Cargo.toml", /^(version = ")[^"]+(")/m, `$1${version}$2`);
edit("src-tauri/Cargo.lock", /(\nname = "reqoon"\nversion = ")[^"]+(")/, `$1${version}$2`);

console.log(version);
