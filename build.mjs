/* Builds the loadable extension into dist/. */
import * as esbuild from "esbuild";
import { cp, mkdir, rm, readdir, writeFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(root, "src");
// Overridable so experiments can build somewhere else without disturbing a
// dist/ that a browser currently has loaded.
const dist = process.env.VOX_OUT
  ? path.resolve(process.env.VOX_OUT)
  : path.join(root, "dist");
const watch = process.argv.includes("--watch");

// Voices bundled with the extension so the first sentence never waits on a
// second network round-trip. Everything else falls back to the Hub.
const VOICES = [
  "af_heart", "af_bella", "af_nicole", "af_aoede", "af_kore", "af_sarah",
  "am_michael", "am_fenrir", "am_puck",
  "bf_emma", "bm_george", "bm_fable",
];

// Once env.wasm.wasmPaths is set, ORT dynamically imports its glue module from
// that directory and the glue then fetches the binary beside it. Both files
// have to ship; shipping only the .wasm fails with "no available backend".
const ORT_FILES = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

async function copyStatic() {
  await cp(path.join(src, "manifest.json"), path.join(dist, "manifest.json"));
  await cp(path.join(src, "background.js"), path.join(dist, "background.js"));
  await cp(path.join(src, "content.js"), path.join(dist, "content.js"));
  await cp(path.join(src, "anchor.js"), path.join(dist, "anchor.js"));
  await cp(path.join(src, "offscreen.html"), path.join(dist, "offscreen.html"));
  await cp(path.join(src, "ui"), path.join(dist, "ui"), { recursive: true });
  if (existsSync(path.join(src, "icons"))) {
    await cp(path.join(src, "icons"), path.join(dist, "icons"), { recursive: true });
  }
  // eSpeak NG is GPL-3.0 and travels inside the worker bundle, so the licence
  // and the attribution ship with the package, not just with the repository.
  await cp(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));
  await cp(path.join(root, "THIRD-PARTY-NOTICES.md"), path.join(dist, "THIRD-PARTY-NOTICES.md"));
}

async function copyRuntime() {
  const ortSrc = path.join(root, "node_modules", "onnxruntime-web", "dist");
  await mkdir(path.join(dist, "ort"), { recursive: true });
  // Warning and carrying on here produces an extension that installs fine and
  // then dies at runtime with "Failed to fetch". Refuse to build instead.
  for (const file of ORT_FILES) {
    const from = path.join(ortSrc, file);
    if (!existsSync(from)) {
      throw new Error(`Missing ${path.relative(root, from)} — run \`npm install\` before building.`);
    }
    await cp(from, path.join(dist, "ort", file));
  }

  const voiceSrc = path.join(root, "node_modules", "kokoro-js", "voices");
  await mkdir(path.join(dist, "voices"), { recursive: true });
  let bytes = 0;
  for (const id of VOICES) {
    const from = path.join(voiceSrc, `${id}.bin`);
    if (!existsSync(from)) {
      throw new Error(`Missing voice ${id}.bin — run \`npm install\` before building.`);
    }
    await cp(from, path.join(dist, "voices", `${id}.bin`));
    bytes += (await stat(from)).size;
  }
  return bytes;
}

const NODE_BUILTINS = /^(node:)?(fs|fs\/promises|path|url|module|os|crypto|worker_threads|child_process|stream|util|perf_hooks|onnxruntime-node|sharp)$/;

const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: NODE_BUILTINS }, (args) => ({ path: args.path, namespace: "node-stub" }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default undefined;", loader: "js",
    }));
  },
};

async function bundle() {
  const options = {
    entryPoints: [path.join(src, "offscreen.js"), path.join(src, "tts-worker.js")],
    outdir: dist,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["chrome116"],
    minify: !watch,
    sourcemap: watch ? "inline" : false,
    legalComments: "none",
    logLevel: "info",
    // kokoro-js and transformers.js both carry Node-only code paths. Their
    // package.json "browser" maps handle most of it; anything left over is
    // stubbed, because marking these external emits bare `import "path"`
    // specifiers that a browser cannot resolve.
    plugins: [stubNodeBuiltins],
    define: { "process.env.NODE_ENV": '"production"' },
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("watching…");
  } else {
    await esbuild.build(options);
  }
}

// Nothing should ever ship a dist/ that is missing a file the runtime needs.
// dist/ is written in place rather than wiped, because a browser may have it
// loaded. That makes pruning the job of the build: anything not produced here
// is stale or junk, and .DS_Store must never reach the Web Store.
async function prune(expected) {
  const keep = new Set(expected.map((f) => path.join(dist, f)));
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!keep.has(full)) {
        await unlink(full);
        console.log(`  pruned ${path.relative(dist, full)}`);
      }
    }
  };
  await walk(dist);
}

function shipped() {
  return [
    "manifest.json", "background.js", "content.js", "anchor.js",
    "offscreen.html", "offscreen.js", "tts-worker.js",
    "ui/popup.html", "ui/popup.js", "ui/popup.css",
    "LICENSE", "THIRD-PARTY-NOTICES.md",
    ...[16, 32, 48, 128].map((n) => `icons/icon${n}.png`),
    ...ORT_FILES.map((f) => `ort/${f}`),
    ...VOICES.map((v) => `voices/${v}.bin`),
  ];
}

async function verify() {
  const required = shipped();
  const missing = [];
  for (const name of required) {
    const full = path.join(dist, name);
    if (!existsSync(full) || (await stat(full)).size === 0) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`Build produced an incomplete extension:\n  ${missing.join("\n  ")}`);
  }
}

async function report() {
  const walk = async (dir, prefix = "") => {
    const rows = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) rows.push(...(await walk(full, `${prefix}${entry.name}/`)));
      else rows.push([`${prefix}${entry.name}`, (await stat(full)).size]);
    }
    return rows;
  };
  const rows = (await walk(dist)).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, size]) => sum + size, 0);
  console.log("\n  dist/");
  for (const [name, size] of rows.slice(0, 12)) {
    console.log(`   ${(size / 1024).toFixed(0).padStart(7)} KB  ${name}`);
  }
  if (rows.length > 12) console.log(`   ${String(rows.length - 12).padStart(7)} more files`);
  console.log(`  ─────────────────────\n   ${(total / 1048576).toFixed(2)} MB  packed extension\n`);
}

// Deliberately NOT wiping dist/: a browser may have this exact folder loaded as
// an unpacked extension, and deleting it out from under Chromium leaves the
// extension alive but unable to read half its own files.
await mkdir(dist, { recursive: true });
await copyStatic();
await copyRuntime();
await bundle();
await prune(shipped());
await verify();
if (!watch) await report();
