# Notes pour les agents

Les deux premières sections sont **communes à tous les dépôts** et identiques
partout : les modifier, c'est les modifier dans chaque dépôt. Leur source est le
dossier `common/` de [Workflows](https://github.com/LordEris/workflows), avec les
autres fichiers communs ; `scripts/sync-common.py` y vérifie un dépôt et le remet
à jour ([docs/modele-commun.md](https://github.com/LordEris/workflows/blob/main/docs/modele-commun.md)).
Ce qui est propre à ce dépôt commence à « Ce dépôt ».

## Organisation commune

**Chaque dépôt a la même forme.** On doit pouvoir passer de l'un à l'autre sans
chercher où sont les choses.

| Fichier | Rôle | Identique partout ? |
|---|---|---|
| `README.md` | Présentation, toujours au même plan (ci-dessous) | Le plan, oui ; le contenu, non |
| `SECURITY.md` | Signalement d'une faille, règles communes, points propres | Oui, sauf « Propre à ce dépôt » |
| `AGENTS.md` | Ce fichier : règles pour qui modifie le code | Oui, jusqu'à « Ce dépôt » |
| `CLAUDE.md` | Une seule ligne, `@AGENTS.md` | Oui |
| `.editorconfig`, `.gitattributes` | Mise en forme et fins de ligne | Oui |
| `.gitignore` | Propre au dépôt, puis le bloc « Secrets et clés » commun en fin de fichier | Le bloc, oui |
| `.github/dependabot.yml` | Actions mensuelles, npm en correctifs de sécurité seuls | Oui, aux écosystèmes près |
| `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/` | Gabarits de PR et d'issues | Oui |
| `.github/workflows/` | CI et publication, au même gabarit (voir Sécurité) | La structure, oui |
| `docs/` | Toute documentation longue : conception, migrations, audits, procédures | — |

À la racine il n'y a **que** ces fichiers, le code et la configuration des
outils. Un document de conception, une migration, un audit vont dans `docs/` —
une racine qui en accumule n'est plus lue.

**Le README suit toujours ce plan, dans cet ordre**, et aucune section n'est
omise : une section sans objet le dit (« Sans objet : … »), parce qu'une section
absente se lit comme un oubli.

1. `# Nom — rôle`, une phrase, puis le tableau Famille · Plateforme · Publié sur · État ;
2. `## En bref` — ce que fait le produit, pour qui ;
3. `## Fonctionnement` — ce qui est propre au produit ; le long va dans `docs/` ;
4. `## Démarrer` — prérequis, installation, lancement en local ;
5. `## Vérifier` — les commandes à lancer avant de livrer ;
6. `## Publier` — déploiement ou publication ;
7. `## Configuration` — tableau Nom · Où le poser · Public ? · Rôle ;
8. `## Organisation du dépôt` — l'arbre, commenté ;
9. `## Sécurité` — renvoi à `SECURITY.md` et points propres ;
10. `## Dépôts liés` — le tableau commun, identique partout ;
11. `## Licence`.

**Langue** : les **identifiants sont en anglais** — fonctions, variables,
fichiers, composants, classes CSS, clés i18n, objets SQL, adresses techniques —
et le **texte visible est en français**, posé par-dessus (i18n). Les noms de
pages des sites restent en français (`confidentialite.html`). Commentaires,
documentation et messages de commit sont en français ; un commentaire dit
**pourquoi**, pas ce que fait la ligne. Le code existant écrit en français se
convertit au fil des modifications, jamais d'un bloc : un renommage massif
casse plus qu'il ne range.

**Nommage : tout ce qui appartient à un projet porte son nom**, toujours de la
même façon.

| Quoi | Règle | Exemple |
|---|---|---|
| Adresse | `<projet>.lorderis.dev` | `foody.lorderis.dev`, `account.lorderis.dev` |
| Schéma Supabase | `<projet>` | `impera`, `healthchecks` |
| Edge Function | `<projet>-<action>` | `impera-stripe-webhook` |
| Secret | `<PROJET>_…` | `IMPERA_STRIPE_SECRET_KEY` |
| Dossier distant | `website-<projet>/` | `website-foody/` |

**Un seul compte : le compte Lorderis.** Toute app qui a des comptes utilise
celui du projet Supabase commun, dont le dépôt de référence est
[Account-LordEris](https://github.com/LordEris/Account-LordEris) : même
e-mail, même mot de passe, même compte Google partout, gérés sur
`account.lorderis.dev`. Une app ne crée jamais son propre système de comptes.
Les textes de connexion, d'inscription et de suppression sont communs, au mot
près ; le pied de page LordEris (celui de lorderis.dev) va en bas des pages de
site (présentations, pages légales, sites), jamais dans une appli, même ouverte
dans un navigateur.

**Livrer** : une branche, une pull request, jamais de poussée directe sur la
branche par défaut. Avant d'ajouter à l'index, relire `git status` : un
`git add -A` ramasse aussi ce qui traîne.

## Sécurité commune

- **Aucun secret dans le dépôt.** Les clés publiques (clé `anon` /
  `publishable` de Supabase, identifiants Appwrite, ID clients OAuth) n'en sont
  pas ; tout le reste vit dans les secrets d'Actions ou des Edge Functions. Un
  secret committé une fois se **change** : le retirer ne le retire pas de
  l'historique.
- **Workflows** : `permissions: contents: read` par défaut, une tâche qui écrit
  le dit en tête de fichier ; actions épinglées par **SHA** avec la version en
  commentaire ; toute valeur saisie ou tout secret passe par `env:`, jamais par
  `${{ }}` dans le corps d'un script ; `persist-credentials: false` quand rien
  ne pousse.
- **Déploiement SFTP** : un seul gabarit, avec contrôle préalable des secrets,
  clé d'hôte vérifiée (`FTP_KNOWN_HOSTS`, jamais `sftp:auto-confirm yes`),
  envoi sérialisé (`concurrency`) et vérification du fichier publié. Les
  exclusions du miroir sont doublées par un refus côté serveur (`.htaccess`) :
  un fichier interne envoyé par erreur ne doit pas être servi.
- **Sites** : même socle d'en-têtes partout — HSTS, CSP sans script en ligne,
  `frame-ancestors 'none'`, `nosniff`, Referrer-Policy, Permissions-Policy,
  redirection HTTPS, fichiers cachés et internes refusés. Un écart se justifie
  en commentaire.
- **Données de santé** : elles restent sur l'appareil, chiffrées dans
  un coffre (Keystore, Keychain, `safeStorage`). Les autres apps peuvent en
  envoyer vers HealthChecks ; HealthChecks n'envoie rien ailleurs de
  lui-même — seul un rapport de plantage anonyme (type d'erreur et pile
  d'appels, sans aucune donnée) part chez Sentry, région UE. Son assistant
  (Claude, d'Anthropic, États-Unis) est proposé mais n'envoie rien sans
  l'accord explicite de la personne, puis seulement ce qu'elle a vu avant
  chaque question, par une Edge Function qui tient la clé et ne garde rien.
- **Projet Supabase commun** : une base pour toutes les apps, **un schéma par
  app**. RLS sur chaque table ; toute fonction `SECURITY DEFINER` fixe son
  `search_path`, vérifie `auth.uid()` et retire `execute` à `public`/`anon`
  quand elle n'est pas publique. La clé `service_role` ne quitte jamais une
  Edge Function. Le SQL du projet commun vit dans Account-LordEris ; une
  copie ailleurs porte une garde qui refuse de s'exécuter sur le projet commun.
- **Applications** : sessions dans le stockage sécurisé du système (Keychain,
  Keystore, SecureStore), jamais en clair ; une entrée venant d'un fichier, d'un
  lien ou d'un autre processus est hostile ; un processus élevé ne lit rien
  qu'un processus non élevé puisse écrire sans le valider.
- **Dépendances** : Dependabot pour les alertes, `npm audit --omit=dev` avant
  une publication ; une montée majeure se fait dans sa propre PR, testée.
- **Un échec ne se tait pas, une donnée absente n'est pas favorable** : un
  contrôle qui ne peut pas juger le dit, il ne conclut pas « conforme ».

## Ce dépôt

**Jobbly** rassemble les offres d'emploi de cinq sources (France Travail, La
Bonne Alternance, Jooble, Careerjet, Adzuna) en une seule liste, sans
doublons ni liens morts, et suit les candidatures. C'est **un site
seulement** (décision du propriétaire, 22 novembre 2026),
`https://jobbly.lorderis.dev`, publié chez IONOS dans `website-jobbly/` ; il
n'y a pas d'appli téléphone. **Tout compte Lorderis** peut s'en servir :
chacun a ses mots-clés, ses villes, ses offres et ses statuts, dans le schéma
`jobbly` du projet Supabase commun. Les recherches passent par les clés
d'API du propriétaire, avec un quota par compte. Il remplace le script
Windows `job_alert.py`, qui reste dans le dépôt jusqu'à la mise en ligne du
site, puis sera retiré (avec ses `.bat`, ses `.ps1` et `requirements.txt`).

Trois parties, qui ne se mélangent pas :

- **le site** (racine, `assets/`) : statique, sans construction — **le
  fichier du dépôt est le fichier servi**, comme account.lorderis.dev ;
- **la fonction Edge `jobbly-search`** (`supabase/functions/`) : elle
  interroge les sources, fusionne les doublons, vérifie les liens et range
  les offres avec le jeton de la personne. Son mode d'emploi est
  `supabase/functions/README.md` ;
- **le SQL** ne vit pas ici : `supabase/shared-project/jobbly.sql` dans
  Account-LordEris. Une table, une colonne ou un droit qui change s'écrit
  là-bas, et se rejoue à son banc d'essai.

### Le site

- `index.html` : la présentation, servie à `/` (gabarit commun,
  `presentation.css` et `presentation.js` recopiés tels quels) ;
  `offres.html` : l'appli — connexion, offres, détail (`#offre-<id>`),
  réglages (`#reglages`) ; `confidentialite.html` : la politique (gabarit
  commun, `legal.css` et `toc-spy.js` tels quels).
- `assets/js/` : `theme-init.js` (thème et langue avant le premier rendu,
  synchrone), `prefs.js` (les deux boutons ronds), `app.js` (l'appli,
  module ES), `rules.js` (**les règles pures**, testées par
  `tools/rules.test.mjs`), `i18n.js` (FR, référence, et EN), `supabase.js`
  (copie de `reference/web/supabase.js`, trois écarts dits en tête),
  `google-auth.js` (copie de `reference/web/google-auth.js`, identique hors
  de l'en-tête). `assets/css/jobbly.css` porte TOUTES les couleurs, en
  jetons, pour les deux thèmes.
- **Une règle écrite dans `app.js` ne se teste pas** : elle va dans
  `rules.js`. `app.js` ne fait que brancher les règles sur la page.
- **Aucun script ni style en ligne, aucun `on…=`, rien par `innerHTML`.** La
  CSP le refuse ; tout texte venu du réseau passe par `textContent`, et une
  adresse n'est ouverte que si elle est en http(s) (`rules.safeUrl`) — les
  offres viennent de sites tiers.
- **Une seule page parle au monde** : `offres.html`. Son bloc
  `<FilesMatch>` de `.htaccess` lui donne le projet commun, `cdn.jsdelivr.net`
  (le SDK, SRI), `geo.api.gouv.fr` (la recherche de commune) et les quatre
  emplois de `https://accounts.google.com/gsi/` (l'invite One Tap), avec la
  COOP `same-origin-allow-popups` (sous Safari et Firefox, l'invite termine
  dans une fenêtre de Google). La présentation et la politique ont une
  CSP qui ne joint personne ; `connexion-google.html`, la plus fermée.
- **« Continuer avec Google » est notre bouton, et la page part chez
  Google** dans le même onglet, sans fenêtre (décision du propriétaire,
  25 novembre 2026). Google revient sur `connexion-google.html`, qui efface
  le fragment, range le résultat et revient à `offres.html`, où `finish()`
  donne le jeton à Supabase. `assets/js/google-auth.js` est la copie de
  `reference/web/google-auth.js` d'Account-LordEris (identique hors
  en-tête), `assets/js/connexion-google.js` celle de
  `reference/web/connexion-google.js`, à l'octet ; `tools/check-site.mjs`
  les compare. Le script de Google ne sert plus qu'à l'invite, chargé à
  l'adresse publiée seulement. **Exception à « aucun jeton n'est lu dans un
  lien »** : le jeton d'identité que Google met dans le fragment de
  `connexion-google.html`, accepté seulement s'il répond à une demande en
  cours de cet onglet (l'état), de moins de dix minutes, une seule fois, et
  lié par le nonce. `https://jobbly.lorderis.dev/connexion-google.html`
  doit figurer dans les « URI de redirection autorisés » du client Web
  « Lorderis ». Une origine ajoutée au code sans être nommée là
  donne une requête bloquée, sans autre message que la console.
- **L'identité est celle du rapport du script** (`_CSS` de `job_alert.py` :
  fond grège, bandeau bleu en dégradé, pastilles de source pastel), mise en
  jetons et au contraste AA dans les deux thèmes ; `tools/check-site.mjs`
  recalcule chaque paire. Toute zone tactile fait 44 px ; l'état pressé se
  dit par le fond ; une information n'est jamais portée par la seule couleur
  (un badge a son mot, un filtre sa coche, un message son icône).
- **Un échec se dit, jamais une liste vide muette** : une lecture ratée
  affiche une erreur et « Réessayer » ; une écriture ratée remet l'écran
  comme avant et le dit. « Actualiser » est désactivé pendant l'appel, puis
  dit le résultat : compteurs, sources en erreur, sautées ou non
  configurées, ou la phrase du code rendu. Chaque code de `jobbly-search`
  (`supabase/functions/README.md`) a sa phrase dans `i18n.js` ; le test le
  vérifie. Une réponse illisible a la sienne (`bad_response`).
- **Les écritures du site** : un statut met à jour `status` et `status_at`,
  rien d'autre ; « Fausse offre » met `blocked` ; les réglages s'écrivent par
  un upsert de `user_id`, `keywords`, `locations`, `contract_types` et
  `min_salary`. Jamais `first_seen`, jamais `data` : c'est la fonction qui
  les écrit.
- **La rémunération est en euros par mois, et une absence n'est pas
  défavorable.** La fonction lit le salaire de chaque source (phrase de
  France Travail, texte de Jooble et Careerjet, nombres d'Adzuna et Careerjet,
  jamais l'estimation d'Adzuna) et le ramène au mois (`salaryFromText`,
  `salaryFromNumbers`, `rules.ts`) dans `data.salary` `{label, min, max}`. Le
  salaire minimum des réglages (`min_salary`) ne cache, à l'écran, que les
  offres dont le haut de la fourchette est plus bas ; une offre qui n'annonce
  rien reste, « non indiquée », et les offres cachées sont comptées et à un
  clic. Il ne part chez aucune source.
- **Une ville sans sa commune est incomplète** : France Travail ne cherche
  qu'avec le code INSEE, La Bonne Alternance qu'avec la position. Les
  réglages les posent depuis l'API Géo ; une ville ajoutée sans commune (API
  en panne) est signalée.
- **Les textes du compte sont ceux du kit, au mot près**, et tutoient.
- **La présentation et la politique disent ce que fait le code** : une
  donnée, un destinataire, une durée ou une source qui change se reporte
  dans `index.html` et `confidentialite.html`, dans les deux langues, dans
  la même pull request. Leurs captures (`assets/apercu/`) se refont par
  `tools/check-site.mjs --apercu`, sur les données inventées de
  `tools/demo-data.mjs` — jamais celles d'une vraie personne.
- **Les copies du kit ne se retouchent jamais** : `presentation.css`,
  `presentation.js`, `legal.css`, `toc-spy.js`, `lorderis-toggles.css`,
  `lorderis-footer.css` (avec `assets/img/lorderis-logo.png`) et le corps de
  `google-auth.js`. Les boutons ronds prennent l'habit de Jobbly par les
  variables surchargées dans `jobbly.css`, chargé APRÈS eux.
  `tools/check-site.mjs` les compare à Account-LordEris quand il est cloné à
  côté.
- **Le pied de page est celui de lorderis.dev, le même dans tous les
  projets, et seulement sur les pages de site** (décision du propriétaire,
  22 novembre 2026 ; gabarit d'Account-LordEris, `reference/footer/`) : la
  présentation (`index.html`) et la politique (`confidentialite.html`) le
  portent — logo LordEris, ©, GitHub · Discord · Fiverr · BuiltByBit ·
  Confidentialité (la politique de Jobbly) · Mon compte, textes du kit au mot
  près en blocs FR / EN. **La page de l'appli (`offres.html`) ne le porte
  pas** : une appli reste une appli, même dans un site (décision du
  25 novembre 2026). Elle garde la politique sous la connexion et dans les
  réglages, et « Gérer mon compte Lorderis » dans les réglages. C'est
  l'exception à la règle des couleurs : il reste sombre dans les deux thèmes
  et `jobbly.css` n'y touche pas. Rien ne le double juste au-dessus : pas de
  bloc « Pages légales » qui répéterait « Confidentialité » (demande du
  propriétaire, 22 novembre 2026). `tools/check-site.mjs` le relit sur les
  deux pages de site, refuse un tel bloc, et refuse le pied dans l'appli.

### Publier

`.github/workflows/deploy.yml`, au gabarit SFTP commun (celui de Schedules) :
à chaque push sur `main` et à la main. Il **assemble le site par une liste
fermée** (`index.html`, `offres.html`, `connexion-google.html`, `confidentialite.html`, `.htaccess`,
`assets/`) : un fichier ajouté au site s'ajoute à cette liste, sinon il ne
part pas. Rien de `supabase/`, `docs/`, `tools/`, ni l'ancien script ; le
`.htaccess` les refuse aussi. `FTP_REMOTE_DIR` vaut `/website-jobbly` (compte
global) ou `/` (compte limité au dossier), rien d'autre. La relecture du site
publié avertit sans échouer tant que le sous-domaine ne répond pas.

La fonction se déploie à la main, en la nommant :
`supabase functions deploy jobbly-search` (voir son README).

## Vérifications avant de livrer

```bash
for f in assets/js/*.js tools/*.mjs; do node --check "$f" || exit 1; done
node --test tools/rules.test.mjs                 # règles pures et catalogues
node --test supabase/functions/jobbly-search/*.test.ts   # la fonction (Node 22.18+)
curl -sSo /tmp/supabase.js https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2/dist/umd/supabase.js
NODE_PATH=$(npm root -g) SUPABASE_UMD=/tmp/supabase.js node tools/check-site.mjs /tmp/captures
```

`tools/check-site.mjs` doit finir par « Tout est vert » : il sert le site
avec les en-têtes de `.htaccess`, imite le projet commun, l'API Géo et
Google, et joue chaque page et chaque parcours à 390 et 1280 px, en clair et
en sombre, en français et en anglais (mode d'emploi en tête du fichier). Un
écran qui change visiblement : `--apercu` refait les captures de la
présentation. Après déploiement, ouvrir le site publié et lire la console :
aucune ressource bloquée.
