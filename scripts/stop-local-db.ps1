[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskLocalRoot = Join-Path $taskWorkspace '.local'
$taskDataRoot = Join-Path $taskLocalRoot 'postgres-data'
$taskPgCtlPath = Join-Path $taskLocalRoot 'postgres\bin\pg_ctl.exe'

if (!(Test-Path -LiteralPath $taskPgCtlPath) -or !(Test-Path -LiteralPath (Join-Path $taskDataRoot 'PG_VERSION'))) {
    Write-Host 'Локальный PostgreSQL этого проекта ещё не создан.'
    exit 0
}

& $taskPgCtlPath -D $taskDataRoot status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Локальный PostgreSQL этого проекта уже остановлен.'
    exit 0
}

$taskStopArguments = @('-D', "`"$taskDataRoot`"", '-m', 'fast', '-w', '-t', '30', 'stop')
$taskStopProcess = Start-Process -FilePath $taskPgCtlPath -ArgumentList $taskStopArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLocalRoot 'pgctl-stop.log') -RedirectStandardError (Join-Path $taskLocalRoot 'pgctl-stop-error.log')
$null = $taskStopProcess.Handle
if (!$taskStopProcess.WaitForExit(35000)) { throw 'Остановка PostgreSQL не завершилась за 35 секунд. Диагностика: .local/pgctl-stop-error.log.' }
if ($taskStopProcess.ExitCode -ne 0) { throw 'Не удалось остановить локальный PostgreSQL. Диагностика: .local/pgctl-stop-error.log.' }
Write-Host 'Локальный PostgreSQL остановлен. Данные в .local/postgres-data сохранены.'
