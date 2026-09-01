/* Builds and zips the extension for the Chrome Web Store.

   The store expects manifest.json at the root of the archive, not inside a
   folder, so this zips the *contents* of dist/ rather than dist/ itself. */
import { spawnSync } from "node:child_process";
import { readFile, stat, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const root = path.resolve(".");
const dist = path.join(root, "dist");
const downloads = process.env.VOX_PACKAGE_DIR || path.join(os.homedir(), "Downloads");

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}`);
};

console.log("  building…");
run(process.execPath, ["build.mjs"], { stdio: "ignore" });

const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));

/* ------------------------------------------------------------- store rules */

const problems = [];
if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
if ((manifest.name || "").length > 75) problems.push("name exceeds 75 characters");
if (!manifest.description) problems.push("description is required");
if ((manifest.description || "").length > 132) problems.push("description exceeds 132 characters");
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || "")) problems.push("version must be 1-4 dot-separated integers");
for (const size of [16, 48, 128]) {
  if (!manifest.icons?.[size]) problems.push(`icons.${size} is required by the store`);
}
const csp = manifest.content_security_policy?.extension_pages || "";
// Match the bare token: 'wasm-unsafe-eval' is required for ONNX Runtime and is
// perfectly allowed, while a standalone 'unsafe-eval' is rejected outright.
if (/(^|[\s;])'unsafe-eval'/.test(csp)) {
  problems.push("CSP contains a bare 'unsafe-eval', which the store rejects");
}
if (!existsSync(path.join(dist, "LICENSE"))) problems.push("LICENSE is missing from the package");

// Anything the store would reject on sight, or that simply should not be public.
const junk = [];
const walk = async (dir, prefix = "") => {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) { await walk(path.join(dir, entry.name), `${rel}/`); continue; }
    if (entry.name.startsWith(".")) junk.push(rel);
    if (/\.(map|zip|log|bak)$/.test(entry.name)) junk.push(rel);
  }
};
await walk(dist);
if (junk.length) problems.push(`package contains files that should not ship: ${junk.join(", ")}`);

if (problems.length) {
  console.error("\n  Not ready to publish:\n" + problems.map((p) => `   - ${p}`).join("\n") + "\n");
  process.exit(1);
}

/* ------------------------------------------------------------------- zip it */

await mkdir(downloads, { recursive: true });
const name = `${manifest.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}-v${manifest.version}.zip`;
const out = path.join(downloads, name);
await rm(out, { force: true });

// -X drops the macOS extended attributes that otherwise bloat the archive and
// confuse the reviewer's unzip; the excludes keep resource forks out.
run("zip", ["-r", "-X", "-9", "-q", out, ".", "-x", ".*", "-x", "*/.*", "-x", "__MACOSX*"], { cwd: dist });

const bytes = (await stat(out)).size;
const digest = createHash("sha256").update(await readFile(out)).digest("hex");

// Prove the archive is shaped the way the store expects.
const listing = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
if (!listing.includes("manifest.json")) {
  console.error("\n  manifest.json is not at the archive root — the store will reject this.\n");
  process.exit(1);
}

console.log(`\n  ${manifest.name} ${manifest.version}`);
console.log(`  ${listing.length} entries · ${(bytes / 1048576).toFixed(1)} MB zipped`);
console.log(`  sha256 ${digest.slice(0, 32)}…`);
console.log(`\n  ${out}\n`);
