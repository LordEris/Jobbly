# Edge Functions de Jobbly

Une seule fonction, **`jobbly-search`**, sur le projet Supabase commun aux
apps Lorderis (`imbfggbrkpzbqcouxseo`). Elle fait ce que faisait
`job_alert.py` sur le poste du propriétaire : interroger les cinq sources
d'offres d'emploi avec les mots-clés et les villes d'une personne, retirer les
doublons et les annonces dont le lien ne mène à rien, et ranger le résultat
dans ses offres. Le site (`https://jobbly.lorderis.dev`, la seule origine
admise en CORS) l'appelle par le bouton « Actualiser ».

## Ce qu'elle fait, dans l'ordre

1. **Un compte connecté** : la passerelle vérifie le JWT
   (`verify_jwt = true`, `supabase/config.toml`), puis la fonction relit
   l'utilisateur auprès de l'API d'authentification. L'identifiant vient de
   là, jamais du corps, qui doit être `{}` (ou vide).
2. **Ses réglages**, lus avec SON jeton (RLS, schéma `jobbly`) : mots-clés,
   villes avec rayon (et code INSEE, latitude, longitude), types de contrat
   France Travail. Pas de réglages utilisables → `no_settings`.
3. **Le quota** : `jobbly.consume_search_quota(p_user, p_user_limit,
   p_global_limit)`, appelée avec la clé `service_role` — 30 recherches par
   compte et par jour, 2 000 pour tous. `user_limit` ou `global_limit` →
   `quota`. Une recherche lancée compte, qu'elle trouve ou non.
4. **Les sources**, en parallèle (`sources.ts`), aux adresses et paramètres
   du script : France Travail (jeton OAuth gardé en mémoire du worker, une
   recherche par mot-clé et par ville, descriptions détaillées seulement s'il
   reste du temps), La Bonne Alternance (une recherche par ville, codes ROME
   du script), Jooble, Careerjet, Adzuna. Un délai par appel (15 s, 20 s pour
   La Bonne Alternance), un budget commun d'environ 60 s, quelques appels
   simultanés par source. Une source qui échoue n'arrête pas les autres.
   Une offre dont l'échéance est passée n'est ni gardée ni comptée.
5. **Les doublons** (`rules.ts`, `dedupe`) : trois règles, appliquées dans
   l'ordre — même adresse canonique ; titres normalisés égaux ou semblables
   (≥ 0,85, deux mots au moins) avec entreprises et lieux compatibles ;
   descriptions semblables (≥ 12 mots, ≥ 0,55) avec un mot du titre en
   commun, entreprises et lieux compatibles. Le regroupement est transitif
   (union-find), mais deux groupes ne s'unissent que si **toutes** leurs
   offres restent deux à deux compatibles : une offre sans entreprise ne
   relie pas deux entreprises, et deux identifiants France Travail ne sont
   jamais dans le même groupe. La représentante suit la priorité France
   Travail > La Bonne Alternance > Jooble > Careerjet > Adzuna ;
   l'identifiant est `sha256(url d'origine | titre)` tronqué à 32 caractères,
   comme `make_id` du script, pour que les statuts suivent l'offre.
6. **Les liens** (`links.ts`) : chaque offre garde tous ses liens
   (`data.links`) ; on visite le premier, puis le suivant seulement s'il est
   mort. Un lien est **mort** sur 404, 410, domaine introuvable, renvoi vers
   la page d'accueil, renvoi vers une page de recherche qui a perdu
   l'identifiant de l'offre, ou phrase d'offre expirée (FR, EN) dans les
   128 premiers Ko de la page. Tout le reste — délai, 401, 403, 429, 5xx,
   connexion refusée, adresse refusée — est **inconnu**, et l'offre est
   gardée. Les redirections se suivent à la main (six au plus), chaque saut
   revérifié : jamais vers une adresse privée (IP littérale, `localhost`,
   noms internes, et résolution DNS par `Deno.resolveDns` quand le runtime
   la permet). Le cache commun `jobbly.link_checks` range l'empreinte
   SHA-256 de l'adresse canonique, jamais l'adresse : `ok` 24 h, `dead`
   30 jours, `unknown` jamais rangé. 150 liens visités au plus par
   recherche, 10 à la fois, en 45 s ; au-delà, inconnu.
7. **La fusion** avec ses offres, écrite avec SON jeton : une offre rendue est
   créée ou mise à jour (`data`, `last_seen`, `gone_at` = null) ; une offre
   connue qui n'est plus rendue reçoit `gone_at` — sauf si une source qui la
   rendait n'a pas entièrement répondu à cette recherche (une source muette
   n'est pas une source vide) ; une offre dont tous les
   liens sont morts est supprimée si elle n'a ni statut ni signalement,
   sinon gardée avec `data.link_dead = true` et `data.url = ""`. La requête
   n'envoie jamais `status`, `status_at`, `blocked`, ni `first_seen` d'une
   offre connue (la base fige d'ailleurs ce dernier).

## Réponse

```json
{ "ok": true,
  "counts": { "raw": 412, "duplicates": 236, "dead_links": 9, "kept": 167, "new": 21 },
  "sources": { "France Travail": 120, "La Bonne Alternance": 14, "Jooble": "http_429",
               "Careerjet": 98, "Adzuna": "not_configured" } }
