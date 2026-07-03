' Silent launcher for "Task List — Live".
' Starts the Node server with no visible console window and logs to data\autostart.log.
' Path-independent: it locates the project root from its own location.
Dim fso, sh, scriptDir, projectDir
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\scripts
projectDir = fso.GetParentFolderName(scriptDir)                 ' project root
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = projectDir
' 0 = hidden window, False = do not wait for it to finish
sh.Run "cmd /c node ""server\server.js"" >> ""data\autostart.log"" 2>&1", 0, False
