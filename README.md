[![licence](https://img.shields.io/badge/licence-PolyForm%20NC%201.0-blueviolet)](LICENSE)
![langage](https://img.shields.io/badge/langage-Python%203-orange)
![plateforme](https://img.shields.io/badge/plateforme-Windows%2011-blue)
![sources](https://img.shields.io/badge/sources-5%20APIs-brightgreen)
![script](https://img.shields.io/badge/script-2%20113%20lignes-brightgreen)
![mots-clés](https://img.shields.io/badge/mots--cl%C3%A9s-5-brightgreen)

# 🔧 Jobbly — Alerte Emploi Automatique

Outil de veille automatique d'offres d'emploi — agrège, déduplique et présente les annonces de 5 sources en un seul rapport HTML interactif. Mots-clés et zones de recherche entièrement configurables, non stockés dans le dépôt.

Mis à jour en un clic ou automatiquement toutes les heures via le Planificateur de tâches Windows.

---

## ✨ Fonctionnalités

- **5 sources simultanées** — France Travail, La Bonne Alternance, Jooble, Careerjet, Adzuna
- **Déduplication en 3 passes** — URL exacte → titre + entreprise → similarité Jaccard/containment
- **Rapport HTML interactif** — cartes alignées, filtre alternance ON/OFF, navigation liste ↔ détail
- **Suivi de candidature** — statuts par offre (Postulé, En attente, Entretien, Accepté, Refusé)
- **Persistance des offres suivies** — les offres pour lesquelles vous avez postulé restent visibles même après expiration dans l'API
- **Signalement spam** — bouton « Fausse offre » par carte, masquage définitif
- **Paramètres éditables dans le navigateur** — mots-clés, villes, rayons de recherche
- **Serveur local intégré** — statuts et paramètres sauvegardés automatiquement sans quitter le navigateur
- **Sécurité** — CSRF (Origin check), SSRF (résolution DNS + IP), XSS (html.escape), CSP, écriture atomique

---

## 🗂️ Sources intégrées

| Source | Type | Clé requise |
|--------|------|-------------|
| [France Travail](https://francetravail.io/data/api) | API officielle | `FT_CLIENT_ID` + `FT_CLIENT_SECRET` |
| [La Bonne Alternance](https://api.apprentissage.beta.gouv.fr) | API gouvernementale | `LBA_API_KEY` |
| [Jooble](https://jooble.org/api/about) | Agrégateur mondial | `JOOBLE_API_KEY` |
| [Careerjet](https://www.careerjet.fr/partenaires/api) | Agrégateur FR | `CAREERJET_AFFID` |
| [Adzuna](https://developer.adzuna.com/signup) | Agrégateur mondial | `ADZUNA_APP_ID` + `ADZUNA_APP_KEY` |

Toutes les clés sont **gratuites** — voir la section Configuration.

---

## ⚙️ Installation

**Prérequis :** Python 3.10+ sur Windows 10/11

```bat
# 1. Cloner le dépôt
git clone https://github.com/LordEris/Jobbly.git
cd Jobbly

# 2. Installer les dépendances (double-cliquer ou exécuter dans un terminal)
installer.ps1
```

Ou manuellement :

```bat
pip install requests beautifulsoup4 lxml
```

---

## 🔑 Configuration

Créez un fichier `.env` à la racine du dossier (ne le partagez jamais) :

```env
# France Travail — https://francetravail.io/data/api
FT_CLIENT_ID=PAR_votre_id
FT_CLIENT_SECRET=votre_secret

# La Bonne Alternance — https://api.apprentissage.beta.gouv.fr
LBA_API_KEY=votre_clé

# Jooble — https://jooble.org/api/about
JOOBLE_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Careerjet — https://www.careerjet.fr/partenaires/api
CAREERJET_AFFID=votre_affid

# Adzuna — https://developer.adzuna.com/signup
ADZUNA_APP_ID=xxxxxxxx
ADZUNA_APP_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Paramètres de recherche (mots-clés et villes)

Les paramètres de recherche sont stockés dans `config.json` — ce fichier est dans `.gitignore` et ne sera jamais versionné (données personnelles).

Pour démarrer, copiez le fichier d'exemple fourni :

```bat
copy config.exemple.json config.json
```

Puis éditez `config.json` ou utilisez directement le bouton ⚙️ **Paramètres** dans le rapport HTML pour modifier mots-clés, villes et rayons sans toucher au fichier.

---

## 🚀 Utilisation

### Lancement interactif (recommandé)

```bat
Lancer (mode interactif).bat
```

Ouvre le rapport HTML + démarre un serveur local sur `http://localhost:8765` pour sauvegarder statuts et paramètres automatiquement.

### Analyse rapide (sans serveur)

```bat
Analyse rapide.bat
```

Génère `rapport_offres.html` et l'ouvre dans le navigateur. Les statuts sont sauvegardés uniquement en localStorage.

### Surveillance automatique (toutes les heures)

```powershell
.\planifier.ps1
```

Configure le Planificateur de tâches Windows pour relancer le script toutes les heures.

---

## 📁 Structure

```
Jobbly/
├── job_alert.py                  # Script principal (2 113 lignes, 44 fonctions)
├── config.exemple.json           # Modèle de configuration — versionné ✅
│
│   — fichiers ignorés par git (.gitignore) —
├── .env                          # Identifiants API — secrets 🔒
├── config.json                   # Mots-clés et villes personnels 🔒
├── rapport_offres.html           # Rapport généré (mis à jour à chaque exécution)
├── seen_jobs.json                # IDs des offres déjà vues
├── status_jobs.json              # Statuts de candidature par offre
└── jobs_cache.json               # Cache des offres pour la persistance
│
├── installer.ps1                 # Installation des dépendances
├── planifier.ps1                 # Configuration tâche planifiée Windows
├── Lancer (mode interactif).bat  # Lancement serveur + rapport
└── Analyse rapide.bat            # Lancement rapport seul
```

---

## 🔒 Sécurité

- `.env` (identifiants API) et `config.json` (mots-clés, villes) sont dans `.gitignore` — jamais versionnés
- Protection CSRF par vérification de l'entête `Origin`
- Protection SSRF : résolution DNS + vérification IP avant toute requête externe
- Échappement HTML systématique (`html.escape`) sur toutes les données tierces
- En-têtes de sécurité : `X-Frame-Options`, `X-Content-Type-Options`, `Content-Security-Policy`, `Referrer-Policy`
- Écriture atomique des fichiers JSON et HTML (`os.replace`)
- Verrous threading sur les écritures concurrentes (`status_lock`, `config_lock`)

---

## 📄 Licence

Ce projet est distribué sous licence **[PolyForm Noncommercial 1.0.0](LICENSE)**.

| Usage | Autorisé |
|-------|----------|
| Usage personnel | ✅ |
| Étude, recherche, enseignement | ✅ |
| Projets associatifs / non lucratifs | ✅ |
| Modification et redistribution non commerciale | ✅ |
| **Usage commercial** | ❌ Nécessite une autorisation écrite |

Pour toute demande d'usage commercial, contactez le propriétaire via [GitHub](https://github.com/LordEris).

© 2025 Evan Sajotoudin (LordEris)
