// presentation.js — gabarit commun des pages de présentation Lorderis
// Source : Account-LordEris, reference/presentation/presentation.js
// Mode d'emploi : docs/presentation.md
//
// Recopié TEL QUEL. Script classique et externe (les CSP du projet refusent
// le script en ligne), chargé dans <head> de la présentation, de façon
// SYNCHRONE et avant les feuilles de style : quand il change de page, rien de
// la présentation n'a encore été peint.
//
// La présentation vit à l'adresse du site ; l'appli, juste derrière, sur le
// même site (« Ouvrir l'appli »). Ce script fait deux choses, et rien d'autre :
//
//  1. UN RETOUR D'AUTORISATION ARRIVÉ ICI VA À L'APPLI, INTACT. Un `?code=`,
//     une erreur ou des jetons dans l'adresse ne sont pas pour la
//     présentation : la page les rend à l'appli sans les lire, chemin de
//     l'appli + même requête + même fragment, et c'est l'appli qui juge (et
//     refuse ce qu'elle n'a pas demandé). Sans cela, le code serait perdu sur
//     une page qui ne sait pas quoi en faire. Le serveur fait de même quand il
//     le peut (la requête) ; le fragment, lui, ne lui parvient jamais.
//  2. QUI A DÉJÀ OUVERT L'APPLI DANS CE NAVIGATEUR Y EST MENÉ DIRECTEMENT.
//     L'appli pose une marque dans le stockage du navigateur ; si elle est
//     là, la présentation laisse la place. `?presentation` dans l'adresse la
//     montre quand même — c'est le lien « Qu'est-ce que … ? » de l'appli, et
//     la marque des pages du site —, comme une ancre (`/#questions`) : on est
//     venu la lire. `?presentation` est alors retiré de la barre d'adresse,
//     qui redevient celle du site.
//
// Réglé par deux balises <meta> de la page, sans rien d'autre à écrire :
//   <meta name="lorderis-app-path" content="/record" />
//       l'adresse de l'appli SUR LE MÊME SITE : un chemin qui commence par une
//       seule barre. Autre chose (une autre origine, `//hote`, `javascript:`)
//       et le script ne fait rien.
//   <meta name="lorderis-app-opened-key" content="<app>:app-opened" />
//       facultative : la clé de la marque que pose l'appli. Absente, la
//       présentation reste toujours devant (point 2 éteint).
// Le stockage peut être refusé (navigation privée stricte) : son accès est
// dans un try, et un refus montre simplement la présentation.
;(function () {
  'use strict'
  function meta(name) {
    var m = document.querySelector('meta[name="' + name + '"]')
    return m ? m.getAttribute('content') || '' : ''
  }
  var app = meta('lorderis-app-path')
  if (!/^\/(?![\/\\])[A-Za-z0-9._~\/-]*$/.test(app)) return

  var loc = window.location
  // L'appli n'est pas la présentation elle-même : sinon la page se
  // rechargerait sans fin.
  var trim = function (p) { return p.replace(/\/+$/, '') }
  if (trim(app) === trim(loc.pathname)) return
  var search = loc.search || ''
  var hash = loc.hash || ''
  // Les clés d'un retour d'autorisation (OAuth, Supabase Auth). Seuls les NOMS
  // sont regardés : aucune valeur n'est lue ici.
  var RETURN = /(?:^|[?&#])(code|error|error_code|error_description|access_token|refresh_token|provider_token|id_token|token_hash)=/
  if (RETURN.test(search) || RETURN.test(hash)) {
    loc.replace(app + search + hash)
    return
  }

  if (/(?:^|[?&])presentation(?:[=&]|$)/.test(search)) {
    // `?presentation` a servi : la page reste. Il quitte la barre d'adresse,
    // le reste de la requête et l'ancre demeurant tels quels : un retour à
    // l'accueil (la marque, « Qu'est-ce que … ? ») finit à l'adresse du site,
    // propre. Recharger mène alors où mène l'adresse du site ; une ancre
    // continue de montrer la page.
    var rest = search.slice(1).split('&').filter(function (p) {
      return p && !/^presentation(?:=|$)/.test(p)
    }).join('&')
    try {
      window.history.replaceState(window.history.state, '', loc.pathname + (rest ? '?' + rest : '') + hash)
    } catch (e) { /* l'adresse garde ?presentation, la page s'affiche quand même */ }
    return
  }
  if (hash.length > 1) return
  var key = meta('lorderis-app-opened-key')
  if (!key) return
  var opened = null
  try { opened = window.localStorage.getItem(key) } catch (e) { opened = null }
  if (opened) loc.replace(app)
})()
