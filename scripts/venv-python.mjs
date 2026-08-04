#!/usr/bin/env node
/**
 * 跨平台 venv Python 入口。
 *
 * 取代 packages/ai-service/package.json 裡寫死的 `.venv\Scripts\python`
 * （那個路徑只在 Windows 成立，macOS/Linux 使用者跑 scripts/demo.sh 提示的
 *  `pnpm ai:setup` 必定失敗）。
 *
 * 用法（cwd 預設為 packages/ai-service，可用 --cwd 覆寫）：
 *   node scripts/venv-python.mjs --setup          建 .venv 並安裝 requirements.txt
 *   node scripts/venv-python.mjs train.py         用 venv 的 python 跑 train.py
 *   node scripts/venv-python.mjs -m pytest -q     用 venv 的 python 跑 pytest
 *
 * 環境變數：
 *   PYTHON                        指定要用來建 venv 的系統直譯器（例：PYTHON=py）
 *   CHAINTRUST_ALLOW_SYSTEM_PYTHON=1  沒有 .venv 時允許退回系統 python（CI 用）
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const argv = process.argv.slice(2);

// --cwd <dir> ：venv 所在的套件目錄；預設 packages/ai-service
let pkgDir = join(repoRoot, "packages", "ai-service");
const cwdIdx = argv.indexOf("--cwd");
if (cwdIdx !== -1) {
  pkgDir = resolve(repoRoot, argv[cwdIdx + 1] ?? ".");
  argv.splice(cwdIdx, 2);
}

const venvDir = join(pkgDir, ".venv");
// 這是唯一需要分平台的地方：Windows 是 .venv\Scripts\python.exe，POSIX 是 .venv/bin/python
const venvPython = isWindows
  ? join(venvDir, "Scripts", "python.exe")
  : join(venvDir, "bin", "python");

/** 以 stdio inherit 執行，回傳 exit code。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: pkgDir, ...opts });
  if (r.error) return { code: 1, error: r.error };
  return { code: r.status ?? 1 };
}

/** 找一個可用的系統 Python（用來建 venv）。 */
function findSystemPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  if (isWindows) {
    // py launcher 優先：Windows 的 `python3` 常常是 Microsoft Store 的假殼
    candidates.push(["py", ["-3"]], ["python", []], ["python3", []]);
  } else {
    candidates.push(["python3", []], ["python", []]);
  }
  for (const [cmd, prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, "--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return { cmd, prefix };
  }
  return null;
}

function fail(msg) {
  console.error(`[venv-python] ${msg}`);
  process.exit(1);
}

// ---- --setup：建立 venv + 安裝相依 -------------------------------------
if (argv[0] === "--setup") {
  const sys = findSystemPython();
  if (!sys) {
    fail(
      "找不到 Python 3。請先安裝 Python 3.11+，或用 PYTHON=<路徑> 指定直譯器。",
    );
  }
  if (!existsSync(venvPython)) {
    console.log(`[venv-python] 建立 venv：${venvDir}`);
    const r = run(sys.cmd, [...sys.prefix, "-m", "venv", ".venv"]);
    if (r.code !== 0) fail("建立 venv 失敗");
  } else {
    console.log("[venv-python] .venv 已存在，跳過建立");
  }
  console.log("[venv-python] 安裝 requirements.txt …");
  const up = run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  if (up.code !== 0) fail("升級 pip 失敗");
  const inst = run(venvPython, [
    "-m",
    "pip",
    "install",
    "-r",
    "requirements.txt",
  ]);
  if (inst.code !== 0) fail("安裝 requirements.txt 失敗");
  console.log("[venv-python] ✅ 完成。接著可跑： pnpm ai:train");
  process.exit(0);
}

// ---- 一般：用 venv 的 python 執行 --------------------------------------
let python = venvPython;
if (!existsSync(venvPython)) {
  if (process.env.CHAINTRUST_ALLOW_SYSTEM_PYTHON === "1" || process.env.CI) {
    const sys = findSystemPython();
    if (!sys) fail("找不到 .venv，也找不到系統 Python。");
    console.warn(
      `[venv-python] ⚠ 找不到 ${venvPython}，退回系統 Python（CI 模式）`,
    );
    const r = run(sys.cmd, [...sys.prefix, ...argv]);
    process.exit(r.code);
  }
  fail(
    `找不到 ${venvPython}。請先執行： pnpm ai:setup（跨平台，Windows/macOS/Linux 皆可）`,
  );
}

const r = run(python, argv);
process.exit(r.code);
