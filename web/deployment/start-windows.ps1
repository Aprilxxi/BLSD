[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 4175,
    [string]$NodePath = '',
    [string]$Rscript = '',
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [switch]$Rebuild,
    [switch]$Stop,
    [ValidateRange(1, 120)][int]$StopTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$entry = Join-Path $projectRoot 'server\index.mjs'
$stateDirectory = Join-Path $projectRoot 'server\.launcher'
$recordPath = Join-Path $stateDirectory ("windows-{0}.json" -f $Port)
$stopRequestPath = Join-Path $stateDirectory ("windows-{0}.stop.json" -f $Port)
$url = "http://127.0.0.1:$Port/"
$serviceProcess = $null
$lockHeld = $false
$lock = $null

function Find-Node {
    $candidates = @()
    if ($NodePath) { $candidates += $NodePath }
    else {
        $command = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($command) { $candidates += $command.Source }
        $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
        if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
        if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $versionText = & $candidate --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+)\.(\d+)\.') {
                if ([int]$Matches[1] -gt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 12)) {
                    return (Resolve-Path -LiteralPath $candidate).Path
                }
            }
        } catch { continue }
    }
    throw 'Node.js >=22.12 was not found. Install Node.js, or pass -NodePath with its full executable path.'
}

function Find-Rscript {
    if ($Rscript) {
        if (!(Test-Path -LiteralPath $Rscript -PathType Leaf)) { throw "Rscript not found: $Rscript" }
        return (Resolve-Path -LiteralPath $Rscript).Path
    }
    if ($env:BLSD_RSCRIPT -and (Test-Path -LiteralPath $env:BLSD_RSCRIPT -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:BLSD_RSCRIPT).Path
    }
    $command = Get-Command Rscript.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bases = @((Join-Path ([IO.Path]::GetPathRoot($projectRoot)) 'Program Files\R'))
    if ($env:ProgramFiles) { $bases += (Join-Path $env:ProgramFiles 'R') }
    if ($env:LOCALAPPDATA) { $bases += (Join-Path $env:LOCALAPPDATA 'Programs\R') }
    foreach ($base in ($bases | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $base -PathType Container)) { continue }
        $versions = Get-ChildItem -LiteralPath $base -Directory | Sort-Object Name -Descending
        foreach ($version in $versions) {
            foreach ($suffix in @('bin\Rscript.exe', 'bin\x64\Rscript.exe')) {
                $candidate = Join-Path $version.FullName $suffix
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            }
        }
    }
    throw 'Rscript.exe was not found. Install R, or pass -Rscript with its full executable path.'
}

function Test-Website {
    try {
        $health = Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 5 -UseBasicParsing
        $page = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing
        return ($health.available -eq $true -and $page.Content -match '<title>BLSD (?:Tool|Studio)</title>')
    } catch { return $false }
}

function Open-Website {
    if (!$NoBrowser) {
        try { Start-Process -FilePath $url }
        catch { Write-Warning "The browser could not be opened automatically. Open $url manually." }
    }
}

function Get-OwnedProcess($record) {
    if ($record.projectRoot -ne $projectRoot -or [int]$record.port -ne $Port -or $record.entry -ne $entry) {
        throw 'The saved process record does not belong to this project and port.'
    }
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$record.processId)
    if (!$current) { return $null }
    $expectedArgument = '(?:^|\s)"?' + [regex]::Escape($entry) + '"?(?=\s|$)'
    $createdUtc = ([datetime]$current.CreationDate).ToUniversalTime().Ticks
    if ($current.ExecutablePath -ne $record.nodePath -or $current.CommandLine -notmatch $expectedArgument -or
        [string]$createdUtc -ne [string]$record.creationUtcTicks) {
        throw 'Process identity changed. Refusing to stop or adopt an unrelated process.'
    }
    return $current
}

function Get-ProcessIdentity($process) {
    return [pscustomobject]@{
        processId = [int]$process.ProcessId
        parentProcessId = [int]$process.ParentProcessId
        executablePath = [string]$process.ExecutablePath
        commandLine = [string]$process.CommandLine
        creationUtcTicks = [string](([datetime]$process.CreationDate).ToUniversalTime().Ticks)
    }
}

