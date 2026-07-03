# Removes the Startup-folder entry created by install-autostart.ps1.
# Run:   powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'TaskListLive.lnk'
Remove-Item $lnkPath -Force -ErrorAction SilentlyContinue
Write-Host "Removed startup entry (server will no longer start at logon)."
