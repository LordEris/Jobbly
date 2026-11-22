// ────────────────────────────────────────────────────────────────────────────
// google-auth.js — COPIE de reference/web/google-auth.js (Account-LordEris)
// ────────────────────────────────────────────────────────────────────────────
// Hors cet en-tête, ce fichier est IDENTIQUE à la référence, valeur de
// GOOGLE_CLIENT_ID comprise (le client Web « Lorderis », commun à toutes les
// apps) : la même poignée de main partout, parce que deux implémentations
// divergent sans rien dire. Une correction de la LOGIQUE se fait dans la
// référence d'abord, puis se recopie ici ; tools/check-site.mjs compare ce
// fichier à la référence quand Account-LordEris est cloné à côté.
//
// Ce que la page lui fournit (offres.html, assets/js/app.js) : `window.sb`,
// le client Supabase ; `window.authPostRedirect()`, la suite d'une connexion
// réussie, la même qu'après un mot de passe ; le bloc `#googleGis`, `hidden`
// tant que le bouton n'est pas monté ; le script de Google, chargé à la
// demande (loadGoogleIdentity, supabase.js) quand l'écran de connexion
// s'affiche et que Supabase annonce le fournisseur ; l'évènement
// `lorderis:theme` (prefs.js), au changement de thème et de langue.
//
// Le nonce : HACHÉ vers Google (`initialize`), BRUT vers Supabase
// (`signInWithIdToken`). Les inverser fait échouer chaque connexion sans
// message utile ; tools/check-site.mjs le tient.
//
// L'origine https://jobbly.lorderis.dev doit figurer dans les « Origines
// JavaScript autorisées » du client Web « Lorderis » : sans elle, Google ne
// dessine pas le bouton, et ne dit rien ailleurs que dans la console.
// ────────────────────────────────────────────────────────────────────────────

