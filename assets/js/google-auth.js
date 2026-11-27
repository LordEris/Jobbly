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
// réussie, la même qu'après un mot de passe ; le bouton `#googleBtn`, qui
// appelle `start()` (la page part chez Google, dans le même onglet) ;
// `finish()` au retour de connexion-google.html (assets/js/connexion-google.js,
// copie à l'octet de reference/web/connexion-google.js) ; le script de
// Google, chargé à la demande (loadGoogleIdentity, supabase.js) pour la seule
// invite One Tap, quand l'écran de connexion s'affiche à l'adresse publiée et
// que Supabase annonce le fournisseur.
//
// Le nonce : HACHÉ vers Google (l'adresse de départ, l'`initialize` de
// l'invite), BRUT vers Supabase (`signInWithIdToken`). Les inverser fait
// échouer chaque connexion sans message utile ; tools/check-site.mjs le tient.
//
// https://jobbly.lorderis.dev/connexion-google.html doit figurer dans les
// « URI de redirection autorisés » du client Web « Lorderis » (sinon Google
// affiche redirect_uri_mismatch), et https://jobbly.lorderis.dev dans ses
// « Origines JavaScript autorisées » (sinon l'invite ne s'affiche pas).
// ────────────────────────────────────────────────────────────────────────────

;(function () {
  'use strict'

  // Identifiant de client OAuth « Web ». Public par nature : il voyage dans
  // chaque requête d'authentification. Le secret client vit côté Supabase.
  const GOOGLE_CLIENT_ID = '60246268427-jh9chkm80i8m90irtlh03qsselo97n27.apps.googleusercontent.com'

  const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
  // La page de retour, à la racine de chaque site : la même adresse partout,
  // déclarée telle quelle chez Google.
  const RETURN_PATH = '/connexion-google.html'
  // Les deux clés partagées avec la page de retour (connexion-google.js).
  const PENDING_KEY = 'lorderis.google.pending'
  const RESULT_KEY = 'lorderis.google.result'
  const MAX_AGE_MS = 10 * 60 * 1000

  /** SHA-256 → hexadécimal minuscule. */
  async function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /** 32 octets aléatoires, en hexadécimal. */
  function randomHex() {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Prépare la paire de nonces.
   * Exportée pour être vérifiable : c'est la partie où une inversion casse tout
   * en silence.
   */
  async function buildNoncePair() {
    const raw = randomHex()
    return { raw, hashed: await sha256Hex(raw) }
  }

  /** La langue de la PAGE (fr ou en), pas celle du navigateur. */
  function pageLang() {
    return (document.documentElement.lang || 'fr').slice(0, 2) === 'en' ? 'en' : 'fr'
  }

  /**
   * Un chemin de la même origine, et rien d'autre : commence par une seule
   * barre, sans « // » ni « /\ » (que les navigateurs lisent comme une autre
   * origine), sans caractère de contrôle. Rend `null` sinon.
   */
  function sameOriginPath(value) {
    if (typeof value !== 'string' || value.length > 2048) return null
    if (!/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return null
    return value
  }

  /** L'adresse de départ chez Google. Pure : tools/test-google.mjs la relit. */
  function authorizeUrl({ origin, hashedNonce, state, lang }) {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: origin + RETURN_PATH,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce: hashedNonce,
      state,
      // Le choix du compte à chaque fois : un compte Google déjà ouvert dans
      // le navigateur ne doit pas être pris sans qu'on l'ait désigné.
      prompt: 'select_account',
      hl: lang === 'en' ? 'en' : 'fr',
    })
    return AUTHORIZE_URL + '?' + params.toString().replace(/\+/g, '%20')
  }

  // sessionStorage peut lever (stockage bloqué pour le site, navigation
  // privée stricte) : chaque accès est gardé.
  function readJson(key) {
    try {
      const value = window.sessionStorage.getItem(key)
      return value ? JSON.parse(value) : null
    } catch (e) {
      return null
    }
  }
  function remove(key) {
    try { window.sessionStorage.removeItem(key) } catch (e) { /* rien à retirer */ }
  }

  /**
   * Part chez Google, dans le même onglet. Lève `storage_unavailable` si la
   * demande ne peut pas être rangée : sans elle, le retour serait refusé, et
   * mieux vaut le dire avant de partir.
   */
  async function start() {
    if (!GOOGLE_CLIENT_ID) throw new Error('not_configured')
    const { raw, hashed } = await buildNoncePair()
    const state = randomHex()
    const loc = window.location
    const returnTo = sameOriginPath(loc.pathname + loc.search + loc.hash) || '/'
    try {
      window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, rawNonce: raw, returnTo, createdAt: Date.now() }))
      window.sessionStorage.removeItem(RESULT_KEY)
    } catch (e) {
      throw new Error('storage_unavailable')
    }
    cancelOneTap()
    loc.assign(authorizeUrl({ origin: loc.origin, hashedNonce: hashed, state, lang: pageLang() }))
  }

  async function exchange(token, rawNonce, onError) {
    try {
      const { data, error } = await window.sb.auth.signInWithIdToken({
        provider: 'google',
        token,
        // BRUT ici. Haché côté Google. Cf. l'en-tête.
        nonce: rawNonce,
      })
      if (error || !data || !data.user) {
        onError('refused', (error && error.message) || '')
        return false
      }
      // Même destination que la connexion par mot de passe : la page expose
      // sa suite pour que les deux chemins n'aient pas deux définitions de
      // « où va-t-on après ».
      if (typeof window.authPostRedirect === 'function') await window.authPostRedirect()
      return true
    } catch (e) {
      const message = (e && e.message) || ''
      onError(/fetch|network|load failed/i.test(message) ? 'network' : 'refused', message)
      return false
    }
  }

  /**
   * Au chargement de la page : termine une connexion revenue de Google, s'il
   * y en a une. Rend `false` s'il n'y avait rien à terminer, `true` sinon
   * (réussie ou non : l'échec est passé à `onError(code, message)`, avec
   * code = 'cancelled' | 'expired' | 'refused' | 'network'). Le résultat est
   * consommé une seule fois : les deux clés sont retirées avant tout appel.
   */
  async function finish(onError) {
    const result = readJson(RESULT_KEY)
    if (!result) return false
    const pending = readJson(PENDING_KEY)
    remove(RESULT_KEY)
    remove(PENDING_KEY)
    const fresh = pending && typeof pending.state === 'string' && typeof pending.rawNonce === 'string' &&
      typeof pending.createdAt === 'number' && Date.now() - pending.createdAt >= 0 && Date.now() - pending.createdAt <= MAX_AGE_MS
    if (result.error === 'access_denied') { onError('cancelled', ''); return true }
    if (!fresh || result.state !== pending.state) { onError('expired', ''); return true }
    if (result.error || typeof result.idToken !== 'string') { onError('refused', String(result.error || '')); return true }
    await exchange(result.idToken, pending.rawNonce, onError)
    return true
  }

  // ── One Tap : l'invite qui propose le compte Google ───────────────────────
  // L'écran de connexion PROPOSE de lui-même le compte Google, en plus du
  // bouton, qui reste le geste explicite ; l'invite est un raccourci qu'on
  // peut ignorer. Elle est dessinée par Google, dans la page (ou par le
  // navigateur, sous FedCM) : aucune fenêtre, sauf sous Safari et Firefox,
  // où Google termine dans la sienne (d'où la COOP de la page de connexion).
  //
  // Quatre règles, toutes tenues ici plutôt que dans chaque page :
  //   · une seule configuration (`initialize`) pour la page, avec SON nonce ;
  //   · jamais par-dessus une session ouverte : lue avant de demander, et une
  //     session qui s'ouvre ensuite (mot de passe) ferme l'invite. Une
  //     session illisible compte comme ouverte — dans le doute, on ne
  //     propose rien, le bouton reste là ;
  //   · une fois par page, et plus du tout de la visite (l'onglet) quand
  //     l'utilisateur l'a fermée : la relancer à chaque chargement serait
  //     harceler quelqu'un qui a déjà dit non ;
  //   · elle se ferme quand on quitte la page (`pagehide`) ou qu'on part
  //     chez Google par le bouton.
  //
  // L'invite elle-même ne s'éprouve qu'EN LIGNE : Google ne l'affiche que pour
  // une origine déclarée sur le client OAuth, et FedCM n'est pas offert à un
  // navigateur piloté par un outil de test.
  const ONE_TAP_CLOSED_KEY = 'lorderis.googleOneTap.closed'
  let initialized = false
  let oneTapOffered = false
  let oneTap = null
  let watchingSession = false

  function oneTapClosedThisVisit() {
    try { return window.sessionStorage.getItem(ONE_TAP_CLOSED_KEY) === '1' } catch (e) { return false }
  }
  function rememberOneTapClosed() {
    try { window.sessionStorage.setItem(ONE_TAP_CLOSED_KEY, '1') } catch (e) { /* rien à faire */ }
  }

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.id)
  }

  /** Ferme l'invite si elle est ouverte. Sans effet sinon. */
  function cancelOneTap() {
    if (!oneTap) return
    // Marquée AVANT `cancel()` : Google rend alors un moment « passé » qu'il
    // ne faut pas prendre pour un refus de l'utilisateur.
    oneTap.cancelledByPage = true
    oneTap = null
    try { window.google.accounts.id.cancel() } catch (e) { /* script parti : rien à fermer */ }
  }

  /**
   * Propose l'invite One Tap. Le script de Google doit être chargé. Rend
   * `true` si elle a été demandée à Google — ce qui ne dit pas qu'elle
   * s'affiche : c'est Google qui en décide (compte connecté au navigateur,
   * délai après un refus, origine autorisée).
   */
  async function promptOneTap(onError) {
    if (!GOOGLE_CLIENT_ID || !gisReady() || !window.sb) return false
    if (oneTapOffered || oneTapClosedThisVisit()) return false
    oneTapOffered = true
    try {
      const { data } = await window.sb.auth.getSession()
      if (data && data.session) return false
    } catch (e) {
      return false
    }

    if (!initialized) {
      const { raw, hashed } = await buildNoncePair()
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        nonce: hashed,
        callback: (response) => { void exchange(response && response.credential, raw, onError) },
        // Jamais de connexion sans un geste, même quand un seul compte Google
        // a déjà autorisé le site : l'invite PROPOSE, l'utilisateur choisit.
        auto_select: false,
        cancel_on_tap_outside: true,
        // FedCM : la voie que Chrome impose désormais à One Tap ; l'invite est
        // dessinée par le navigateur, hors de la page.
        use_fedcm_for_prompt: true,
        // Safari et Firefox : la variante qu'ils savent afficher, plutôt que rien.
        itp_support: true,
        // « Se connecter à … avec Google » : la page est un écran de connexion.
        context: 'signin',
      })
      initialized = true
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
    start,
    finish,
    promptOneTap,
    cancelOneTap,
    authorizeUrl,
    sameOriginPath,
    buildNoncePair,
    sha256Hex,
    isConfigured: () => !!GOOGLE_CLIENT_ID,
    RETURN_PATH,
    PENDING_KEY,
    RESULT_KEY,
    MAX_AGE_MS,
  }
})()