function Get-MatchingProcess($identity) {
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f [int]$identity.processId)
    if (!$current) { return $null }
    $actual = Get-ProcessIdentity $current
    if ($actual.creationUtcTicks -ne $identity.creationUtcTicks -or
        $actual.executablePath -ne $identity.executablePath -or
        $actual.commandLine -ne $identity.commandLine -or
        $actual.parentProcessId -ne $identity.parentProcessId) { return $null }
    return $current
}

function Add-OwnedDescendants($rootProcess, $tracked) {
    # Capture the tree while its root is verified. Creation times rule out a
    # reused parent PID; every child is rechecked again before termination.
    $snapshot = @(Get-CimInstance Win32_Process)
    $rootIdentity = Get-ProcessIdentity $rootProcess
    if (!(Get-MatchingProcess $rootIdentity)) { return }
    $parents = @($rootIdentity)
    while ($parents.Count -gt 0) {
        $next = @()
        foreach ($parent in $parents) {
            foreach ($child in $snapshot) {
                if ([int]$child.ParentProcessId -ne $parent.processId) { continue }
                $identity = Get-ProcessIdentity $child
                if ([long]$identity.creationUtcTicks -lt [long]$parent.creationUtcTicks -or
                    !$identity.executablePath -or !$identity.commandLine -or
                    $tracked.ContainsKey($identity.processId)) { continue }
                $tracked[$identity.processId] = $identity
                $next += $identity
            }
        }
        $parents = $next
    }
}

