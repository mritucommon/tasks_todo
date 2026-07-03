# Makes the Task List server start automatically at every logon by placing a
# shortcut in the current user's Startup folder. No admin rights required.
# Run:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$ErrorActionPreference = 'Stop'

$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "Launcher not found: $vbs" }

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'TaskListLive.lnk'

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath       = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments        = '"{0}"' -f $vbs
$lnk.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$lnk.WindowStyle      = 7   # minimized / hidden
$lnk.Description       = 'Starts the Task List Live server at logon.'
$lnk.Save()

Write-Host "Installed startup entry: $lnkPath"
Write-Host "The server will start automatically the next time you log in."
Write-Host "To start it right now:  wscript `"$vbs`""
