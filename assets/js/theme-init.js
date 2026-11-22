// theme-init.js — chargé dans <head>, de façon SYNCHRONE, avant tout rendu.
//
// Pourquoi un fichier et pas un script en ligne : la CSP du site
// (.htaccess) refuse le script en ligne. Pourquoi synchrone : c'est la seule
// façon de poser data-theme avant la première peinture — un script différé
// laisserait voir le mauvais thème une fraction de seconde. Le même fichier
// pose `lang`, pour que lecteurs d'écran et traduction du navigateur sachent
// d'emblée dans quelle langue lire.
//
// Les réglages sont rangés sur l'appareil, jamais dans le compte, sous
// `jobbly:prefs` : un JSON { language, theme } — theme 'system' (défaut) |
// 'light' | 'dark' ; language 'fr' | 'en' ; absent, la langue du navigateur
// si c'est l'anglais, sinon le français, qui est la référence. prefs.js
// écrit dans le même objet ; `?lang=fr|en` l'emporte pour la page seule.
;(function () {
  'use strict'
  var root = document.documentElement
  var prefs = {}
  try { prefs = JSON.parse(window.localStorage.getItem('jobbly:prefs') || '{}') || {} } catch (e) { prefs = {} }
  var pref = prefs.theme
  if (pref !== 'light' && pref !== 'dark') pref = 'system'
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
  root.setAttribute('data-theme', pref === 'system' ? (media && media.matches ? 'dark' : 'light') : pref)
  root.setAttribute('data-theme-pref', pref)

  var lang = prefs.language
  var q = /[?&]lang=(fr|en)(?:&|$)/.exec(window.location.search)
  if (q) lang = q[1]
  if (lang !== 'fr' && lang !== 'en') {
    lang = ((navigator.language || 'fr') + '').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr'
  }
  root.setAttribute('lang', lang)
})()
