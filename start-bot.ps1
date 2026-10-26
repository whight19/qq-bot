<#
  QQ 机器人一键启动
  ------------------
  1. 检查 NapCat 的 OneBot 端口（默认 3001）在不在；不在就用管理员权限拉起 NapCat（会弹 UAC）。
  2. NapCat 把登录二维码存成 napcat\shell\cache\qrcode.png —— 脚本会读这张图，
     直接在窗口里用方块字符画出来（白底黑块，能直接扫），并顺带尝试用看图程序打开，
     绕过 cmd 里二维码显示成乱码的问题。
  3. 端口通了以后，另开一个窗口跑 bot.mjs。
  4. 故意不做开机自启、不写计划任务 —— 只有你双击 start-bot.cmd 时才启动。

  单独用：show-qrcode.cmd（等价于 powershell -File start-bot.ps1 -QrOnly）只画二维码
#>

param(
    [switch]$QrOnly,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 3001
$qrPath = Join-Path $root 'napcat\shell\cache\qrcode.png'

function Test-OneBotPort {
    param([int]$Port, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $task.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-BotPid {
    # 机器人自己写的 pid 文件最可靠（枚举不到进程时也能用）
    $pidFile = Join-Path $root 'data\bot.pid'
    if (Test-Path $pidFile) {
        $raw = ''
        try { $raw = (Get-Content $pidFile -Raw).Trim() } catch { $raw = '' }
        if ($raw -match '^\d+$') {
            $proc = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue
            if ($proc) { return $proc }
        }
    }
    return $null
}

function Get-RunningBot {
    $byPid = Get-BotPid
    if ($byPid) {
        return @([pscustomobject]@{ ProcessId = $byPid.Id })
    }
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine -match 'bot\.mjs' }
    } catch {
        @()
    }
}

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @('D:\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe')) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

<#
  把 qrcode.png 解码成模块矩阵，用半方块字符在白底上画出来。
  思路：找深色像素包围盒 → 用左上角定位图案的 7 模块宽推出模块像素 → 逐模块采样中心点。
  返回 $true 表示画出来了。
#>
function Show-QrInConsole {
    param([string]$Path)

    Add-Type -AssemblyName System.Drawing

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $stream = New-Object System.IO.MemoryStream(, $bytes)
    $bmp = [System.Drawing.Bitmap]::FromStream($stream)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $w = $bmp.Width
    $h = $bmp.Height
    $raw = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
    $bmp.UnlockBits($data)
    $bmp.Dispose()
    $stream.Dispose()

    $isDark = {
        param($px, $py)
        $i = $py * $stride + $px * 4
        (($raw[$i] + $raw[$i + 1] + $raw[$i + 2]) / 3) -lt 128
    }

    # 深色像素包围盒
    $x0 = $w; $y0 = $h; $x1 = -1; $y1 = -1
    for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            if (& $isDark $x $y) {
                if ($x -lt $x0) { $x0 = $x }
                if ($x -gt $x1) { $x1 = $x }
                if ($y -lt $y0) { $y0 = $y }
                if ($y -gt $y1) { $y1 = $y }
            }
        }
    }
    if ($x1 -lt 0) { return $false }

    # 左上定位图案的上边是连续的 7 个模块
    $run = 0
    while (($x0 + $run) -le $x1 -and (& $isDark ($x0 + $run) $y0)) { $run++ }
    if ($run -lt 7) { return $false }
    $module = [int][Math]::Round($run / 7)
    if ($module -lt 1) { return $false }

    $n = [int][Math]::Round(($x1 - $x0 + 1) / $module)
    if ($n -lt 21 -or $n -gt 97 -or (($n - 21) % 4) -ne 0) { return $false }

    $grid = New-Object 'bool[,]' $n, $n
    $half = [int][Math]::Floor($module / 2)
    for ($r = 0; $r -lt $n; $r++) {
        $py = [Math]::Min($y0 + $r * $module + $half, $h - 1)
        for ($c = 0; $c -lt $n; $c++) {
            $px = [Math]::Min($x0 + $c * $module + $half, $w - 1)
            $grid[$r, $c] = & $isDark $px $py
        }
    }

    # 画：白底黑块，留 4 个模块的静区
    $pad = ' ' * 4
    $blankLine = $pad + (' ' * $n) + $pad
    Write-Host ''
    Write-Host $blankLine -ForegroundColor Black -BackgroundColor White
    Write-Host $blankLine -ForegroundColor Black -BackgroundColor White
    for ($r = 0; $r -lt $n; $r += 2) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append($pad)
        for ($c = 0; $c -lt $n; $c++) {
            $top = $grid[$r, $c]
            $bottom = if (($r + 1) -lt $n) { $grid[($r + 1), $c] } else { $false }
            if ($top -and $bottom) { [void]$sb.Append([char]0x2588) }
            elseif ($top) { [void]$sb.Append([char]0x2580) }
            elseif ($bottom) { [void]$sb.Append([char]0x2584) }
            else { [void]$sb.Append(' ') }
        }
        [void]$sb.Append($pad)
        Write-Host $sb.ToString() -ForegroundColor Black -BackgroundColor White
    }
    Write-Host $blankLine -ForegroundColor Black -BackgroundColor White
    Write-Host $blankLine -ForegroundColor Black -BackgroundColor White
    Write-Host ''
    return $true
}

