#!/usr/bin/env node
/**
 * 跨平台 `pnpm demo` 入口。
 * Windows → scripts/demo.ps1；macOS / Linux → scripts/demo.sh
 * （原本 root package.json 直接寫死 powershell，非 Windows 使用者必失敗。）
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const { status } =
  process.platform === "win32"
    ? spawnSync(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", join(here, "demo.ps1"), ...args],
        { stdio: "inherit" },
      )
    : spawnSync("bash", [join(here, "demo.sh"), ...args], { stdio: "inherit" });

process.exit(status ?? 1);