;(function () {
  'use strict'

  // Identifiant de client OAuth « Web ». Public par nature : il voyage dans
  // chaque requête d'authentification. Le secret client vit côté Supabase.
  // Un seul endroit à modifier, comme pour `supabase-init.js`.
  const GOOGLE_CLIENT_ID = '60246268427-jh9chkm80i8m90irtlh03qsselo97n27.apps.googleusercontent.com'

  /** SHA-256 → hexadécimal minuscule. */
  async function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /** Nonce aléatoire, 32 octets, en hexadécimal. */
  function randomNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Prépare la paire de nonces.
   * Exportée pour être vérifiable : c'est la partie où une inversion casse tout
   * en silence.
   */
  async function buildNoncePair() {
    const raw = randomNonce()
    return { raw, hashed: await sha256Hex(raw) }
  }

  async function onCredential(response, nonceRaw, onError) {
    try {
      const { data, error } = await window.sb.auth.signInWithIdToken({
        provider: 'google',
        token: response.credential,
        // BRUT ici. Haché côté GIS. Cf. l'en-tête.
        nonce: nonceRaw,
      })
      if (error || !data.user) {
        onError((error && error.message) || 'Connexion Google refusée.')
        return
      }
      // Même destination que la connexion par mot de passe : `auth.js` expose
      // sa redirection pour que les deux chemins n'aient pas deux définitions
      // de « où va-t-on après ».
      if (typeof window.authPostRedirect === 'function') {
        await window.authPostRedirect()
      } else {
        window.location.href = 'account.html'
      }
    } catch (e) {
      onError((e && e.message) || 'Connexion Google impossible.')
    }
  }

  /**
   * Monte le bouton dans `containerId`. No-op silencieux si l'identifiant n'est
   * pas configuré ou si le script GIS n'a pas pu se charger (bloqueur, réseau) :
   * une page d'authentification doit rester utilisable dans les deux cas.
   */
  async function mount(containerId, onError) {
    if (!GOOGLE_CLIENT_ID) return false
    const container = document.getElementById(containerId)
    if (!container) return false
    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      console.warn('[google-auth] SDK Google Identity Services indisponible.')
      return false
    }
    if (!window.sb) {
      console.error('[google-auth] window.sb absent — vérifie l\'ordre des <script>.')
      return false
    }

    const { raw, hashed } = await buildNoncePair()

    // UNE SEULE configuration pour le bouton ET l'invite One Tap
    // (`promptOneTap`, plus bas) : même rappel, même nonce. Une seconde
    // `initialize` pour l'invite tirerait un second nonce, et le jeton de
    // l'une partirait vers Supabase avec le nonce brut de l'autre — l'échec
    // silencieux décrit en tête de fichier.
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      nonce: hashed,
      callback: (response) => { void onCredential(response, raw, onError) },
      // Jamais de connexion sans un geste, même quand un seul compte Google
      // a déjà autorisé le site : l'invite PROPOSE, l'utilisateur choisit.
      auto_select: false,
      cancel_on_tap_outside: true,
      // FedCM : la voie que Chrome impose désormais à One Tap, les cookies
      // tiers qui la portaient disparaissant. L'invite est alors dessinée par
      // le navigateur, hors de la page, et ne recouvre plus le formulaire —
      // c'est ce qui levait l'objection qui l'avait fait écarter.
      use_fedcm_for_prompt: true,
      // Safari et Firefox, qui bloquent ces cookies depuis longtemps : la
      // variante qu'ils savent afficher, plutôt que rien.
      itp_support: true,
      // « Se connecter à … avec Google » : la page est un écran de connexion.
      context: 'signin',
    })
    initialized = true

    // `shape` est l'une des quatre valeurs que GIS accepte — rectangular,
    // square, pill, circle. On prend `pill` parce que tous les boutons du
    // design system sont en `border-radius:999px` : à `rectangular`, le bouton
    // Google était le seul angle droit de la page. Le reste des options n'est
    // pas négociable de la même façon — la marque, le libellé et la typographie
    // appartiennent à Google et ne se surchargent pas.
    // LA LARGEUR SE MESURE SUR UN ÉLÉMENT VISIBLE, SINON ELLE VAUT ZÉRO.
    // `container` vit dans un bloc encore `hidden` — c'est auth.js qui le
    // révèle, et seulement APRÈS ce montage. `clientWidth` y valait donc
    // toujours 0, et Google recevait invariablement les 320 px de repli, quelle
    // que soit la largeur réelle de la carte. Le repli n'était pas un repli :
    // c'était la seule valeur jamais utilisée.
    //
    // On révèle donc le bloc AVANT de mesurer, et on le remasque si le rendu
    // échoue — l'intention d'origine tient toujours : pas de bouton mort à
    // l'écran quand Google ne répond pas.
    //
    // LE THÈME SUIT CELUI DE LA PAGE (gabarit commun de l'écran de connexion
    // Lorderis) : `outline` en clair, `filled_black` en sombre. Un bouton noir
    // figé était le seul aplat sombre d'une page claire. Le bouton est
    // redessiné quand le thème change (évènement `lorderis:theme` de
    // theme-init.js) ; le nonce, lui, reste celui de `initialize` ci-dessus.
    function render() {
      // 400 px est le maximum accepté par GIS ; au-delà, il rogne lui-même.
      const largeur = Math.min(400, Math.round(container.getBoundingClientRect().width) || 320)
      const clair = document.documentElement.getAttribute('data-theme') === 'light'
      window.google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: clair ? 'outline' : 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        // « Continuer avec Google » dans la langue de la PAGE (FR ou EN), pas
        // dans celle du navigateur : sinon un site affiché en anglais montre
        // un bouton en français, ou l'inverse.
        locale: (document.documentElement.lang || 'fr').slice(0, 2),
        width: largeur,
      })
    }

    const bloc = container.closest('[hidden]')
    if (bloc) bloc.hidden = false
    try {
      render()
    } catch (e) {
      if (bloc) bloc.hidden = true
      throw e
    }
    if (!container.dataset.themeFollow) {
      container.dataset.themeFollow = '1'
      document.addEventListener('lorderis:theme', () => {
        try { render() } catch (e) { console.warn('[google-auth] bouton non redessiné.', e) }
      })
    }

    return true
  }

  // ── One Tap : l'invite qui propose le compte Google ───────────────────────
  // Demandée par le propriétaire : l'écran de connexion PROPOSE de lui-même le
  // choix du compte Google, en plus du bouton, qui reste — le bouton est le
  // geste explicite, l'invite un raccourci qu'on peut ignorer.
  //
  // Quatre règles, toutes tenues ici plutôt que dans chaque page :
  //   · l'invite n'est demandée qu'APRÈS un montage réussi du bouton :
  //     c'est `mount()` qui pose la configuration commune (nonce, rappel) ;
  //   · jamais par-dessus une session ouverte : lue avant de demander, et une
  //     session qui s'ouvre ensuite (mot de passe, bouton) ferme l'invite. Une
  //     session illisible compte comme ouverte — dans le doute, on ne
  //     propose rien, le bouton reste là ;
  //   · une fois par page, et plus du tout de la visite (l'onglet) quand
  //     l'utilisateur l'a fermée : la relancer à chaque chargement serait
  //     harceler quelqu'un qui a déjà dit non ;
  //   · elle se ferme quand on quitte la page (`pagehide`), ce qui couvre
  //     aussi le retour depuis le cache de navigation.
  //
  // L'invite elle-même ne s'éprouve qu'EN LIGNE : Google ne l'affiche que pour
  // une origine déclarée sur le client OAuth, et FedCM n'est pas offert à un
  // navigateur piloté par un outil de test.
  const ONE_TAP_CLOSED_KEY = 'lorderis.googleOneTap.closed'
  let initialized = false
  let oneTapOffered = false
  let oneTap = null
  let watchingSession = false

  // sessionStorage peut lever (stockage bloqué pour le site) : sans lui, on
  // retombe sur la seule règle « une fois par page ».
  function oneTapClosedThisVisit() {
    try { return window.sessionStorage.getItem(ONE_TAP_CLOSED_KEY) === '1' } catch (e) { return false }
  }
  function rememberOneTapClosed() {
    try { window.sessionStorage.setItem(ONE_TAP_CLOSED_KEY, '1') } catch (e) { /* rien à faire */ }
  }

  /** Ferme l'invite si elle est ouverte. Sans effet sinon. */
  function cancelOneTap() {
    if (!oneTap) return
    // Marquée AVANT `cancel()` : GIS rend alors un moment « passé » qu'il ne
    // faut pas prendre pour un refus de l'utilisateur.
    oneTap.cancelledByPage = true
    oneTap = null
    try { window.google.accounts.id.cancel() } catch (e) { /* SDK parti : rien à fermer */ }
  }

  /**
   * Propose l'invite One Tap. Rend `true` si elle a été demandée à Google —
   * ce qui ne dit pas qu'elle s'affiche : c'est Google qui en décide (compte
   * connecté au navigateur, délai après un refus, origine autorisée).
   */
  async function promptOneTap() {
    if (!initialized || oneTapOffered || oneTapClosedThisVisit()) return false
    oneTapOffered = true
    try {
      const { data } = await window.sb.auth.getSession()
      if (data && data.session) return false
    } catch (e) {
      return false
    }

    if (!watchingSession) {
      watchingSession = true
      window.sb.auth.onAuthStateChange((event, session) => { if (session) cancelOneTap() })
      window.addEventListener('pagehide', cancelOneTap)
    }

    const current = { cancelledByPage: false }
    oneTap = current
    window.google.accounts.id.prompt((moment) => {
      if (current.cancelledByPage) return
      // Sous FedCM, seuls les moments « passé » et « fermé » sont rapportés.
      const dismissed = !!(moment && moment.isDismissedMoment && moment.isDismissedMoment())
      const skipped = !!(moment && moment.isSkippedMoment && moment.isSkippedMoment())
      if (!dismissed && !skipped) return
      if (oneTap === current) oneTap = null
      const reason = dismissed && moment.getDismissedReason ? moment.getDismissedReason() : ''
      // Un compte choisi n'est pas un refus : la connexion suit son cours.
      if (reason !== 'credential_returned') rememberOneTapClosed()
    })
    return true
  }

  window.googleAuth = {
    mount,
    promptOneTap,
    cancelOneTap,
    buildNoncePair,
    sha256Hex,
    isConfigured: () => !!GOOGLE_CLIENT_ID,
  }
})()
