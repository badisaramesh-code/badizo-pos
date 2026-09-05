$ErrorActionPreference = 'Stop'
$taskName = 'Badizo Daily Drive Backup'
$task = Get-ScheduledTask -TaskName $taskName
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
Set-ScheduledTask -TaskName $taskName -Settings $settings | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  User = $task.Principal.UserId
  DailyInterval = $task.Triggers.DaysInterval
  StartBoundary = $task.Triggers.StartBoundary
  EndBoundary = $task.Triggers.EndBoundary
  ExecutionTimeLimit = $task.Settings.ExecutionTimeLimit
  NextRun = $info.NextRunTime
} | Format-List | Out-String | Set-Content -LiteralPath 'D:\badizo-pos-main\tools\repair-badizo-daily-backup-task.result.txt'