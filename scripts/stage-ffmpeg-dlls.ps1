<#
 Copies the FFmpeg runtime DLLs Clypra links against (from vcpkg) into src-tauri/ffmpeg-dlls/,
 so the release bundle can install them next to clypra.exe. Without them the installed app
 cannot start (Windows shows a "missing avcodec-62.dll" dialog and no window ever appears).

 Usage:  powershell -File scripts/stage-ffmpeg-dlls.ps1   (VCPKG_ROOT defaults to C:\vcpkg)
#>
$ErrorActionPreference = "Stop"
$vcpkg = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } else { "C:\vcpkg" }
$bin = Join-Path $vcpkg "installed\x64-windows\bin"
if (-not (Test-Path $bin)) { throw "vcpkg FFmpeg binaries not found at $bin (set VCPKG_ROOT)" }

$dest = Join-Path $PSScriptRoot "..\src-tauri\ffmpeg-dlls"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem $dest -Filter *.dll | Remove-Item -Force

$dlls = Get-ChildItem $bin -Filter *.dll | Where-Object { $_.Name -notlike "pkgconf*" }
if (-not ($dlls | Where-Object { $_.Name -like "avcodec-*" })) { throw "avcodec DLL missing in $bin" }
$dlls | Copy-Item -Destination $dest
"Staged $($dlls.Count) DLL(s) into $dest : " + (($dlls | ForEach-Object Name) -join ", ")
