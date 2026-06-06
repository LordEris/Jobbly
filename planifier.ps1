# planifier.ps1 — Configure Windows Task Scheduler pour lancer Alerte Emploi toutes les heures

$TaskName  = "AlerteEmploiPlomberie"
$ScriptDir = $PSScriptRoot
$ScriptPath = "$ScriptDir\job_alert.py"

Write-Host ""
Write-Host "=== Configuration de la surveillance automatique ===" -ForegroundColor Cyan

# ── Trouver Python ─────────────────────────────────────────────────────────────
$PythonPaths = @(
    "C:\Python313\python.exe",
    "C:\Python312\python.exe",
    "C:\Python311\python.exe",
    "C:\Python310\python.exe",
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python313\python.exe",
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe",
    "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python311\python.exe"
)

$PythonExe = $null
foreach ($p in $PythonPaths) {
    if (Test-Path $p) { $PythonExe = $p; break }
}
if (-not $PythonExe) {
    $found = Get-Command py -ErrorAction SilentlyContinue
    if ($found) { $PythonExe = $found.Source }
}
if (-not $PythonExe) {
    $found = Get-Command python -ErrorAction SilentlyContinue
    if ($found -and (& $found.Source --version 2>&1) -notmatch "not found") {
        $PythonExe = $found.Source
    }
}

if (-not $PythonExe) {
    Write-Host "ERREUR : Python introuvable. Lancez d'abord installer.ps1" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Python : $PythonExe" -ForegroundColor Green
Write-Host "Script : $ScriptPath"
Write-Host ""

# ── Supprimer l'ancienne tâche si elle existe ──────────────────────────────────
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# ── Créer la nouvelle tâche ────────────────────────────────────────────────────
$Action = New-ScheduledTaskAction `
    -Execute          $PythonExe `
    -Argument         "`"$ScriptPath`"" `
    -WorkingDirectory $ScriptDir

$StartTime = (Get-Date).AddMinutes(2)
$Trigger   = New-ScheduledTaskTrigger `
    -Once `
    -At                 $StartTime `
    -RepetitionInterval (New-TimeSpan -Hours 1) `
    -RepetitionDuration ([timespan]::MaxValue)

$Settings  = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit        (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable        `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances         IgnoreNew

try {
    Register-ScheduledTask `
        -TaskName    $TaskName `
        -Action      $Action `
        -Trigger     $Trigger `
        -Settings    $Settings `
        -Description "Surveillance offres emploi plomberie - Orleans / Tours" `
        -RunLevel    Limited | Out-Null

    Write-Host "Tache planifiee creee avec succes !" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Premiere execution : $($StartTime.ToString('dd/MM/yyyy HH:mm'))"
    Write-Host "  Frequence          : toutes les heures"
    Write-Host "  Rapport HTML       : $ScriptDir\rapport_offres.html"
    Write-Host ""
    Write-Host "Commandes utiles :" -ForegroundColor Gray
    Write-Host "  Voir la tache    : Get-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray
    Write-Host "  Lancer maintenant: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray
    Write-Host "  Supprimer        : Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false" -ForegroundColor Gray
} catch {
    Write-Host ""
    Write-Host "Erreur : $_" -ForegroundColor Red
    Write-Host "Essayez de relancer ce script en tant qu'Administrateur." -ForegroundColor Yellow
}

Write-Host ""

# Lancer immédiatement pour un premier rapport
$choix = Read-Host "Lancer une premiere recherche maintenant ? (O/N)"
if ($choix -eq "O" -or $choix -eq "o") {
    Write-Host "Lancement en cours..." -ForegroundColor Cyan
    & $PythonExe $ScriptPath
}

pause
