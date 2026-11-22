# Le site de Jobbly

Ce que fait le site `jobbly.lorderis.dev`, page par page, et pourquoi. Le
contrat commun — schéma `jobbly`, fonction `jobbly-search`, doublons, liens
morts — est dit par le SQL (Account-LordEris, `jobbly.sql`) et par
[supabase/functions/README.md](../supabase/functions/README.md) ; ce
document ne dit que la part du site.

## Trois pages, deux CSP

| Adresse | Fichier | Ce qu'elle joint |
|---|---|---|
| `/` | `index.html` — la présentation, au gabarit commun | personne |
| `/offres.html` | l'appli : connexion, offres, détail, réglages | le projet commun, le SDK (jsdelivr, SRI), `geo.api.gouv.fr`, Google (bouton de connexion) |
| `/confidentialite.html` | la politique, au gabarit commun | personne |

`.htaccess` pose une CSP qui ne joint aucune origine pour toutes les pages,
et l'élargit pour `offres.html` seule (bloc `<FilesMatch>`), avec la COOP
`same-origin-allow-popups` que demande la fenêtre de Google.

**Le passage de la présentation à l'appli** est celui du gabarit
(`presentation.js`, recopié tel quel) : un retour d'autorisation arrivé à `/`
va à l'appli, requête et fragment intacts ; qui a déjà ouvert l'appli
(`jobbly:app-opened`) y est mené directement ; `/?presentation` montre la
présentation quand même — c'est le lien « Qu'est-ce que Jobbly ? » de
l'appli. `.htaccess` renvoie aussi un `?code=` arrivé à `/` vers
`/offres.html`.

## L'appli, vue par vue

Une seule page ; la vue se choisit par l'ancre, si bien que le bouton
« retour » du navigateur et un lien partagé marchent :

- **connexion** : onglets Connexion / Inscription, e-mail et mot de passe,
  « Mot de passe oublié ? » (le lien d'e-mail mène à la page commune
  `account.lorderis.dev/reinitialiser.html`), puis le bouton de Google
  Identity Services et l'invite One Tap. Le script de Google n'est chargé
  que si `/auth/v1/settings` annonce le fournisseur ET que l'écran de
  connexion s'affiche ; sinon une phrase dit pourquoi le bouton manque. Le
  nonce va haché à Google, brut à Supabase (`google-auth.js`, copie de la
  référence). Textes du kit Lorderis, au mot près ;
- **`#offres`** (par défaut) : le bandeau (mots-clés et villes, « Actualiser »,
  « Réglages »), les compteurs, les filtres, puis les offres encore publiées,
  celles qui ne le sont plus mais qu'on suit, et le nombre des autres
  (affichables d'un clic) ;
- **`#offre-<id>`** : le détail — badges, entreprise, lieu, contrat, dates,
  « Voir l'offre sur … » et « Aussi sur : … » (tous les liens, sans doublon),
  la description, puis le statut, « Fausse offre » et « Ignorer et
  supprimer » ;
- **`#reglages`** : mots-clés, villes avec rayon, types de contrat, salaire
  minimum (€ par mois, facultatif), puis le
  compte (déconnexion de cet appareil, « Gérer mon compte Lorderis »,
  « Supprimer mes données Jobbly ») et « À propos ».

Un compte qui n'a pas encore de réglages est mené aux réglages à son
arrivée, avec une phrase d'accueil ; la liste, elle, le renvoie aux
réglages au lieu d'afficher une liste vide.

## Les badges et les filtres

Les couleurs sont celles du rapport du script (`_CSS` et `_SOURCE_COLORS` de
`job_alert.py`) ; chaque badge porte aussi son mot, et le filet gauche d'une
carte n'est qu'un rappel du statut écrit dans sa liste déroulante.

| Badge | Quand |
|---|---|
| Nouveau | l'offre a été vue la première fois (`first_seen`) après la visite précédente de ce compte sur cet appareil (`jobbly:last-visit`) ; sans visite connue, tout est nouveau, et l'écran le dit |
| ★ Alternance | l'intitulé ou le contrat dit apprenti, apprentissage, alternance, alternant ou professionnalisation (le script ne lisait que l'intitulé) |
| ⇄ Multi-sites | l'offre a été trouvée sur plusieurs sources |
| ⌛ Plus publiée | `gone_at` est posé : les sources ne la rendent plus |
| ⛓ Lien mort | `data.link_dead` : tous ses liens sont morts ; elle n'est gardée que parce qu'on la suit, et le détail le dit sans lien |
| France Travail, Jooble… | chaque source, dans l'ordre de priorité |

