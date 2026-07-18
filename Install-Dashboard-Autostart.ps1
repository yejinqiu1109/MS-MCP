$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'MS-MCP Dashboard.lnk'
$launcher = Join-Path $root 'Start-MS-MCP-Dashboard-Background.vbs'

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Background launcher was not found: $launcher"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\wscript.exe"
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'Start the MS-MCP Dashboard after Windows sign-in'
$shortcut.WindowStyle = 7
$shortcut.Save()

[pscustomobject]@{
    Installed = Test-Path -LiteralPath $shortcutPath
    Shortcut = $shortcutPath
    Target = $shortcut.TargetPath
    Arguments = $shortcut.Arguments
}
