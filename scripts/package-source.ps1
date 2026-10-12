$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $projectRoot
try {
    # Include current fixes and new documentation, without Git history or ignored data.
    $sourceFiles = @(& git -c core.quotepath=false ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0 -or $sourceFiles.Count -eq 0) { throw 'Cannot enumerate source files with Git.' }
    $sourceFiles = @($sourceFiles | Sort-Object -Unique)
    $packageId = 'romeo-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $stagingRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.local/' + $packageId)))
    $artifactRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts'))
    $projectPrefix = $projectRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($targetRoot in @($stagingRoot, $artifactRoot)) {
        if (-not $targetRoot.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay in the project.' }
    }
    New-Item -ItemType Directory -Path $stagingRoot, $artifactRoot -Force | Out-Null
    foreach ($relativePath in $sourceFiles) {
        $normalizedPath = $relativePath.Replace('\', '/')
        if ($normalizedPath -match '(^|/)(\.git|\.local|artifacts|node_modules|\.next|out)(/|$)' -or
            $normalizedPath -match '^src/generated/' -or
            ($normalizedPath -match '(^|/)\.env($|\.)' -and $normalizedPath -ne '.env.example') -or
            $normalizedPath -match '\.(dump|backup|pem|key|log|tsbuildinfo)$') {
            throw "Excluded data unexpectedly listed by Git: $normalizedPath"
        }
        $sourcePath = [IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
        $destinationPath = [IO.Path]::GetFullPath((Join-Path $stagingRoot $relativePath))
        $stagingPrefix = $stagingRoot + [IO.Path]::DirectorySeparatorChar
        if (-not $sourcePath.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not $destinationPath.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid source path.' }
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destinationPath)) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
    }
    foreach ($requiredFile in @('package.json', 'package-lock.json', '.env.example', 'README.md', 'prisma/schema.prisma', 'docs/HANDOVER.md')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagingRoot $requiredFile) -PathType Leaf)) { throw "Missing package file: $requiredFile" }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archivePath = Join-Path $artifactRoot ($packageId + '.zip')
    [IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $archivePath)
    $digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($archivePath + '.sha256', $digest + '  ' + [IO.Path]::GetFileName($archivePath) + [Environment]::NewLine)
    [PSCustomObject]@{ archive = $archivePath; staging = $stagingRoot; sha256 = $digest } | ConvertTo-Json
} finally {
    Pop-Location
}
