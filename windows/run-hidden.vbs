' Starts the the pod control server with no console window, appending output to data\server.log.
' Used by the "the pod control" scheduled task:  wscript run-hidden.vbs "C:\path\to\node.exe"
Option Explicit
Dim fso, sh, appDir, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(appDir & "\data") Then fso.CreateFolder appDir & "\data"
nodeExe = "node"
If WScript.Arguments.Count > 0 Then nodeExe = WScript.Arguments(0)
sh.CurrentDirectory = appDir
sh.Run "cmd /c """"" & nodeExe & """ server.js >> data\server.log 2>&1""", 0, False
