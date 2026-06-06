# installer.ps1 — Installe Python (si absent) et les dépendances pour Alerte Emploi

Write-Host ""
Write-Host "=== Alerte Emploi - Installation ===" -ForegroundColor Cyan

# ── 1. Chercher Python ─────────────────────────────────────────────────────────
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

# Essayer aussi via PATH
if (-not $PythonExe) {
    $found = Get-Command py -ErrorAction SilentlyContinue
    if ($found) { $PythonExe = $found.Source }
}

# ── 2. Installer Python si absent ──────────────────────────────────────────────
if (-not $PythonExe) {
    Write-Host ""
    Write-Host "Python n'est pas installe sur ce poste." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "ETAPE 1 : Telecharger et installer Python"
    Write-Host "  -> https://www.python.org/downloads/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  IMPORTANT lors de l'installation :"
    Write-Host "  [X] Cochez 'Add Python to PATH'" -ForegroundColor Green
    Write-Host "      (case en bas de l'ecran d'installation)" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Apres l'installation, relancez ce script." -ForegroundColor Yellow
    Write-Host ""
    $open = Read-Host "Ouvrir la page de telechargement maintenant ? (O/N)"
    if ($open -eq "O" -or $open -eq "o") {
        Start-Process "https://www.python.org/downloads/"
    }
    pause
    exit 0
}

Write-Host "Python trouve : $PythonExe" -ForegroundColor Green
& $PythonExe --version

# ── 3. Installer les packages ──────────────────────────────────────────────────
Write-Host ""
Write-Host "Installation des packages Python..." -ForegroundColor Cyan
& $PythonExe -m pip install --upgrade pip feedparser requests beautifulsoup4 lxml

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Installation reussie !" -ForegroundColor Green
    Write-Host ""
    Write-Host "ETAPE SUIVANTE : Lancer planifier.ps1 pour activer la surveillance automatique."
    Write-Host "  Ou testez maintenant : & '$PythonExe' '$PSScriptRoot\job_alert.py'"
} else {
    Write-Host "Erreur lors de l'installation. Verifiez votre connexion internet." -ForegroundColor Red
}

Write-Host ""
pause
