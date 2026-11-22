# Jobbly — les offres d'emploi de cinq sites en une liste

Jobbly rassemble les offres d'emploi de France Travail, La Bonne Alternance,
Jooble, Careerjet et Adzuna en une seule liste, sans doublons ni liens morts,
et suit les candidatures.

| Famille | Plateforme | Publié sur | État |
|---|---|---|---|
| Lorderis | Site (statique) et fonction Edge Supabase | [jobbly.lorderis.dev](https://jobbly.lorderis.dev) (IONOS, `website-jobbly/`) | Site prêt, en attente de mise en ligne ; remplace le script Windows `job_alert.py` |

## En bref

Pour qui cherche un emploi en France : on choisit ses mots-clés et ses villes
(avec un rayon), on appuie sur « Actualiser », et Jobbly interroge les cinq
sources, fusionne la même offre publiée sur plusieurs sites, écarte les
annonces expirées et les liens qui ne mènent plus à rien, puis range le
résultat avec le compte. Chaque offre porte un statut de candidature
(postulé, en attente, entretien, accepté, refusé, ignoré), les nouvelles
depuis la dernière visite sont marquées, et une fausse offre se masque pour
de bon.

**Tout compte Lorderis** peut s'en servir — le même compte que nos autres
apps, par e-mail ou avec Google. Chacun a ses réglages, ses offres et ses
statuts. Les recherches passent par les clés d'API du propriétaire, avec un
quota : 30 recherches par compte et par jour.

**Le site remplace le script Windows** (`job_alert.py`, ses `.bat`, ses
`.ps1`, `requirements.txt`, `config.exemple.json`) : mêmes sources, mêmes
statuts, sans rien à installer. Le script reste dans le dépôt jusqu'à la
mise en ligne du site, puis sera retiré ; les statuts qu'il gardait dans un
fichier local ne sont pas repris.

## Fonctionnement

Trois parties :

- **le site** — `index.html` (la présentation, à `/`), `offres.html`
  (l'appli : connexion au compte Lorderis, offres, détail, réglages),
  `confidentialite.html` (la politique). Statique, sans construction : le
  fichier du dépôt est le fichier servi. Il lit et écrit le schéma `jobbly`
  du projet Supabase commun avec la session de la personne, sous la RLS ;
- **la fonction Edge `jobbly-search`** (`supabase/functions/jobbly-search/`),
  que le bouton « Actualiser » appelle : quota, appel des cinq sources en
  parallèle, doublons, vérification des liens (avec un cache commun qui ne
  garde qu'une empreinte d'URL), fusion avec les offres de la personne. Son
  mode d'emploi, ses codes de réponse et ses secrets :
  [supabase/functions/README.md](supabase/functions/README.md) ;
- **le SQL**, dans Account-LordEris (`supabase/shared-project/jobbly.sql`) :
  `settings`, `offers`, le quota et le cache des liens, `delete_my_data()`.

Le détail du site — vues, écritures, messages, identité visuelle — est dans
[docs/site.md](docs/site.md).

## Démarrer

Rien à installer pour le site. Pour le voir en local avec ses vrais en-têtes
(CSP comprise) et un projet Supabase imité, sans compte réel :

```bash
curl -sSo /tmp/supabase.js https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2/dist/umd/supabase.js
NODE_PATH=$(npm root -g) SUPABASE_UMD=/tmp/supabase.js node tools/check-site.mjs /tmp/captures
```

(Playwright installé hors du dépôt, Chromium présent.) Les captures de
chaque page et de chaque parcours arrivent dans `/tmp/captures`. Un simple
serveur statique (`python3 -m http.server`) affiche aussi les pages, mais
sans la CSP de `.htaccess`, et l'appli y parle au vrai projet commun.

La fonction se lance en local avec la CLI Supabase : voir son README.

## Vérifier

```bash
for f in assets/js/*.js tools/*.mjs; do node --check "$f" || exit 1; done
node --test tools/rules.test.mjs
node --test supabase/functions/jobbly-search/*.test.ts
NODE_PATH=$(npm root -g) SUPABASE_UMD=/tmp/supabase.js node tools/check-site.mjs /tmp/captures
```

Le dernier doit finir par « Tout est vert » : aucune violation de CSP,
aucune erreur JS, aucun défilement horizontal, à 390 et 1280 px, en clair et
en sombre, en français et en anglais, et chaque parcours dit ce qu'il doit
dire (connexion, Google, filtres, statut, fausse offre, « Actualiser » et
chacun de ses codes, réglages et recherche de commune, suppression des
données). `--apercu` refait les captures de la présentation.

## Publier

À chaque push sur `main`, `.github/workflows/deploy.yml` assemble le site
(liste fermée : les trois pages, `.htaccess`, `assets/`) et l'envoie par SFTP
dans `website-jobbly/` chez IONOS, puis relit les fichiers envoyés et le site
publié. Il se lance aussi à la main (Actions → « Deploy to IONOS »), avec
« Test seulement » pour vérifier l'accès sans rien envoyer.

À faire une fois, hors du dépôt :

- **IONOS** : le sous-domaine `jobbly.lorderis.dev`, pointé sur
  `website-jobbly/`, avec son certificat. Tant qu'il ne l'est pas, la
  relecture du site publié l'écrit en avertissement sans faire échouer
  l'envoi ;
- **Supabase** (projet commun) : `jobbly` dans les *Exposed schemas* ;
  `https://jobbly.lorderis.dev/**` dans les *Redirect URLs* ; le SQL de
  `jobbly` collé depuis Account-LordEris ; la fonction déployée
  (`supabase functions deploy jobbly-search`) avec ses secrets ;
- **Google** (projet « Lorderis », client Web) :
  `https://jobbly.lorderis.dev` dans les *Origines JavaScript autorisées*,
  sans quoi le bouton « Continuer avec Google » ne s'affiche pas.

## Configuration

| Nom | Où le poser | Public ? | Rôle |
|---|---|---|---|
| `FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD` | Secrets GitHub Actions | Non | Compte SFTP de l'hébergement IONOS |
| `FTP_REMOTE_DIR` | Secrets GitHub Actions | Non | `/website-jobbly` (compte global) ou `/` (compte limité au dossier) ; rien d'autre n'est accepté |
| `FTP_KNOWN_HOSTS` | Secrets GitHub Actions | Non | Clé d'hôte SFTP (`ssh-keyscan`), vérifiée à chaque envoi |
| `JOBBLY_FT_CLIENT_ID`, `JOBBLY_FT_CLIENT_SECRET` | Secrets de la fonction Edge | Non | API Offres d'emploi de France Travail |
| `JOBBLY_LBA_API_KEY` | Secrets de la fonction Edge | Non | API de La Bonne Alternance |
| `JOBBLY_JOOBLE_API_KEY` | Secrets de la fonction Edge | Non | API de Jooble |
| `JOBBLY_CAREERJET_AFFID` | Secrets de la fonction Edge | Non | API de Careerjet |
| `JOBBLY_ADZUNA_APP_ID`, `JOBBLY_ADZUNA_APP_KEY` | Secrets de la fonction Edge | Non | API d'Adzuna |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | `assets/js/supabase.js` | Oui | Le projet commun ; l'hôte figure aussi dans la CSP de `.htaccess` |
| `GOOGLE_CLIENT_ID` | `assets/js/google-auth.js` | Oui | Client Web « Lorderis », commun à toutes les apps |

Une source sans secret est sautée, et l'écran le dit (« pas encore
configurée »).

## Organisation du dépôt

```
Jobbly/
├── index.html               # la présentation, servie à /
├── offres.html              # l'appli : connexion, offres, détail, réglages
├── confidentialite.html     # la politique de confidentialité
├── .htaccess                # en-têtes, deux CSP (pages / appli), refus des fichiers internes
├── assets/
│   ├── css/jobbly.css       # tous les jetons de couleur, les deux thèmes, l'appli
│   ├── css/…                # copies TELLES QUELLES du kit : presentation, legal, toggles, footer
│   ├── js/app.js            # l'appli (module ES), branchée sur rules.js
│   ├── js/rules.js          # les règles pures de l'écran (testées)
│   ├── js/i18n.js           # textes FR (référence) et EN
│   ├── js/supabase.js       # client du projet commun (copie de la référence)
│   ├── js/google-auth.js    # « Continuer avec Google » (copie de la référence)
│   ├── js/theme-init.js     # thème et langue avant le premier rendu
│   ├── js/prefs.js          # les deux boutons ronds
│   ├── js/…                 # copies telles quelles : presentation.js, toc-spy.js
│   ├── img/icone.svg        # l'icône
│   └── apercu/              # captures de la présentation (données inventées)
├── supabase/                # la fonction Edge jobbly-search et sa config
├── tools/
│   ├── check-site.mjs       # le site dans Chromium, sous la vraie CSP, projet imité
│   ├── demo-data.mjs        # les données inventées des vérifications et des captures
│   └── rules.test.mjs       # tests des règles et des catalogues
├── docs/site.md             # le fonctionnement du site
├── .github/                 # déploiement SFTP, vérifications, gabarits, Dependabot
│
│   — l'ancien script Windows, retiré une fois le site en ligne —
├── job_alert.py, *.bat, *.ps1, requirements.txt, config.exemple.json
└── AGENTS.md, CLAUDE.md, SECURITY.md, LICENSE
```

## Sécurité

Voir [SECURITY.md](SECURITY.md). En bref : les clés des sites d'emploi ne
vivent que dans les secrets de la fonction ; la fonction agit avec le jeton
de la personne, sous la RLS ; le contenu des offres est traité comme hostile
(texte seulement, liens http(s) seulement) ; le site n'a ni script ni style
en ligne, et seule la page de l'appli joint d'autres origines.

## Dépôts liés

Le même tableau figure dans chaque dépôt. Un dépôt qui s'ajoute s'ajoute partout.

| Famille | Dépôt | Rôle |
|---|---|---|
| Foody | [Mobile-App-Foody](https://github.com/App-Foody/Mobile-App-Foody) | Application de suivi alimentaire (Expo), schéma Supabase `foody` |
| Foody | [Website-Foody](https://github.com/App-Foody/Website-Foody) | Site public, compte, réinitialisation, suppression de compte |
| Foody | [Website-FoodySupport](https://github.com/App-Foody/Website-FoodySupport) | Console des agents du support |
| Impera | [Mobile-App-Impera](https://github.com/Impera-App/Mobile-App-Impera) | Application de concentration, Android (Expo) |
| Impera | [Windows-App-Impera](https://github.com/Impera-App/Windows-App-Impera) | Application Windows (Electron) et service ImperaGuard |
| Impera | [MacOS-App-Impera](https://github.com/Impera-App/MacOS-App-Impera) | Application macOS (Swift) et filtre réseau |
| Impera | [Website-Impera](https://github.com/Impera-App/Website-Impera) | Site public, compte, paiement ; Edge Functions Stripe |
| Impera | [Website-ImperaSupport](https://github.com/Impera-App/Website-ImperaSupport) | Console des agents du support |
| Impera | [Windows-Impera-Releases](https://github.com/Impera-App/Windows-Impera-Releases) | Canal public de mise à jour de l'app Windows |
| BeeFluid | [Windows-Beefluid](https://github.com/BeeFluid/Windows-Beefluid) | Poste de bureau d'études (Tauri) et son noyau, que le terrain lit ; schéma Supabase `beefluid` |
| BeeFluid | [Windows-Beefluid-releases](https://github.com/BeeFluid/Windows-Beefluid-releases) | Canal public de publication du poste (et des anciens APK `M.`) |
| BeeFluid | [Mobile-Beefluid](https://github.com/BeeFluid/Mobile-Beefluid) | Application de terrain (Expo, EAS Build), schéma Supabase `beefluid` |
| BeeFluid | [BeeOffice](https://github.com/BeeFluid/BeeOffice) | Gestion de l'entreprise : devis, factures, clients, tableau de bord (Expo, site), schéma Supabase `beeoffice` |
| Lorderis | [Account-LordEris](https://github.com/LordEris/Account-LordEris) | Compte Lorderis unique : SQL du projet Supabase commun, account.lorderis.dev, code client de référence |
| Lorderis | [Patrimo](https://github.com/LordEris/capsa) | Gestion de patrimoine (ex-Capsa) : web, schéma Supabase `patrimo` |
| Lorderis | [HealthChecks](https://github.com/LordEris/HealthChecks) | Santé et suivi personnel (ex-Alfred), données chiffrées sur l'appareil : web, Electron, Android |
| Lorderis | [Lineup](https://github.com/LordEris/Lineup) | Playlists de groupe (Next.js), schéma Supabase `lineup` |
| Lorderis | [Fleetly](https://github.com/LordEris/Fleetly) | Gestion de garage et de flotte (Expo), schéma Supabase `fleetly` |
| Lorderis | [Website-Kikiladi](https://github.com/LordEris/Website-Kikiladi) | Jeu « Kikiladi ? » (statique + PHP) |
| Lorderis | [Technique-TP](https://github.com/LordEris/technique-tp) | Pointage des rotations de camions sur les chantiers de TP (Expo) |
| Lorderis | [Schedules](https://github.com/LordEris/Schedules) | Heures de travail, jour par jour, et lecture des feuilles d'heures (Expo), schéma Supabase `schedules` |
| Lorderis | [Jobbly](https://github.com/LordEris/Jobbly) | Offres d'emploi de cinq sites en une liste, sans doublons ni liens morts (site statique), schéma Supabase `jobbly` |
| Lorderis | [Website-LordEris](https://github.com/LordEris/Website-LordEris) | Site vitrine Lorderis et pages des projets |

## Licence

Distribué sous licence **[PolyForm Noncommercial 1.0.0](LICENSE)** : usage
personnel, d'étude, associatif ou non lucratif permis ; tout usage commercial
demande une autorisation écrite du propriétaire.

© 2026 LordEris
