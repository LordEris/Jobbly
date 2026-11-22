// prefs.js — les deux boutons ronds de la barre (thème, langue), sur toutes
// les pages : présentation, appli, politique.
//
// Script classique et externe (la CSP refuse l'en ligne), chargé dans <head>
// après theme-init.js. Les boutons sont ceux de lorderis.dev (Account-LordEris,
// reference/toggles/) : le thème tourne Système → Clair → Sombre, la langue
// bascule. Chaque clic RÉÉCRIT le seul champ choisi de `jobbly:prefs` et
// garde l'autre. L'icône suit data-theme-pref, les lettres l'attribut lang ;
// ce fichier tient leurs libellés accessibles (textes du kit, clé `toggles`
// de reference/texts.json, au mot près), qui disent la position courante ET
// la suivante.
//
// Deux évènements préviennent le reste de la page : `lorderis:theme` (le
// bouton de Google se redessine, google-auth.js) et `jobbly:lang` (l'appli
// réécrit ses textes, app.js). Le titre de la page suit la langue quand la
// page porte <meta name="pp-title-fr|en">.
;(function () {
  'use strict'
  var KEY = 'jobbly:prefs'
  var root = document.documentElement

  function readPrefs() {
    try {
      var p = JSON.parse(window.localStorage.getItem(KEY) || '{}')
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {}
    } catch (e) {
      return {}
    }
  }
  function writePref(field, value) {
    var prefs = readPrefs()
    prefs[field] = value
    try { window.localStorage.setItem(KEY, JSON.stringify(prefs)) } catch (e) { /* vaut pour la page */ }
  }
  function themePref() {
    var t = root.getAttribute('data-theme-pref')
    return t === 'light' || t === 'dark' ? t : 'system'
  }
  function applyTheme(pref) {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-theme', pref === 'system' ? (dark ? 'dark' : 'light') : pref)
    root.setAttribute('data-theme-pref', pref)
    document.dispatchEvent(new CustomEvent('lorderis:theme'))
  }
  var ORDER = ['system', 'light', 'dark']
  var NAMES = {
    fr: { system: 'Système', light: 'Clair', dark: 'Sombre' },
    en: { system: 'System', light: 'Light', dark: 'Dark' }
  }
  function nextPref(p) { return ORDER[(ORDER.indexOf(p) + 1) % ORDER.length] }
  function label(selector, text) {
    var els = document.querySelectorAll(selector)
    for (var i = 0; i < els.length; i++) { els[i].setAttribute('aria-label', text); els[i].setAttribute('title', text) }
  }
  function sync() {
    var lang = root.getAttribute('lang') === 'en' ? 'en' : 'fr'
    var meta = document.querySelector('meta[name="pp-title-' + lang + '"]')
    if (meta) document.title = meta.getAttribute('content')
    var pref = themePref()
    var n = NAMES[lang]
    label('.lorderis-theme-toggle', lang === 'en'
      ? 'Theme: ' + n[pref] + '. Switch to ' + n[nextPref(pref)]
      : 'Thème : ' + n[pref] + '. Passer à ' + n[nextPref(pref)])
    label('.lorderis-lang-toggle', lang === 'en' ? 'Switch to French (FR)' : 'Passer en anglais (EN)')
  }

  document.addEventListener('DOMContentLoaded', function () {
    sync()
    var toggles = document.querySelectorAll('.lorderis-toggles')
    for (var i = 0; i < toggles.length; i++) toggles[i].hidden = false
    document.addEventListener('click', function (e) {
      var target = e.target instanceof Element ? e.target : null
      if (!target) return
      if (target.closest('.lorderis-lang-toggle')) {
        var lang = root.getAttribute('lang') === 'en' ? 'fr' : 'en'
        writePref('language', lang)
        root.setAttribute('lang', lang)
        sync()
        document.dispatchEvent(new CustomEvent('jobbly:lang'))
        document.dispatchEvent(new CustomEvent('lorderis:theme'))
        return
      }
      if (target.closest('.lorderis-theme-toggle')) {
        var pref = nextPref(themePref())
        writePref('theme', pref)
        applyTheme(pref)
        sync()
      }
    })
    if (window.matchMedia) {
      var media = window.matchMedia('(prefers-color-scheme: dark)')
      if (media.addEventListener) media.addEventListener('change', function () { if (themePref() === 'system') applyTheme('system') })
    }
  })
})()