function Show-QrCode {
    param([string]$Path)
    Write-Host ''
    Write-Host ('二维码图片：' + $Path) -ForegroundColor Cyan

    $drawn = $false
    try {
        $drawn = Show-QrInConsole -Path $Path
    } catch {
        $drawn = $false
    }
    if ($drawn) {
        Write-Host '上面这块白底黑块就是二维码，手机 QQ 直接扫屏幕即可（窗口里 NapCat 那堆乱码不用管）。'
    } else {
        Write-Host ('控制台画不出来，请手动双击这张图：' + $Path) -ForegroundColor Yellow
    }
    Write-Host ''
}

# 只画二维码：二维码在控制台显示不出来、或想单独看一眼时用
if ($QrOnly) {
    if (Test-Path $qrPath) {
        Show-QrCode -Path $qrPath
    } else {
        Write-Host ('还没有二维码文件：' + $qrPath) -ForegroundColor Yellow
        Write-Host '先运行 start-bot.cmd，等它把 NapCat 拉起来再看。'
    }
    exit 0
}

Write-Host '=== QQ 机器人一键启动 ===' -ForegroundColor Cyan

# 0. 先看清机器人有没有已经在跑：在跑就别双开，但 NapCat 该拉还是要拉
if ($Restart) {
    $old = Get-RunningBot
    if ($old) {
        foreach ($p in $old) {
            Write-Host ("停掉旧实例 pid {0}……" -f $p.ProcessId) -ForegroundColor Yellow
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            } catch {
                Write-Host ('停不掉：' + $_.Exception.Message) -ForegroundColor Red
            }
        }
        Start-Sleep -Seconds 1
    } else {
        Write-Host '没找到在跑的机器人，直接启动。' -ForegroundColor Yellow
    }
}
$running = Get-RunningBot

# 1. NapCat
if (Test-OneBotPort -Port $port) {
    Write-Host ("NapCat 已在运行（127.0.0.1:{0} 可连接），跳过启动。" -f $port) -ForegroundColor Green
} else {
    $launcher = Join-Path $root 'napcat\shell\launcher.bat'
    if (-not (Test-Path $launcher)) {
        Write-Host ("找不到 NapCat 启动器：{0}" -f $launcher) -ForegroundColor Red
        Write-Host '请先把 NapCat.Shell 解压到 napcat\shell\ 下。'
        exit 1
    }

    Write-Host '正在以管理员身份启动 NapCat（会弹 UAC，请点「是」）……' -ForegroundColor Yellow
    $launchAt = (Get-Date).AddSeconds(-2)
    try {
        Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher) -Verb RunAs
    } catch {
        Write-Host ('NapCat 启动失败（UAC 被拒绝？）：' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }

    $deadline = (Get-Date).AddSeconds(180)
    Write-Host -NoNewline ("等待 NapCat 的 OneBot 端口 {0} " -f $port)
    $ok = $false
    $shownQr = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-OneBotPort -Port $port) { $ok = $true; break }

        # 盯二维码：NapCat 每次刷新都会重写 qrcode.png，出现新的就画一次
        if (Test-Path $qrPath) {
            $info = Get-Item $qrPath
            if ($info.LastWriteTime -ge $launchAt -and $info.LastWriteTime -ne $shownQr) {
                $shownQr = $info.LastWriteTime
                Write-Host ''
                Show-QrCode -Path $qrPath
                Write-Host -NoNewline ('继续等待端口 {0} ' -f $port)
            }
        }

        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 2
    }
    Write-Host ''
    if (-not $ok) {
        Write-Host ("等了三分钟，端口 {0} 还是没起来。" -f $port) -ForegroundColor Red
        Write-Host '看一眼 NapCat 那个窗口：是不是停在扫码登录，或者报了 QQ 版本不匹配。'
        Write-Host ('二维码也可以随时单独画出来：show-qrcode.cmd  文件在 ' + $qrPath) -ForegroundColor Yellow
        exit 1
    }
    Write-Host 'NapCat 端口已就绪。' -ForegroundColor Green
}

# 2. 机器人
if ($running) {
    Write-Host ("机器人已经在跑了（pid {0}），不重复启动，只补 NapCat。" -f (($running | ForEach-Object { $_.ProcessId }) -join ',')) -ForegroundColor Yellow
    Write-Host '它自己会重连，不用管。要重启就先关掉它那个窗口。'
    exit 0
}

$node = Resolve-Node
if (-not $node) {
    Write-Host '找不到 node.exe（PATH 里没有，也没有 D:\nodejs\node.exe）。' -ForegroundColor Red
    exit 1
}

Write-Host '正在启动机器人……' -ForegroundColor Yellow
Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $root 'bot.mjs') + '"') -WorkingDirectory $root

Start-Sleep -Seconds 2
Write-Host ''
Write-Host '已启动。接下来：' -ForegroundColor Cyan
Write-Host '  - 机器人在新开的那窗口里跑，日志：logs\bot-YYYY-MM-DD.jsonl'
Write-Host '  - NapCat 那个窗口不要关（关了 OneBot 就断，机器人会自动重连等待）'
Write-Host '  - 二维码想再看：双击 show-qrcode.cmd'
Write-Host '  - 要停：关掉机器人窗口（或 Ctrl+C）；NapCat 用 napcat\shell\KillQQ.bat'