```

- `raw` : offres rendues par les sources (échues retirées) ; `duplicates` :
  `raw` moins les offres après regroupement ; `dead_links` : offres dont tous
  les liens sont morts ; `kept` : offres de cette recherche restées dans la
  liste (vivantes, et mortes gardées pour leur statut) ; `new` : offres
  créées.
- `sources` : par source (noms affichés du script), le nombre d'offres si un
  appel au moins a abouti, sinon un code : `not_configured` (secret absent),
  `skipped` (aucune ville utilisable : France Travail demande un code INSEE,
  La Bonne Alternance des coordonnées), `timeout`, `http_<n>`, `error`
  (réseau, réponse illisible).

Les refus portent `{ "ok": false, "code": … }` :

| Code | HTTP | Quand |
|---|---|---|
| `no_settings` | 200 | Pas de réglages, ou rien d'utilisable dedans |
| `quota` | 200 | 30 recherches du jour faites, ou plafond commun atteint |
| `storage_limit` | 200 | La base refuse l'écriture : plafond d'offres du compte (`offer_limit_exceeded`, `storage_limit_exceeded`) |
| `not_authenticated` | 401 | Session absente ou refusée |
| `invalid_request` | 400 | Corps autre que `{}` |
| `method_not_allowed` | 405 | Autre chose que POST (ou OPTIONS) |
| `not_configured` | 503 | Supabase injoignable, réglages ou quota illisibles |
| `save_failed` | 500 | Les offres n'ont pas pu être lues ou écrites |

Les refus « métier » sont en 200 pour que le site lise leur corps, y compris
par `supabase.functions.invoke`, qui ne le rend pas pour une réponse en
erreur. Le quota déjà pris ne se rend pas après un échec d'écriture.

Rien de ce que la personne a saisi, rien d'une offre ni d'une adresse dans un
journal ni dans un message : les journaux ne portent qu'un code.

## Secrets

| Nom | Rôle |
|---|---|
| `JOBBLY_FT_CLIENT_ID`, `JOBBLY_FT_CLIENT_SECRET` | France Travail, API « Offres d'emploi v2 » (francetravail.io) |
| `JOBBLY_LBA_API_KEY` | La Bonne Alternance (api.apprentissage.beta.gouv.fr) |
| `JOBBLY_JOOBLE_API_KEY` | Jooble |
| `JOBBLY_CAREERJET_AFFID` | Careerjet (identifiant d'affilié) |
| `JOBBLY_ADZUNA_APP_ID`, `JOBBLY_ADZUNA_APP_KEY` | Adzuna |

Une source dont un secret manque est sautée et dite (`not_configured`).
`SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont posés
par Supabase lui-même ; la clé `service_role` ne sert qu'au quota et au cache
des liens, et ne quitte jamais la fonction.

```bash
supabase secrets set --project-ref imbfggbrkpzbqcouxseo \
  JOBBLY_FT_CLIENT_ID=… JOBBLY_FT_CLIENT_SECRET=… JOBBLY_LBA_API_KEY=… \
  JOBBLY_JOOBLE_API_KEY=… JOBBLY_CAREERJET_AFFID=… \
  JOBBLY_ADZUNA_APP_ID=… JOBBLY_ADZUNA_APP_KEY=…
supabase functions deploy jobbly-search --project-ref imbfggbrkpzbqcouxseo
```

Aucun workflow ne déploie la fonction : elle se redéploie à la main, en la
nommant, après relecture, et **après** le SQL. Un changement de son contrat
avec le site (champs de la réponse, codes, champs de `data`) se fait dans la
même pull request que le site.

Les quotas des sources sont ceux des comptes du propriétaire, partagés par
tous les comptes Lorderis : Adzuna gratuit n'offre que quelques centaines
d'appels par mois, et une recherche en fait un par mot-clé et par ville.
Une source à bout rend `http_429`, et la recherche continue sans elle.

## Ce qu'elle attend de la base

Le SQL vit dans Account-LordEris (`supabase/shared-project/jobbly.sql`),
jamais ici : `jobbly.settings` et `jobbly.offers` (RLS sur le titulaire, plafond
d'offres par compte, `first_seen` figé par déclencheur),
`jobbly.search_usage` et `jobbly.consume_search_quota` (`service_role`
seulement), `jobbly.link_checks` (`service_role` seulement, purgé à
30 jours). Le schéma `jobbly` doit figurer dans les *Exposed schemas* du
projet.

## Vérifier

```bash
node --test 'supabase/functions/jobbly-search/*.test.ts'   # Node 22.18 ou plus
deno check supabase/functions/jobbly-search/index.ts          # quand Deno est là
```

Les règles pures sont dans `rules.ts`, sans API Deno ; `sources.ts` et
`links.ts` reçoivent `fetch` (et la résolution DNS) en paramètre, si bien que
les tests jouent chaque source et chaque lien contre une imitation, sans
réseau. `fixtures.ts` est un jeu de 32 offres écrit à la main aux formes des
cinq sources, avec le poste réel de chacune, et rejoue les trois passes du
script pour comparer : 18 doublons retirés au lieu de 10, et aucun poste
confondu là où le script en confondait trois paires. Les tests relisent
aussi les fichiers déployés : aucun échappement Unicode en barre oblique-u
(le canal de déploiement les décode), aucun lookbehind, aucune classe
`\p{…}`, et des journaux qui ne portent que des codes.

Rien n'a été joué contre les vraies API depuis ce dépôt : les formes des
réponses viennent du script et des documentations, et La Bonne Alternance
est lue sous ses deux formes (celle du script, et `offer.*`).
