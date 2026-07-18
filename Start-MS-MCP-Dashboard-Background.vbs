Option Explicit

Dim shell, fso, root, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(root, "Start-MS-MCP-Dashboard.bat")
command = "cmd.exe /d /c """ & scriptPath & """ --background"
shell.Run command, 0, False