Filtres : statut (« Toutes » cache les offres ignorées, comme le script ;
« Ignoré » les retrouve), source, alternance seulement, nouvelles seulement.
Chaque filtre actif a sa coche et son fond ; les nombres affichés sont ceux
des lignes que le filtre donnerait.

## Ce que le site écrit

| Geste | Écriture (PostgREST, schéma `jobbly`) |
|---|---|
| Statut | `offers` : `status`, `status_at` (null pour « À traiter »), rien d'autre |
| Fausse offre | `offers` : `blocked = true` ; l'offre quitte la liste |
| Ignorer et supprimer | `offers` : `status = 'ignore'`, `status_at` ; retour à la liste |
| Enregistrer les réglages | `settings` : upsert de `user_id`, `keywords`, `locations`, `contract_types`, `min_salary` |
| Supprimer mes données | `delete_my_data()` ; vrai = le compte Lorderis est parti aussi ; la page le dit, puis déconnecte l'appareil |

Chaque écriture attend la réponse du serveur : réussie, elle se dit dans une
annonce ; refusée, l'écran revient à l'état enregistré et le dit. La base
refuse de toute façon ce qui sort de sa forme ; les réglages valident avant
d'envoyer (`rules.js`) pour dire l'erreur au bon endroit : 1 à 10 mots-clés
de 2 à 60 caractères, 1 à 5 villes, un rayon entier de 1 à 100 km.

**Une ville se choisit dans la recherche de commune** (API Géo de l'État,
`/communes?nom=…&fields=nom,code,codeDepartement,centre`) : elle pose le
code INSEE et la position, sans lesquels France Travail et La Bonne
Alternance ne cherchent pas. Si l'API ne répond pas, la ville peut être
ajoutée sans commune, et la liste la signale incomplète.

## « Actualiser »

Le bouton appelle `jobbly-search` (`supabase.functions.invoke`, avec la
session) et reste désactivé, avec « Recherche en cours… », jusqu'à la
réponse — de quelques secondes à une minute. Une réponse non 2xx est lue
dans son corps (`error.context`) pour en tirer le code. Ensuite :

- **succès** : offres gardées et nouvelles, annonces reçues, doublons
  fusionnés, liens morts écartés ; puis chaque source qui n'a pas donné
  d'annonces et pourquoi (délai dépassé, erreur du service, sautée faute de
  ville avec sa commune, pas encore configurée). La liste est relue ; si
  cette relecture échoue, l'écran le dit aussi ;
- **un code** : sa phrase (`search.<code>` dans `i18n.js`) — `no_settings`
  (avec un lien vers les réglages), `quota`, `storage_limit`,
  `not_authenticated` (reconnexion), `invalid_request`,
  `method_not_allowed`, `not_configured`, `save_failed` ;
- **une réponse illisible**, même en 200 : `bad_response`, jamais un succès ;
- **le réseau** : `network`.

La liste n'est pas touchée par un échec.

## Langue, thème, pied de page

FR et EN, thème Système / Clair / Sombre, par les deux boutons ronds de
lorderis.dev (`lorderis-toggles.css`, tel quel ; `prefs.js`), gardés sur
l'appareil sous `jobbly:prefs`, posés avant le premier rendu par
`theme-init.js`. En bas des trois pages, le pied de page LordEris, celui de
lorderis.dev et de tous les projets (gabarit d'Account-LordEris,
`reference/footer/` : `lorderis-footer.css` et `assets/img/lorderis-logo.png`
recopiés tels quels) : logo, ©, GitHub, Discord, Fiverr, BuiltByBit,
Confidentialité vers la politique de Jobbly et Mon compte — le seul lien
vers la politique en bas de page, sans bloc « Pages légales » au-dessus. Il
reste sombre dans les deux thèmes, seule exception aux couleurs de Jobbly.

## Les captures de la présentation

`assets/apercu/<offers|offer|settings>-<fr|en>-<light|dark>.webp`, 585 px de
large, moins de 80 ko : l'appli réelle, servie en local, sur les données
inventées de `tools/demo-data.mjs`, par `tools/check-site.mjs --apercu`. Un
écran qui change visiblement se reprend, dans ses quatre variantes.
