Option Explicit

Dim WshShell, fso, commandToRun, projectPath, splashPath

' 获取脚本所在的目录，假设 .vbs 文件在项目根目录
Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
splashPath = """" & projectPath & "\NativeSplash.exe"""
' 构建要执行的命令
' 我们将直接运行 electron，而不是通过 npm start 或 start.bat，以避免它们的窗口
' 确保 electron 在你的 PATH 环境变量中，或者使用 electron 的完整路径
' 如果 electron 是作为项目依赖安装的 (node_modules/.bin/electron)，可以使用 npx
commandToRun = "cmd /c cd /d """ & projectPath & """ && npx electron ."


Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = projectPath
If fso.FileExists(projectPath & "\.vcp_ready") Then fso.DeleteFile(projectPath & "\.vcp_ready"), True

' 先以隐藏窗口方式启动原生启动器
WshShell.Run splashPath, 0, False

' 然后再启动主应用
WshShell.Run commandToRun, 0, False

Set WshShell = Nothing
Set fso = Nothing
WScript.Quit
