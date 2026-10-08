[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 5433)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLocalRoot = Join-Path $taskWorkspace '.local'
$taskBinaryRoot = Join-Path $taskLocalRoot 'postgres'
$taskDataRoot = Join-Path $taskLocalRoot 'postgres-data'
$taskRuntimePath = Join-Path $taskLocalRoot 'postgres-runtime.json'
$taskAdminPasswordPath = Join-Path $taskLocalRoot 'postgres-admin-password'
$taskEnvPath = Join-Path $taskWorkspace '.env'
$taskArchiveName = 'postgresql-17.11-5-windows-x64-binaries.zip'
$taskArchivePath = Join-Path $taskLocalRoot $taskArchiveName
$taskArchiveUrl = "https://get.enterprisedb.com/postgresql/$taskArchiveName"
# Published by EDB: https://github.com/EnterpriseDB/edb-installers/issues/731
$taskArchiveSha256 = '80379b2c04d51c30225532e0ae04509899141e9957ed096fe749d7fd9df8f82f'

function Protect-TaskPath([string]$Path, [bool]$Directory) {
    # A fresh DACL avoids copying audit/owner sections requiring admin privileges.
    $taskAcl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskInheritance = if ($Directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent().User,
        'FullControl', $taskInheritance, 'None', 'Allow'
    ))
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        'FullControl', $taskInheritance, 'None', 'Allow'
    ))
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        # Windows PowerShell 5.1 exposes these as instance methods.
        (Get-Item -LiteralPath $Path).SetAccessControl($taskAcl)
    } elseif ($Directory) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $taskAcl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $taskAcl)
    }
}

function New-TaskPassword {
    $taskBytes = New-Object byte[] 32
    $taskRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRandom.GetBytes($taskBytes) } finally { $taskRandom.Dispose() }
    return ([BitConverter]::ToString($taskBytes)).Replace('-', '').ToLowerInvariant()
}

function Read-TaskEnv([string]$Key) {
    if (!(Test-Path -LiteralPath $taskEnvPath)) { return $null }
    $taskMatch = Get-Content -LiteralPath $taskEnvPath | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if (!$taskMatch) { return $null }
    return (($taskMatch -split '=', 2)[1]).Trim().Trim('"').Trim("'")
}

function Write-TaskEnv([hashtable]$Values) {
    $taskSourcePath = if (Test-Path -LiteralPath $taskEnvPath) { $taskEnvPath } else { Join-Path $taskWorkspace '.env.example' }
    $taskLines = [Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath $taskSourcePath) {
        foreach ($taskLine in Get-Content -LiteralPath $taskSourcePath) { $taskLines.Add($taskLine) }
    }
    foreach ($taskKey in $Values.Keys) {
        $taskReplaced = $false
        for ($taskIndex = 0; $taskIndex -lt $taskLines.Count; $taskIndex++) {
            if ($taskLines[$taskIndex] -match "^\s*$taskKey\s*=") {
                $taskLines[$taskIndex] = "$taskKey=$($Values[$taskKey])"
                $taskReplaced = $true
            }
        }
        if (!$taskReplaced) { $taskLines.Add("$taskKey=$($Values[$taskKey])") }
    }
    [IO.File]::WriteAllLines($taskEnvPath, $taskLines, [Text.UTF8Encoding]::new($false))
    Protect-TaskPath $taskEnvPath $false
}

New-Item -ItemType Directory -Path $taskLocalRoot -Force | Out-Null
Protect-TaskPath $taskLocalRoot $true

