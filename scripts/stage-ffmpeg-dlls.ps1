<#
 Stages everything FFmpeg-related the Windows bundle must install next to clypra.exe, in
 src-tauri/ffmpeg-runtime/ :
   - the FFmpeg runtime DLLs Clypra links against (from vcpkg),
   - ffmpeg.exe and ffprobe.exe (from PATH, e.g. the winget Gyan build) so exports and audio
     probing do not depend on the user having FFmpeg installed. Without them the installed app
 cannot start (Windows shows a "missing avcodec-62.dll" dialog and no window ever appears).

 Usage:  powershell -File scripts/stage-ffmpeg-runtime.ps1   (VCPKG_ROOT defaults to C:\vcpkg)
#>
$ErrorActionPreference = "Stop"
$vcpkg = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } else { "C:\vcpkg" }
$bin = Join-Path $vcpkg "installed\x64-windows\bin"
if (-not (Test-Path $bin)) { throw "vcpkg FFmpeg binaries not found at $bin (set VCPKG_ROOT)" }

$dest = Join-Path $PSScriptRoot "..\src-tauri\ffmpeg-runtime"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem $dest -Filter *.dll | Remove-Item -Force

$dlls = Get-ChildItem $bin -Filter *.dll | Where-Object { $_.Name -notlike "pkgconf*" }
if (-not ($dlls | Where-Object { $_.Name -like "avcodec-*" })) { throw "avcodec DLL missing in $bin" }
$dlls | Copy-Item -Destination $dest
foreach ($tool in @("ffmpeg", "ffprobe")) {
    $cmd = Get-Command "$tool.exe" -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq "Application" } | Select-Object -First 1
    if (-not $cmd) { throw "$tool.exe not found on PATH (install FFmpeg, e.g. winget install Gyan.FFmpeg)" }
    if ($cmd.Source -like "*Clypra*") { throw "$tool.exe resolved to a Clypra copy; put a real FFmpeg on PATH" }
    Copy-Item $cmd.Source -Destination $dest
}
"Staged into ${dest}: " + ((Get-ChildItem $dest | ForEach-Object { "$($_.Name) ($([math]::Round($_.Length/1MB,1)) MB)" }) -join ", ")
