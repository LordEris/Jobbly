# Sécurité — Jobbly

Ce fichier est commun à tous les dépôts (Foody, Impera, Patrimo,
HealthChecks, Lineup, Fleetly, BeeFluid, Kikiladi et le site Lorderis) et tenu
à l'identique ; seule la section « Propre à ce dépôt » change.

## Signaler une faille

Ne pas ouvrir d'issue publique. Passer par **Security → Report a
vulnerability** sur ce dépôt (signalement privé GitHub). Le signalement doit
dire ce qui est atteint, comment le reproduire, et ce qu'un attaquant y gagne.

## Les règles communes

- **Aucun secret dans le dépôt.** Les clés publiques (clé `anon` /
  `publishable` de Supabase, identifiants de projet Appwrite, ID clients OAuth)
  ne sont pas des secrets : elles voyagent dans chaque requête du navigateur.
  Tout le reste — clé `service_role`, mots de passe SFTP, clés de signature,
  jetons de publication — vit dans les secrets GitHub Actions ou dans ceux des
  Edge Functions. Le bloc « Secrets et clés » du `.gitignore` est le même
  partout. Un secret committé une fois se **change** : le retirer du dépôt ne
  le retire pas de l'historique.
- **Les workflows lisent, sauf exception écrite.** `permissions: contents:
  read` par défaut ; une tâche qui pousse un commit ou une étiquette le dit en
  tête de fichier. Les actions sont épinglées par SHA, avec la version en
  commentaire, et Dependabot les tient à jour.
- **Une valeur saisie ou un secret passe par `env:`**, jamais par `${{ }}` dans
  le corps d'un script : l'interpolation y colle le texte tel quel.
- **SFTP : la clé d'hôte est vérifiée** (`FTP_KNOWN_HOSTS`), jamais acceptée
  d'office. Sans elle, le déploiement échoue au lieu d'envoyer les
  identifiants à un serveur non vérifié.
- **Les droits se tiennent côté serveur.** RLS et fonctions `SECURITY
  DEFINER` (avec `search_path` fixé) pour Supabase, règles de document pour
  Appwrite. Ce que l'interface cache n'est pas protégé pour autant. Le SQL du
  projet Supabase commun vit dans Account-LordEris ; une copie ailleurs porte
  une garde qui refuse de s'exécuter sur le projet commun.
- **Un échec ne se tait pas, une donnée absente n'est pas favorable** : ce
  sont les règles de chaque dépôt, et elles valent pour la sécurité aussi.

## Propre à ce dépôt

- **Les clés des sites d'emploi ne quittent jamais la fonction Edge**
  `jobbly-search` : secrets `JOBBLY_FT_CLIENT_ID`, `JOBBLY_FT_CLIENT_SECRET`,
  `JOBBLY_LBA_API_KEY`, `JOBBLY_JOOBLE_API_KEY`, `JOBBLY_CAREERJET_AFFID`,
  `JOBBLY_ADZUNA_APP_ID`, `JOBBLY_ADZUNA_APP_KEY`, posés dans Supabase,
  jamais dans le dépôt ni dans la page. L'ancien script les lisait dans un
  `.env` local, ignoré par git.
- **La fonction n'agit qu'avec le jeton de la personne** (`verify_jwt`, puis
  la RLS du schéma `jobbly`) ; la clé `service_role` n'y sert qu'au quota et
  au cache des liens, deux tables sans aucun droit client. Elle ne suit
  jamais une redirection vers une adresse privée (anti-SSRF), et ne
  journalise que des codes, jamais un mot-clé, une ville ni une offre.
- **Le contenu des offres est hostile** : il vient d'API tierces. Le site le
  pose par `textContent`, jamais `innerHTML`, et n'ouvre que les liens en
  http(s), avec `rel="noopener noreferrer"`.
- **Site statique** publié par SFTP ; en-têtes dans `.htaccess` : CSP sans
  `'unsafe-inline'` en script ni en feuille (sauf les attributs de style du
  bouton de Google, sur `offres.html` seulement), `form-action 'none'`,
  `frame-ancestors 'none'`. La présentation et la politique ne joignent
  aucune origine ; l'appli joint le projet commun, `geo.api.gouv.fr`, le SDK
  sur jsdelivr (SRI) et Google (bouton de connexion). Le déploiement
  n'envoie qu'une liste fermée de fichiers ; `.htaccess` refuse en plus
  `supabase/`, `docs/`, `tools/`, les fichiers cachés, le Markdown et
  l'ancien script Windows (`*.py`, `*.ps1`, `*.bat`, `requirements.txt`,
  `config.exemple.json`).
- **Le SQL de `jobbly` vit dans Account-LordEris** : RLS sur `settings` et
  `offers` (chacun ses lignes), quota et cache sans droit client, plafond par
  compte, `delete_my_data()`.
