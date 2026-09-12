$ErrorActionPreference = 'Stop'
$taskPort = 18091
$taskExisting = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue
if (-not $taskExisting) {
    Start-Process -FilePath 'ssh.exe' -WindowStyle Hidden -ArgumentList @('-N','-L','127.0.0.1:18091:127.0.0.1:8091','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','StrictHostKeyChecking=yes','ecs-user@47.99.222.76')
    Start-Sleep -Seconds 2
}
if (-not (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue)) { throw 'SSH tunnel did not start. Check your SSH key and connection.' }
Start-Process 'http://127.0.0.1:18091/xueji/manage/'