function Stop-OwnedService($record) {
    $current = Get-OwnedProcess $record
    if (!$current) { return }
    $children = @{}
    Add-OwnedDescendants $current $children
    $graceful = $record.stopToken -match '^[a-f0-9]{64}$' -and $record.stopFile -eq $stopRequestPath
    if ($graceful) {
        if (Test-Path -LiteralPath $stopRequestPath) {
            $existing = Get-Item -LiteralPath $stopRequestPath -Force
            if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a symbolic link at the stop-request path.' }
        }
        [ordered]@{ token = $record.stopToken; processId = [int]$record.processId } |
            ConvertTo-Json | Set-Content -LiteralPath $stopRequestPath -Encoding UTF8
        $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
        do {
            $current = Get-OwnedProcess $record
            if ($current) { Add-OwnedDescendants $current $children }
            $runningChildren = @($children.Values | Where-Object { Get-MatchingProcess $_ })
            if (!$current -and $runningChildren.Count -eq 0) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
    }
    $current = Get-OwnedProcess $record
    if ($current) { Add-OwnedDescendants $current $children }
    # Descendants first: ending Node alone can leave a long-running R job.
    foreach ($identity in ($children.Values | Sort-Object { [long]$_.creationUtcTicks } -Descending)) {
        $child = Get-MatchingProcess $identity
        if ($child) { Stop-Process -Id $child.ProcessId -ErrorAction Stop }
    }
    $current = Get-OwnedProcess $record
    if ($current) { Stop-Process -Id $current.ProcessId -ErrorAction Stop }
    if ($graceful -and (Test-Path -LiteralPath $stopRequestPath)) {
        $request = Get-Content -LiteralPath $stopRequestPath -Raw | ConvertFrom-Json
        if ($request.token -eq $record.stopToken -and [int]$request.processId -eq [int]$record.processId) {
            Remove-Item -LiteralPath $stopRequestPath
        }
    }
}

try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
    finally { $sha.Dispose() }
    $lock = New-Object Threading.Mutex($false, "Local\BLSD_Studio_${key}_$Port")
    try { $lockHeld = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockHeld = $true }
    if (!$lockHeld) { throw 'Another start/stop operation is in progress. Please retry shortly.' }

    if ($Stop) {
        if ((Test-Path -LiteralPath $stateDirectory) -and
            ((Get-Item -LiteralPath $stateDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing a symbolic link at the launcher state directory.'
        }
        if (!(Test-Path -LiteralPath $recordPath)) {
            Write-Host "No service managed by this launcher on port $Port. Existing services were left running."
            exit 0
        }
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        Stop-OwnedService $record
        Remove-Item -LiteralPath $recordPath
        Write-Host "BLSD Tool stopped on port $Port."
        exit 0
    }

    $nodeExecutable = Find-Node
    $rExecutable = Find-Rscript
    Set-Location -LiteralPath $projectRoot
    $env:BLSD_RSCRIPT = $rExecutable
    $env:PORT = [string]$Port
    $builtIndex = Join-Path $projectRoot 'dist\client\index.html'
    if ($Rebuild -or !(Test-Path -LiteralPath $builtIndex)) {
        $vite = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
        if (!(Test-Path -LiteralPath $vite)) { throw 'The prebuilt website is missing. Extract the full release, or install frontend dependencies before rebuilding.' }
        Write-Host 'Building the website...'
        & $nodeExecutable $vite build --configLoader native
        if ($LASTEXITCODE -ne 0) { throw 'Website build failed.' }
        & $nodeExecutable (Join-Path $projectRoot 'scripts\prepare-sites-build.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Build preparation failed.' }
    }
    Write-Host "Node: $nodeExecutable"
    Write-Host "R:    $rExecutable"
    & $nodeExecutable (Join-Path $projectRoot 'deployment\check-environment.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Environment check failed. Resolve the package/file errors shown above before starting.' }
    if ($CheckOnly) { Write-Host 'Ready to start BLSD Tool.'; exit 0 }

    if (Test-Website) {
        Write-Host "BLSD Tool is already available: $url"
        Write-Host 'Reusing the website; this does not take ownership of an existing service.'
        Open-Website
        exit 0
    }
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is occupied or the existing service is unhealthy. It was not stopped. Use -Port with another port." }
    finally { $listener.Stop() }

    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    if ((Get-Item -LiteralPath $stateDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Refusing a symbolic link at the launcher state directory.'
    }
    if (Test-Path -LiteralPath $recordPath) {
        $previous = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if (Get-OwnedProcess $previous) { throw 'The previous managed process is still running but not healthy. Use the stop launcher first, or choose another port.' }
        Remove-Item -LiteralPath $recordPath
    }
    $stdout = Join-Path $stateDirectory ("windows-{0}.log" -f $Port)
    $stderr = Join-Path $stateDirectory ("windows-{0}-error.log" -f $Port)
    $secretBytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($secretBytes) } finally { $random.Dispose() }
    $stopToken = ([BitConverter]::ToString($secretBytes)).Replace('-', '').ToLowerInvariant()
    $env:BLSD_LAUNCHER_STOP_TOKEN = $stopToken
    $env:BLSD_LAUNCHER_STOP_FILE = $stopRequestPath
    $serviceProcess = Start-Process -FilePath $nodeExecutable -ArgumentList ('"{0}"' -f $entry) `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr -PassThru
    $identity = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $serviceProcess.Id)
    if (!$identity) { throw "The service exited during startup. See $stderr" }
    $record = [ordered]@{
        projectRoot = $projectRoot; entry = $entry; port = $Port
        processId = $serviceProcess.Id; nodePath = $nodeExecutable
        creationUtcTicks = [string](([datetime]$identity.CreationDate).ToUniversalTime().Ticks)
        stopToken = $stopToken; stopFile = $stopRequestPath
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $serviceProcess.Refresh()
        if ($serviceProcess.HasExited) { throw "The service exited. See $stderr" }
        if (Test-Website) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$ready) { throw "The service did not become ready within 45 seconds. See $stderr" }
    Write-Host "BLSD Tool is ready: $url"
    Write-Host "Logs: $stateDirectory"
    Write-Host 'The service continues running after this window closes. Use the stop launcher to stop it.'
    $serviceProcess = $null
    Open-Website
    exit 0
} catch {
    if ($serviceProcess) {
        try {
            if ($record -and $record.processId -eq $serviceProcess.Id) { Stop-OwnedService $record }
            elseif (!$serviceProcess.HasExited) { $serviceProcess.Kill() }
        } catch { }
        if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath -ErrorAction SilentlyContinue }
    }
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($lockHeld) { $lock.ReleaseMutex() }
    if ($lock) { $lock.Dispose() }
}
