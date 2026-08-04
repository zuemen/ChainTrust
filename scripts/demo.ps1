# 一鍵起 ChainTrust Demo（Windows / PowerShell）
# 啟動 ai-service(:8000) + issuer-verifier(:3001) + wallet(:5173)
# 前置：pnpm install；packages/ai-service 已 `pnpm ai:setup` 建好 venv 並 `pnpm ai:train` 產 model.joblib
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# 記錄本腳本「自己啟動」的 PID，收工只殺這些（含子孫程序），
# 絕不用 `Get-Process node,python | Stop-Process` —— 那會把使用者機器上
# 所有無關的 node / python（編輯器、其他專案、Jupyter…）一起殺掉。
$script:StartedPids = @()

function Register-Started {
  param([System.Diagnostics.Process]$Proc, [string]$Label)
  if ($null -ne $Proc) {
    $script:StartedPids += [pscustomobject]@{ Id = $Proc.Id; Label = $Label }
    Write-Host ("[{0}] pid={1}" -f $Label, $Proc.Id) -ForegroundColor DarkGray
  }
}

function Stop-Started {
  if ($script:StartedPids.Count -eq 0) { return }
  Write-Host "`n=== 收工：停止本次啟動的服務 ===" -ForegroundColor Cyan
  foreach ($p in $script:StartedPids) {
    try {
      if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) {
        # /T 連同子孫程序（pnpm.cmd → node）一起收，/F 強制
        & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
        Write-Host ("  ✔ 已停止 {0} (pid={1})" -f $p.Label, $p.Id) -ForegroundColor DarkGray
      }
    } catch {
      Write-Host ("  ! 停止 {0} (pid={1}) 失敗：{2}" -f $p.Label, $p.Id, $_) -ForegroundColor Yellow
    }
  }
  $script:StartedPids = @()
}

Write-Host "=== ChainTrust Demo 啟動中 ===" -ForegroundColor Cyan

try {
  # 1) AI 反詐服務
  $ai = Join-Path $root "packages/ai-service"
  $venvPy = Join-Path $ai ".venv/Scripts/python.exe"
  if (-not (Test-Path $venvPy)) {
    Write-Host "[!] 找不到 ai-service venv，請先執行： pnpm ai:setup; pnpm ai:train" -ForegroundColor Yellow
  } else {
    if (-not (Test-Path (Join-Path $ai "model.joblib"))) {
      Write-Host "[ai] 尚無 model.joblib，先訓練…" -ForegroundColor Yellow
      & $venvPy (Join-Path $ai "train.py")
    }
    Write-Host "[ai] 啟動 http://localhost:8000" -ForegroundColor Green
    $aiProc = Start-Process -PassThru -FilePath $venvPy `
      -ArgumentList "-m","uvicorn","app.main:app","--port","8000" `
      -WorkingDirectory $ai -WindowStyle Minimized
    Register-Started -Proc $aiProc -Label "ai-service"
  }

  # 2) issuer-verifier
  Write-Host "[iv] 啟動 http://localhost:3001" -ForegroundColor Green
  $ivProc = Start-Process -PassThru -FilePath "pnpm" `
    -ArgumentList "--filter","@chaintrust/issuer-verifier","dev" `
    -WorkingDirectory $root -WindowStyle Minimized
  Register-Started -Proc $ivProc -Label "issuer-verifier"

  # 3) wallet（前景執行；Ctrl+C 或視窗關閉後進 finally 收尾）
  Start-Sleep -Seconds 3
  Write-Host "[wallet] 啟動 http://localhost:5173" -ForegroundColor Green
  Write-Host ""
  Write-Host "→ 開啟瀏覽器： http://localhost:5173" -ForegroundColor Cyan
  Write-Host "（關閉：在本視窗按 Ctrl+C，會自動只停掉上面列出的 pid）" -ForegroundColor DarkGray
  & pnpm --filter "@chaintrust/wallet" dev
}
finally {
  Stop-Started
}
