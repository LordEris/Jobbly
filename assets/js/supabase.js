// ────────────────────────────────────────────────────────────────────────────
// supabase.js — le client du projet commun, pour le site de Jobbly
// ────────────────────────────────────────────────────────────────────────────
// Copie de reference/web/supabase.js (Account-LordEris), à trois écarts
// près, dits ici :
//   · APP_SCHEMA vaut 'jobbly' ;
//   · SITE_URL est l'adresse de l'APPLI (offres.html), pas celle du site : le
//     lien de confirmation d'une inscription y revient directement, sans
//     passer par la présentation (presentation.js l'y renverrait de toute
//     façon, requête et fragment intacts) ;
//   · googleWebClientId() n'est pas repris : la copie de google-auth.js
//     porte le client Web « Lorderis » en constante, comme la référence.
// Une correction de la logique se fait dans la référence d'abord.
// Le SDK est chargé par la page depuis jsdelivr, version figée et empreinte
// SRI ; la CSP du site admet https://cdn.jsdelivr.net en script-src et
// l'adresse du projet en connect-src (.htaccess).
// ────────────────────────────────────────────────────────────────────────────

export const SUPABASE_URL = 'https://imbfggbrkpzbqcouxseo.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_wjlH0jcxp6u7c1l3u6o1vA_g1PI8FcN'
export const APP_SCHEMA = 'jobbly'
// Les adresses de retour sont FIXES et figurent dans les Redirect URLs du
// projet : une adresse déduite de la barre d'adresse enverrait, depuis une
// copie du site servie ailleurs, des liens que Supabase refuserait.
export const SITE_URL = 'https://jobbly.lorderis.dev/offres.html'
export const PASSWORD_RESET_REDIRECT_TO = 'https://account.lorderis.dev/reinitialiser.html'
// La fonction Edge qui interroge les sources (dépôt Jobbly,
// supabase/functions/jobbly-search/), avec la session de la personne.
export const SEARCH_FUNCTION = 'jobbly-search'

/** Le client, ou null si le SDK n'a pas pu se charger (la page le dit alors). */
export function createSupabase() {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return null
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    db: { schema: APP_SCHEMA },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
}

/** Après l'initialisation : le jeton ne reste ni dans l'historique ni à l'écran. */
export function cleanUrl() {
  if (window.location.hash || window.location.search) {
    try { window.history.replaceState({}, '', window.location.pathname) } catch (e) { /* rien */ }
  }
}

/** Déconnexion de CET appareil : la portée par défaut fermerait toutes les apps. */
export function signOutHere(sb) {
  return sb.auth.signOut({ scope: 'local' })
}

export function signUp(sb, email, password) {
  return sb.auth.signUp({ email, password, options: { emailRedirectTo: SITE_URL } })
}

export function sendPasswordReset(sb, email) {
  return sb.auth.resetPasswordForEmail(email, { redirectTo: PASSWORD_RESET_REDIRECT_TO })
}

let gisLoading = null

/**
 * Charge le script de Google Identity Services, une fois, et seulement quand
 * on le demande (écran de connexion affiché ET fournisseur annoncé). Promesse
 * rompue s'il n'a pas pu se charger (bloqueur, réseau, CSP) : la page le dit.
 */
export function loadGoogleIdentity() {
  if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve()
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.addEventListener('load', () => resolve())
      script.addEventListener('error', () => {
        gisLoading = null
        script.remove()
        reject(new Error('gis_unavailable'))
      })
      document.head.append(script)
    })
  }
  return gisLoading
}

/**
 * Le fournisseur Google est-il activé dans le projet ? Vrai, faux, ou null si
 * on n'a pas pu le savoir — et null n'est pas « oui » : le bouton reste masqué,
 * avec une phrase.
 */
export async function googleEnabled() {
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/settings', { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } })
    if (!res.ok) return null
    const s = await res.json()
    return s && s.external && typeof s.external.google === 'boolean' ? s.external.google : null
  } catch (e) {
    return null
  }
}