if (!(Test-Path -LiteralPath (Join-Path $taskBinaryRoot 'bin\postgres.exe'))) {
    if (!(Test-Path -LiteralPath $taskArchivePath)) {
        Write-Host 'Загрузка официальных Windows-бинарников PostgreSQL 17.11 (EDB)...'
        Invoke-WebRequest -Uri $taskArchiveUrl -OutFile $taskArchivePath
    }
    $taskActualSha256 = (Get-FileHash -LiteralPath $taskArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($taskActualSha256 -ne $taskArchiveSha256) {
        throw 'SHA-256 архива PostgreSQL не совпадает с опубликованным EDB. Бинарники не будут запущены.'
    }
    # Extract only server/client binaries, libraries and extension definitions.
    # Every destination is checked against the project's private runtime path.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskZip = [IO.Compression.ZipFile]::OpenRead($taskArchivePath)
    try {
        foreach ($taskEntry in $taskZip.Entries) {
            if ($taskEntry.FullName -notmatch '^pgsql/(bin|lib|share)/' -or !$taskEntry.Name) { continue }
            $taskRelativePath = $taskEntry.FullName.Substring('pgsql/'.Length).Replace('/', [IO.Path]::DirectorySeparatorChar)
            $taskDestination = [IO.Path]::GetFullPath((Join-Path $taskBinaryRoot $taskRelativePath))
            if (!$taskDestination.StartsWith($taskBinaryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Архив содержит путь вне каталога локального PostgreSQL.'
            }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($taskDestination)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($taskEntry, $taskDestination, $true)
        }
    } finally { $taskZip.Dispose() }
    Write-Host 'Архив PostgreSQL проверен по SHA-256; сервер распакован в .local/postgres.'
}

$taskPgCtlPath = Join-Path $taskBinaryRoot 'bin\pg_ctl.exe'
$taskPsqlPath = Join-Path $taskBinaryRoot 'bin\psql.exe'
$taskNewRuntime = !(Test-Path -LiteralPath $taskRuntimePath)

if ($taskNewRuntime) {
    if (Test-Path -LiteralPath (Join-Path $taskDataRoot 'PG_VERSION')) {
        throw 'Уже существует кластер без метаданных проекта. Он не будет переинициализирован.'
    }
    $taskExistingUrl = Read-TaskEnv 'DATABASE_URL'
    if ($taskExistingUrl -and $taskExistingUrl -notmatch '^postgresql://romeo:romeo_demo_only@(localhost|127\.0\.0\.1):5432/romeo') {
        throw '.env уже содержит другое подключение к базе. Локальный скрипт не будет его заменять.'
    }
    $taskPortAvailable = $false
    for ($taskCandidatePort = $Port; $taskCandidatePort -lt [Math]::Min($Port + 100, 65536); $taskCandidatePort++) {
        $taskListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $taskCandidatePort)
        try { $taskListener.Start(); $taskPortAvailable = $true; $Port = $taskCandidatePort; break }
        catch [Net.Sockets.SocketException] { }
        finally { $taskListener.Stop() }
    }
    if (!$taskPortAvailable) { throw 'Не найден свободный локальный порт для PostgreSQL.' }
    $taskAppPassword = New-TaskPassword
    $taskAdminPassword = New-TaskPassword
    [IO.File]::WriteAllText($taskAdminPasswordPath, $taskAdminPassword, [Text.UTF8Encoding]::new($false))
    Protect-TaskPath $taskAdminPasswordPath $false
    Write-TaskEnv @{
        DATABASE_URL = "`"postgresql://romeo:$taskAppPassword@127.0.0.1:$Port/romeo?schema=public`""
        POSTGRES_USER = 'romeo'
        POSTGRES_DB = 'romeo'
        POSTGRES_PASSWORD = $taskAppPassword
        POSTGRES_PORT = "$Port"
    }
    $taskRuntime = [pscustomobject]@{ version = '17.11-5'; port = $Port; database = 'romeo'; user = 'romeo'; archiveSha256 = $taskArchiveSha256 }
    [IO.File]::WriteAllText($taskRuntimePath, ($taskRuntime | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} else {
    $taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw | ConvertFrom-Json
    if ($PSBoundParameters.ContainsKey('Port') -and $Port -ne $taskRuntime.port) {
        throw 'Порт существующего кластера отличается. Скрипт не меняет его автоматически.'
    }
    $Port = [int]$taskRuntime.port
    $taskAdminPassword = [IO.File]::ReadAllText($taskAdminPasswordPath)
}

$taskDatabaseUrl = Read-TaskEnv 'DATABASE_URL'
try { $taskDatabaseUri = [Uri]$taskDatabaseUrl } catch { throw 'Некорректное подключение PostgreSQL в .env.' }
if ($taskDatabaseUri.Host -ne '127.0.0.1' -or $taskDatabaseUri.Port -ne $Port -or $taskDatabaseUri.AbsolutePath -ne '/romeo' -or $taskDatabaseUri.UserInfo -notmatch '^romeo:') {
    throw '.env не соответствует локальному кластеру проекта. Скрипт не будет менять подключение.'
}
$taskAppPassword = [Uri]::UnescapeDataString(($taskDatabaseUri.UserInfo -split ':', 2)[1])

if (!(Test-Path -LiteralPath (Join-Path $taskDataRoot 'PG_VERSION'))) {
    $taskInitDbPath = Join-Path $taskBinaryRoot 'bin\initdb.exe'
    & $taskInitDbPath -D $taskDataRoot --username=romeo_admin --pwfile=$taskAdminPasswordPath --auth=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать локальный кластер PostgreSQL.' }
}

& $taskPgCtlPath -D $taskDataRoot status *> $null
if ($LASTEXITCODE -ne 0) {
    $taskPgCtlArguments = @('-D', "`"$taskDataRoot`"", '-l', "`"$(Join-Path $taskLocalRoot 'postgres.log')`"", '-o', "`"-h 127.0.0.1 -p $Port`"", '-w', '-t', '30', 'start')
    # Start-Process -Wait waits for the whole descendant process tree on Windows.
    # PostgreSQL deliberately outlives pg_ctl, so wait only for pg_ctl itself.
    $taskStartProcess = Start-Process -FilePath $taskPgCtlPath -ArgumentList $taskPgCtlArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLocalRoot 'pgctl-start.log') -RedirectStandardError (Join-Path $taskLocalRoot 'pgctl-start-error.log')
    # Retain the handle before exit so Windows PowerShell 5.1 can read ExitCode.
    $null = $taskStartProcess.Handle
    if (!$taskStartProcess.WaitForExit(35000)) { throw 'Запуск PostgreSQL не завершился за 35 секунд. Диагностика: .local/postgres.log.' }
    if ($taskStartProcess.ExitCode -ne 0) { throw 'Не удалось запустить PostgreSQL. Диагностика: .local/postgres.log.' }
}

$taskPreviousPgPassword = $env:PGPASSWORD
try {
    $env:PGPASSWORD = $taskAdminPassword
    $taskRoleExists = & $taskPsqlPath -h 127.0.0.1 -p $Port -U romeo_admin -d postgres -w -t -A -c "SELECT 1 FROM pg_roles WHERE rolname='romeo';"
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить локальный PostgreSQL.' }
    if ($taskRoleExists -ne '1') {
        # Secrets travel through stdin and protected environment, never CLI args.
        "CREATE ROLE romeo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$taskAppPassword';" | & $taskPsqlPath -h 127.0.0.1 -p $Port -U romeo_admin -d postgres -w -v ON_ERROR_STOP=1 --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать роль приложения.' }
    }
    $taskDatabaseExists = & $taskPsqlPath -h 127.0.0.1 -p $Port -U romeo_admin -d postgres -w -t -A -c "SELECT 1 FROM pg_database WHERE datname='romeo';"
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить базу приложения.' }
    if ($taskDatabaseExists -ne '1') {
        & $taskPsqlPath -h 127.0.0.1 -p $Port -U romeo_admin -d postgres -w -v ON_ERROR_STOP=1 -c 'CREATE DATABASE romeo OWNER romeo;'
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать базу приложения.' }
    }
    $env:PGPASSWORD = $taskAppPassword
    & $taskPsqlPath -h 127.0.0.1 -p $Port -U romeo -d romeo -w -t -A -c 'SELECT current_database(), current_user, version();'
    if ($LASTEXITCODE -ne 0) { throw 'Проверка подключения приложения к PostgreSQL не пройдена.' }
} finally {
    $env:PGPASSWORD = $taskPreviousPgPassword
}

Write-Host "PostgreSQL готов: 127.0.0.1:$Port, база romeo. Пароли сохранены в защищённых локальных файлах."
Write-Host 'Далее: npm run db:generate; npm run db:migrate; npm run db:seed.'
