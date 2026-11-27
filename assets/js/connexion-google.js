// ────────────────────────────────────────────────────────────────────────────
// reference/web/connexion-google.js — la page de retour de Google
// ────────────────────────────────────────────────────────────────────────────
// Le script de /connexion-google.html (reference/web/connexion-google.html),
// où Google renvoie après « Continuer avec Google » (google-auth.js) :
//   https://<site>/connexion-google.html#id_token=…&state=…
// ou, refusé ou annulé, #error=access_denied&state=…
//
// Il ne connecte personne et ne parle à personne (CSP de la page :
// connect-src 'none') : il lit le fragment, L'EFFACE AUSSITÔT de la barre
// d'adresse (ni historique, ni capture d'écran ne doivent le garder),
// vérifie que l'état est celui de la demande en cours de CET onglet, de moins
// de dix minutes, range le résultat dans sessionStorage
// (`lorderis.google.result`) et revient à l'adresse de départ — un chemin du
// même site, sinon l'écran de connexion que la page nomme
// (`<meta name="lorderis-google-signin">`). C'est là que `finish()` de
// google-auth.js consomme le résultat, une seule fois, et donne le jeton à
// Supabase avec le nonce brut.
//
// Recopié TEL QUEL dans chaque site, comme google-auth.js : les clés, la durée
// et le chemin sont les siens ; ce qui est propre au site est dans la page.
// ────────────────────────────────────────────────────────────────────────────

;(function () {
  'use strict'

  const PENDING_KEY = 'lorderis.google.pending'
  const RESULT_KEY = 'lorderis.google.result'
  const MAX_AGE_MS = 10 * 60 * 1000
  const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

  /** Un chemin du même site, et rien d'autre (même règle que google-auth.js). */
  function sameOriginPath(value) {
    if (typeof value !== 'string' || value.length > 2048) return null
    if (!/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return null
    return value
  }

  /**
   * Juge un retour de Google. Pure : tools/test-google.mjs la rejoue.
   * Rend { result, returnTo } — `result` à ranger (null : rien à dire) et le
   * chemin où revenir.
   */
  function judge({ hash, pending, now, signinPath }) {
    const fallback = sameOriginPath(signinPath) || '/'
    const returnTo = (pending && sameOriginPath(pending.returnTo)) || fallback
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''))
    const state = params.get('state')
    const idToken = params.get('id_token')
    const error = params.get('error')
    // Une adresse sans réponse de Google (rechargée, tapée) : rien à dire.
    if (!state && !idToken && !error) return { result: null, returnTo }
    const fresh = !!pending && typeof pending.state === 'string' && typeof pending.createdAt === 'number' &&
      now - pending.createdAt >= 0 && now - pending.createdAt <= MAX_AGE_MS
    if (!fresh || state !== pending.state) return { result: { state: null, error: 'expired' }, returnTo }
    if (error) return { result: { state, error: /^[a-z_]{1,64}$/.test(error) ? error : 'unknown' }, returnTo }
    if (!idToken || idToken.length > 8192 || !JWT.test(idToken)) return { result: { state, error: 'invalid_response' }, returnTo }
    return { result: { state, idToken }, returnTo }
  }

  function main() {
    const loc = window.location
    const hash = loc.hash
    try { window.history.replaceState(null, '', loc.pathname) } catch (e) { /* rien de plus à effacer */ }
    let pending = null
    try { pending = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) || 'null') } catch (e) { pending = null }
    const meta = document.querySelector('meta[name="lorderis-google-signin"]')
    const { result, returnTo } = judge({ hash, pending, now: Date.now(), signinPath: meta && meta.getAttribute('content') })
    if (result) {
      try { window.sessionStorage.setItem(RESULT_KEY, JSON.stringify(result)) } catch (e) { /* la page de départ ne verra rien : elle reste telle quelle */ }
    }
    loc.replace(returnTo)
  }

  window.googleReturn = { judge, sameOriginPath, PENDING_KEY, RESULT_KEY, MAX_AGE_MS }
  if (typeof document !== 'undefined' && document.querySelector) main()
})()
