// ────────────────────────────────────────────────────────────────────────────
// app.js — l'appli de Jobbly (offres.html)
// ────────────────────────────────────────────────────────────────────────────
// Connexion au compte Lorderis, puis trois vues choisies par l'ancre :
//   #offres (défaut)  la liste ;  #offre-<id>  le détail ;  #reglages.
// Les données sont celles du schéma `jobbly` du projet commun, lues et
// écrites avec la session de la personne, sous la RLS ; la recherche passe
// par la fonction Edge `jobbly-search`. Les règles sont dans rules.js (pures,
// testées) ; ce fichier ne fait que les brancher sur la page.
//
// Trois règles tiennent tout l'écran :
//  · UN ÉCHEC SE DIT : une lecture ratée n'est jamais une liste vide, une
//    écriture ratée remet l'écran comme avant et le dit ;
//  · TOUT CE QUI VIENT DU RÉSEAU EST DU TEXTE : rien ne passe par innerHTML,
//    tout par textContent, et une adresse n'est ouverte que si elle est en
//    http(s) (rules.safeUrl) ;
//  · AUCUNE VALEUR DE LA PERSONNE DANS LA CONSOLE : seulement des codes.
// ────────────────────────────────────────────────────────────────────────────

import { createSupabase, cleanUrl, signOutHere, signUp, sendPasswordReset, loadGoogleIdentity, googleEnabled, SEARCH_FUNCTION } from './supabase.js'
import * as R from './rules.js'
import { t, lang, applyI18n } from './i18n.js'

const $ = (id) => document.getElementById(id)
const VIEWS = ['viewLoading', 'viewUnavailable', 'viewSignIn', 'viewOffers', 'viewOffer', 'viewSettings', 'viewDeleted']
const LAST_VISIT_KEY = 'jobbly:last-visit'
const APP_OPENED_KEY = 'jobbly:app-opened'

const state = {
  sb: null,
  user: null,
  mode: 'signin',          // onglet de connexion : signin | signup
  lastVisit: null,         // la visite précédente de ce compte, sur cet appareil
  settings: undefined,     // undefined : pas lus ; null : aucun ; objet sinon
  settingsError: false,
  offers: null,            // null : pas lues ; [] : aucune
  offersError: false,
  filters: { status: 'all', source: 'all', alt: false, onlyNew: false },
  showAllGone: false,
  searching: false,
  lastSearch: null,        // le dernier résultat de recherche, affiché
  draft: null,             // les réglages en cours d'édition
  dirty: false,
  firstSettings: false,
}

// ── Petits outils de DOM, sans innerHTML ───────────────────────────────────

function el(tag, attrs, ...children) {
  const n = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') n.className = v
      else if (k === 'text') n.textContent = v
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
      else n.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    n.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return n
}

/** Un message : un mot (icône CSS) et du texte, jamais la seule couleur. */
function statusBox(kind, ...body) {
  return el('div', { class: 'status' + (kind ? ' status--' + kind : '') }, el('div', { class: 'status__body' }, ...body))
}

function setBox(id, node) {
  const box = $(id)
  box.replaceChildren()
  if (node) box.append(node)
}

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view
  $('appNav').hidden = !state.user
  $('navOffers').toggleAttribute('aria-current', view === 'viewOffers' || view === 'viewOffer')
  if (view === 'viewOffers' || view === 'viewOffer') $('navOffers').setAttribute('aria-current', 'page')
  $('navSettings').toggleAttribute('aria-current', view === 'viewSettings')
  if (view === 'viewSettings') $('navSettings').setAttribute('aria-current', 'page')
}

let toastTimer = null
function toast(text) {
  const n = $('toast')
  n.textContent = text
  n.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { n.hidden = true }, 3500)
}

/** Une confirmation dans une boîte native ; rend vrai si on confirme. */
function confirmBox(title, text, okLabel) {
  const d = $('confirmDialog')
  $('confirmTitle').textContent = title
  $('confirmText').textContent = text
  $('confirmOk').textContent = okLabel
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true })
    d.returnValue = ''
    d.showModal()
  })
}

function storageGet(key) { try { return window.localStorage.getItem(key) } catch (e) { return null } }
function storageSet(key, v) { try { window.localStorage.setItem(key, v) } catch (e) { /* le stockage est refusé : sans effet */ } }

// ── Démarrage ──────────────────────────────────────────────────────────────

async function start() {
  applyI18n()
  const sb = createSupabase()
  if (!sb) { show('viewUnavailable'); return }
  state.sb = sb
  window.sb = sb
  window.authPostRedirect = async () => {
    const { data } = await sb.auth.getSession()
    if (data && data.session) await enterApp(data.session)
  }

  let session = null
  try {
    const { data } = await sb.auth.getSession()
    session = data ? data.session : null
  } catch (e) {
    session = null
  }
  // Un retour de lien d'e-mail a été lu par le SDK : ses jetons quittent
  // l'adresse. L'ancre d'une vue de l'appli, elle, reste.
  if (/(^#|[?&#])(access_token|refresh_token|error|error_description|code|token_hash)=/.test(location.hash + location.search)) cleanUrl()

  sb.auth.onAuthStateChange((event, s) => {
    if (event === 'SIGNED_OUT') { state.user = null; showSignIn() }
    else if (event === 'SIGNED_IN' && s && !state.user) void enterApp(s)
  })

  if (session) await enterApp(session)
  else showSignIn()
}

// ── Connexion ──────────────────────────────────────────────────────────────

let googleTried = false

function showSignIn() {
  show('viewSignIn')
  setMode(state.mode)
  if (!googleTried) { googleTried = true; void setupGoogle() }
}

function setMode(mode) {
  state.mode = mode
  const up = mode === 'signup'
  $('tabSignIn').setAttribute('aria-selected', String(!up))
  $('tabSignUp').setAttribute('aria-selected', String(up))
  $('authForm').setAttribute('aria-labelledby', up ? 'tabSignUp' : 'tabSignIn')
  $('signUpNote').hidden = !up
  $('forgotBtn').hidden = up
  $('authPassword').setAttribute('autocomplete', up ? 'new-password' : 'current-password')
  const btn = $('authSubmit')
  btn.setAttribute('data-i18n', up ? 'auth.create' : 'auth.submit')
  btn.textContent = t(up ? 'auth.create' : 'auth.submit')
  setBox('authStatus', null)
}

function authError(error) {
  setBox('authStatus', statusBox('error', t(R.authErrorKey(error))))
}

async function onAuthSubmit(e) {
  e.preventDefault()
  const email = $('authEmail').value.trim()
  const password = $('authPassword').value
  if (!email || !password) { setBox('authStatus', statusBox('error', t('auth.err_missing'))); return }
  const btn = $('authSubmit')
  const up = state.mode === 'signup'
  btn.disabled = true
  btn.textContent = t(up ? 'auth.creating' : 'auth.signing_in')
  setBox('authStatus', null)
  try {
    if (up) {
      const { data, error } = await signUp(state.sb, email, password)
      if (error) authError(error)
      else if (data && data.session) await enterApp(data.session)
      else setBox('authStatus', statusBox('ok', t('auth.signup_sent')))
    } else {
      const { data, error } = await state.sb.auth.signInWithPassword({ email, password })
      if (error || !data || !data.session) authError(error)
      else await enterApp(data.session)
    }
  } catch (err) {
    authError({ status: 0 })
  } finally {
    btn.disabled = false
    btn.textContent = t(up ? 'auth.create' : 'auth.submit')
  }
}

async function onForgot() {
  const email = $('authEmail').value.trim()
  if (!email) { setBox('authStatus', statusBox('warn', t('auth.forgot_need_email'))); $('authEmail').focus(); return }
  try {
    const { error } = await sendPasswordReset(state.sb, email)
    if (error) authError(error)
    else setBox('authStatus', statusBox('ok', t('auth.forgot_sent')))
  } catch (e) {
    authError({ status: 0 })
  }
}

async function setupGoogle() {
  const note = $('googleNote')
  const say = (key) => { note.textContent = t(key); note.setAttribute('data-i18n', key); note.hidden = false }
  const enabled = await googleEnabled()
  if (enabled === false) { say('auth.google_off'); return }
  if (enabled !== true) { say('auth.google_unknown'); return }
  if (!window.googleAuth || $('viewSignIn').hidden) return
  try {
    await loadGoogleIdentity()
    const mounted = await window.googleAuth.mount('googleGisButton', () => setBox('authStatus', statusBox('error', t('auth.google_refused'))))
    if (!mounted) { say('auth.google_blocked'); return }
    window.googleAuth.promptOneTap().catch(() => {})
  } catch (e) {
    say('auth.google_blocked')
  }
}

// ── L'appli ────────────────────────────────────────────────────────────────

// Une connexion déclenche deux appels (l'évènement SIGNED_IN du SDK, puis la
// fin du formulaire) : le second attend le chargement du premier, sans quoi
// il afficherait une liste « illisible » le temps qu'elle arrive.
let entering = null

async function enterApp(session) {
  if (state.user && state.user.id === session.user.id) {
    if (entering) await entering
    route()
    return
  }
  entering = loadApp(session)
  try { await entering } finally { entering = null }
}

async function loadApp(session) {
  state.user = { id: session.user.id, email: typeof session.user.email === 'string' ? session.user.email : '' }
  if (window.googleAuth) window.googleAuth.cancelOneTap()
  // La visite précédente fait les « Nouveau » de toute cette page ; celle-ci
  // est retenue tout de suite pour la suivante.
  const raw = storageGet(LAST_VISIT_KEY)
  state.lastVisit = R.readLastVisit(raw, state.user.id)
  storageSet(LAST_VISIT_KEY, R.nextLastVisit(raw, state.user.id, new Date().toISOString()))
  // La présentation mène désormais droit à l'appli (presentation.js).
  storageSet(APP_OPENED_KEY, '1')
  $('accountEmail').textContent = t('account.signed_in', { email: state.user.email })
  show('viewLoading')
  await Promise.all([loadSettings(), loadOffers()])
  if (state.settings === null && !/^#(reglages|offre-)/.test(location.hash)) {
    state.firstSettings = true
    history.replaceState(null, '', '#reglages')
  }
  route()
}

async function loadSettings() {
  try {
    const { data, error } = await state.sb.from('settings').select('keywords,locations,contract_types,updated_at').maybeSingle()
    if (error) throw error
    state.settings = R.readSettings(data)
    state.settingsError = false
  } catch (e) {
    state.settings = undefined
    state.settingsError = true
  }
}

async function loadOffers() {
  try {
    const { data, error } = await state.sb.from('offers')
      .select('id,data,first_seen,last_seen,gone_at,status,status_at,blocked')
      .eq('blocked', false)
      .order('first_seen', { ascending: false })
      .range(0, 1999)
    if (error) throw error
    state.offers = (Array.isArray(data) ? data : []).map(R.toOffer).filter(Boolean)
    state.offersError = false
  } catch (e) {
    // La liste déjà affichée reste ; une liste jamais lue reste null, et
    // l'écran dit qu'elle n'a pas pu l'être.
    state.offersError = true
  }
}

function route() {
  if (!state.user) { showSignIn(); return }
  const h = location.hash
  if (h === '#reglages') { renderSettings(); show('viewSettings'); return }
  const m = /^#offre-([0-9a-f]{32})$/.exec(h)
  if (m) { renderOffer(m[1]); show('viewOffer'); return }
  renderOffers()
  show('viewOffers')
}

// ── La liste ───────────────────────────────────────────────────────────────

function metaLine() {
  const s = state.settings
  if (!s) return t('offers.meta_none')
  const kw = s.keywords.join(' · ')
  const loc = s.locations.map((l) => `${l.city} (${t('settings.radius_km', { n: l.radius })})`).join(' · ')
  return [kw, loc].filter(Boolean).join('  |  ')
}

function sourceBadge(name) {
  return el('span', { class: 'badge src--' + R.sourceKey(name), text: name })
}

function offerBadges(o, withSources = true) {
  const b = []
  if (R.isAlternance(o)) b.push(el('span', { class: 'badge badge--alt', text: '★ ' + t('badge.alt') }))
  if (R.isNew(o, state.lastVisit)) b.push(el('span', { class: 'badge badge--new', text: t('badge.new') }))
  if (o.sources.length > 1) b.push(el('span', { class: 'badge badge--multi', text: '⇄ ' + t('badge.multi') }))
  if (o.goneAt) b.push(el('span', { class: 'badge badge--gone', text: '⌛ ' + t('badge.gone') }))
  if (o.linkDead) b.push(el('span', { class: 'badge badge--dead', text: '⛓ ' + t('badge.dead') }))
  if (withSources) for (const s of o.sources) b.push(sourceBadge(s))
  return el('div', { class: 'badges' }, b)
}

function metaRows(o, detail) {
  const rows = []
  const row = (icon, label, value) => el('div', { class: 'meta-row' }, el('span', { class: 'mi', 'aria-hidden': 'true', text: icon }), el('span', { class: 'visually-hidden', text: label + ' : ' }), el('span', { text: value }))
  if (o.company) rows.push(row('🏢', t('offer.company'), o.company))
  if (o.location) rows.push(row('📍', t('offer.location'), o.location))
  if (o.contract) rows.push(row('📄', t('offer.contract'), o.contract))
  if (o.date) rows.push(el('div', { class: 'meta-row' }, el('span', { class: 'mi', 'aria-hidden': 'true', text: '📅' }), el('span', { text: t('offer.published', { date: R.formatDay(o.date, lang()) }) })))
  if (detail && o.expires) rows.push(el('div', { class: 'meta-row' }, el('span', { class: 'mi', 'aria-hidden': 'true', text: '⏳' }), el('span', { text: t('offer.expires', { date: R.formatDay(o.expires, lang()) }) })))
  if (detail && o.goneAt) rows.push(el('div', { class: 'meta-row' }, el('span', { class: 'mi', 'aria-hidden': 'true', text: '⌛' }), el('span', { text: t('offer.gone', { date: R.formatDay(o.goneAt, lang()) }) })))
  return el('div', { class: detail ? 'op-meta' : 'meta-list' }, rows)
}

function statusSelect(o, id) {
  const sel = el('select', { class: 'status-select', id, 'data-status': o.status, 'aria-label': t('offer.status_label') + ' — ' + o.title })
  for (const s of R.STATUSES) sel.append(el('option', { value: s, text: t('status.' + s) }))
  sel.value = o.status
  sel.addEventListener('change', () => void saveStatus(o, sel))
  return sel
}

function card(o) {
  const classes = ['card']
  if (R.isNew(o, state.lastVisit)) classes.push('is-new')
  if (R.isAlternance(o)) classes.push('is-alt')
  if (o.goneAt) classes.push('is-gone')
  return el('article', { class: classes.join(' '), 'data-status': o.status, 'data-id': o.id },
    offerBadges(o),
    el('h3', null, el('a', { href: '#offre-' + o.id, text: o.title, 'aria-description': t('offer.open') })),
    metaRows(o, false),
    el('div', { class: 'status-row' },
      statusSelect(o, 'st-' + o.id),
      el('button', { type: 'button', class: 'block-btn', text: '🚫 ' + t('offer.block'), 'aria-label': t('offer.block') + ' — ' + o.title, onclick: () => void blockOffer(o) })))
}

function stat(n, label) {
  return el('div', { class: 'stat' }, el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: label }))
}

function chip(label, pressed, onclick, count) {
  return el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(pressed), onclick },
    label, count === undefined ? null : el('span', { class: 'chip-count', text: String(count) }))
}

function renderOffers() {
  $('offersMeta').textContent = metaLine()
  renderRefresh()
  renderSearchResult()
  const body = $('offersBody')
  body.replaceChildren()
  setBox('offersStatus', null)

  if (state.settingsError) {
    setBox('offersStatus', statusBox('error', t('offers.settings_error') + ' ', el('button', { type: 'button', class: 'btn btn--link', text: t('common.retry'), onclick: () => void reload() })))
  }
  if (state.offersError || state.offers === null) {
    $('offersStatus').append(statusBox('error', t('offers.load_error') + ' ', el('button', { type: 'button', class: 'btn btn--link', text: t('common.retry'), onclick: () => void reload() })))
    if (state.offers === null) return
  }
  if (state.settings === null) {
    body.append(el('div', { class: 'empty' },
      el('h2', { text: t('offers.need_settings_title') }),
      el('p', { text: t('offers.need_settings_text') }),
      el('a', { class: 'btn btn--primary', href: '#reglages', text: t('offers.go_settings') })))
    return
  }

  const all = state.offers
  const visible = all.filter((o) => !o.blocked)
  const counts = R.statusCounts(all)
  body.append(el('div', { class: 'stats' },
    stat(counts.all, t('offers.stat_total')),
    stat(visible.filter((o) => o.status !== 'ignore' && R.isNew(o, state.lastVisit)).length, t('offers.stat_new')),
    stat(visible.filter((o) => o.status !== 'ignore' && o.sources.length > 1).length, t('offers.stat_multi')),
    stat(visible.filter((o) => o.status && o.status !== 'ignore').length, t('offers.stat_followed'))))
  if (!state.lastVisit && visible.length) body.append(el('p', { class: 'muted', text: t('offers.last_visit_none') }))

  if (!visible.length) {
    body.append(el('div', { class: 'empty' },
      el('h2', { text: t('offers.empty_title') }),
      el('p', { text: t('offers.empty_text') })))
    return
  }

  // Les filtres : chaque choix a une coche et un fond, jamais la seule couleur.
  const f = state.filters
  const setF = (patch) => { Object.assign(state.filters, patch); renderOffers() }
  const statusRow = el('div', { class: 'filter-row', role: 'group', 'aria-label': t('offers.filter_status') },
    el('span', { class: 'filter-label', 'aria-hidden': 'true', text: t('offers.filter_status') }),
    chip(t('offers.all'), f.status === 'all', () => setF({ status: 'all' }), counts.all),
    R.STATUSES.filter((s) => s).map((s) => chip(t('status.' + s), f.status === s, () => setF({ status: s }), counts[s])))
  const present = R.SOURCES.filter((s) => visible.some((o) => o.sources.some((n) => R.sourceKey(n) === s.key)))
  const sourceRow = el('div', { class: 'filter-row', role: 'group', 'aria-label': t('offers.filter_source') },
    el('span', { class: 'filter-label', 'aria-hidden': 'true', text: t('offers.filter_source') }),
    chip(t('offers.all_sources'), f.source === 'all', () => setF({ source: 'all' })),
    present.map((s) => chip(s.name, f.source === s.key, () => setF({ source: s.key }))))
  const moreRow = el('div', { class: 'filter-row', role: 'group', 'aria-label': t('offers.filter_more') },
    el('span', { class: 'filter-label', 'aria-hidden': 'true', text: t('offers.filter_more') }),
    chip('★ ' + t('offers.only_alt'), f.alt, () => setF({ alt: !f.alt })),
    chip(t('offers.only_new'), f.onlyNew, () => setF({ onlyNew: !f.onlyNew })))
  body.append(el('div', { class: 'filters', role: 'region', 'aria-label': t('offers.filters') }, statusRow, sourceRow, moreRow))

  const filtered = R.sortOffers(R.filterOffers(all, { ...f, lastVisit: state.lastVisit }))
  const sec = R.splitSections(filtered, state.showAllGone)
  if (!filtered.length) {
    body.append(el('div', { class: 'empty' },
      el('p', { text: t('offers.empty_filtered') }),
      el('button', { type: 'button', class: 'btn btn--secondary', text: t('offers.reset_filters'), onclick: () => setF({ status: 'all', source: 'all', alt: false, onlyNew: false }) })))
    return
  }
  const section = (title, list) => el('section', { class: 'offers-section' }, el('h2', { text: title }), el('div', { class: 'grid' }, list.map(card)))
  if (sec.active.length) body.append(section(t('offers.section_active', { n: sec.active.length }), sec.active))
  if (sec.followed.length) body.append(section(t('offers.section_followed', { n: sec.followed.length }), sec.followed))
  if (sec.gone.length) body.append(section(t('offers.section_gone', { n: sec.gone.length }), sec.gone))
  const goneCount = sec.goneHidden || sec.gone.length
  if (goneCount) {
    body.append(el('p', { class: 'muted' },
      sec.goneHidden ? t('offers.gone_hidden', { n: sec.goneHidden }) + ' ' : '',
      el('button', { type: 'button', class: 'btn btn--link', text: t(state.showAllGone ? 'offers.gone_hide' : 'offers.gone_show'), onclick: () => { state.showAllGone = !state.showAllGone; renderOffers() } })))
  }
}

async function reload() {
  await Promise.all([loadSettings(), loadOffers()])
  route()
}

// ── Actualiser ─────────────────────────────────────────────────────────────

function renderRefresh() {
  const btn = $('refreshBtn')
  btn.disabled = state.searching
  btn.setAttribute('aria-busy', String(state.searching))
  $('refreshSpin').hidden = !state.searching
  $('refreshLabel').textContent = t(state.searching ? 'offers.refreshing' : 'offers.refresh')
}

function renderSearchResult() {
  const r = state.lastSearch
  if (state.searching) { setBox('searchStatus', statusBox(null, t('offers.refreshing_long'))); return }
  if (!r) { setBox('searchStatus', null); return }
  if (r.kind === 'error') {
    const key = 'search.' + r.code
    const text = r.code === 'failed' ? t('search.failed', { code: r.http ? 'HTTP ' + r.http : '—' }) : t(key)
    const extra = r.code === 'no_settings'
      ? el('a', { href: '#reglages', text: ' ' + t('offers.go_settings') })
      : r.code === 'not_authenticated' ? el('button', { type: 'button', class: 'btn btn--link', text: t('auth.submit'), onclick: () => void signOutHere(state.sb) }) : null
    setBox('searchStatus', statusBox(r.code === 'quota' ? 'warn' : 'error', text, extra ? ' ' : '', extra))
    return
  }
  const c = r.counts
  const issues = r.sources.filter((s) => s.outcome.kind !== 'count')
  const parts = [
    el('p', { class: 'm0', text: t('search.done', { kept: c.kept, new: c.new ?? 0 }) }),
    el('p', { class: 'm0', text: t('search.detail', { raw: c.raw ?? '—', duplicates: c.duplicates ?? '—', dead: c.dead_links ?? '—' }) }),
  ]
  if (issues.length) {
    parts.push(el('p', { class: 'm0', text: t('search.sources_issue') }))
    parts.push(el('ul', null, issues.map((s) => {
      const o = s.outcome
      const key = o.kind === 'not_configured' ? 'search.not_configured_src' : o.kind === 'skipped' ? 'search.skipped' : o.kind === 'timeout' ? 'search.timeout' : o.kind === 'http' ? 'search.http' : 'search.error'
      return el('li', { text: t(key, { name: s.name, code: o.code }) })
    })))
  } else if (r.sources.length) {
    parts.push(el('p', { class: 'm0', text: t('search.sources_ok') }))
  }
  if (r.reloadFailed) parts.push(el('p', { class: 'm0', text: t('search.reload_failed') }))
  setBox('searchStatus', statusBox(issues.length || r.reloadFailed ? 'warn' : 'ok', parts))
}

async function refresh() {
  if (state.searching) return
  state.searching = true
  state.lastSearch = null
  renderRefresh()
  renderSearchResult()
  let result
  try {
    const { data, error } = await state.sb.functions.invoke(SEARCH_FUNCTION, { body: {} })
    if (error) {
      // Une réponse non 2xx : on lit son corps, qui porte le code.
      let body = null
      let status = 0
      const res = error.context
      if (res && typeof res.status === 'number') {
        status = res.status
        try { body = await res.json() } catch (e) { body = null }
      }
      result = R.readSearchResult(body, status)
    } else {
      result = R.readSearchResult(data, 200)
    }
  } catch (e) {
    result = { kind: 'error', code: 'network' }
  }
  if (result.kind === 'ok') {
    await loadOffers()
    if (state.offersError) result.reloadFailed = true
  }
  state.searching = false
  state.lastSearch = result
  if (location.hash === '' || location.hash === '#offres') renderOffers()
  else renderRefresh()
  if (result.kind === 'ok') console.info('[jobbly] recherche : ok')
  else console.info('[jobbly] recherche : ' + result.code)
}

// ── Statut, fausse offre, ignorer ──────────────────────────────────────────

async function saveStatus(o, sel) {
  const before = o.status
  const next = R.STATUSES.includes(sel.value) ? sel.value : ''
  sel.disabled = true
  sel.setAttribute('data-status', next)
  const statusAt = next ? new Date().toISOString() : null
  const { error } = await state.sb.from('offers').update({ status: next, status_at: statusAt }).eq('id', o.id).then((r) => r, () => ({ error: true }))
  sel.disabled = false
  if (error) {
    sel.value = before
    sel.setAttribute('data-status', before)
    toast(t('offer.save_error'))
    return
  }
  o.status = next
  o.statusAt = statusAt
  toast(t('offer.saved', { status: t('status.' + next) }))
  const c = sel.closest('.card')
  if (c) c.setAttribute('data-status', next)
}

async function blockOffer(o) {
  if (!(await confirmBox(t('offer.block_title'), t('offer.block_text'), t('offer.block_confirm')))) return
  const { error } = await state.sb.from('offers').update({ blocked: true }).eq('id', o.id).then((r) => r, () => ({ error: true }))
  if (error) { toast(t('offer.block_error')); return }
  o.blocked = true
  toast(t('offer.blocked'))
  if (location.hash.startsWith('#offre-')) history.back()
  else renderOffers()
}

async function ignoreOffer(o) {
  if (!(await confirmBox(t('offer.ignore_title'), t('offer.ignore_text'), t('offer.ignore_confirm')))) return
  const at = new Date().toISOString()
  const { error } = await state.sb.from('offers').update({ status: 'ignore', status_at: at }).eq('id', o.id).then((r) => r, () => ({ error: true }))
  if (error) { toast(t('offer.save_error')); return }
  o.status = 'ignore'
  o.statusAt = at
  toast(t('offer.ignored'))
  location.hash = '#offres'
}

// ── Le détail ──────────────────────────────────────────────────────────────

function renderOffer(id) {
  const box = $('viewOffer')
  box.replaceChildren()
  const back = el('a', { class: 'btn btn--secondary', href: '#offres', text: t('offer.back') })
  const o = (state.offers || []).find((x) => x.id === id && !x.blocked)
  if (!o) {
    box.append(el('div', { class: 'op-head' }, back), statusBox('warn', t('offer.not_found')))
    return
  }
  const links = []
  if (o.linkDead) links.push(statusBox('warn', t('offer.dead')))
  else if (!o.url) links.push(statusBox('warn', t('offer.no_link')))
  else {
    const main = o.links[0]
    links.push(el('a', { class: 'btn btn--primary', href: main.url, target: '_blank', rel: 'noopener noreferrer', text: '🔗 ' + t('offer.see', { source: main.source || R.domainOf(main.url) }) }))
    if (o.links.length > 1) {
      links.push(el('div', { class: 'also' }, el('span', { text: t('offer.also') }),
        o.links.slice(1).map((l) => el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', text: l.source || R.domainOf(l.url) }))))
    }
  }
  box.append(
    el('div', { class: 'op-head' }, back, offerBadges(o)),
    el('h1', { class: 'op-title', text: o.title }),
    metaRows(o, true),
    el('div', { class: 'op-links' }, links),
    o.summary ? el('div', { class: 'op-desc', text: o.summary }) : el('p', { class: 'muted', text: t('offer.no_desc') }),
    el('div', { class: 'op-actions' },
      el('label', { class: 'visually-hidden', for: 'opStatus', text: t('offer.status_label') }),
      statusSelect(o, 'opStatus'),
      el('button', { type: 'button', class: 'block-btn', text: '🚫 ' + t('offer.block'), 'aria-label': t('offer.block') + ' — ' + o.title, onclick: () => void blockOffer(o) }),
      el('button', { type: 'button', class: 'btn btn--danger', text: '🗑 ' + t('offer.ignore_delete'), onclick: () => void ignoreOffer(o) })))
  window.scrollTo(0, 0)
}

// ── Réglages ───────────────────────────────────────────────────────────────

function draftFromSettings() {
  const s = state.settings
  return s ? { keywords: s.keywords.slice(), locations: s.locations.map((l) => ({ ...l })), contractTypes: s.contractTypes.slice() }
    : { keywords: [], locations: [], contractTypes: [] }
}

function markDirty() {
  state.dirty = true
  $('settingsDirty').hidden = false
  setBox('settingsStatus', null)
}

function renderSettings() {
  if (!state.draft || !state.dirty) state.draft = draftFromSettings()
  setBox('settingsIntro', state.firstSettings && state.settings === null ? statusBox(null, t('settings.first')) : null)
  setBox('settingsLoadStatus', state.settingsError
    ? statusBox('error', t('offers.settings_error') + ' ', el('button', { type: 'button', class: 'btn btn--link', text: t('common.retry'), onclick: () => void reload() }))
    : null)
  $('settingsSave').disabled = state.settingsError
  renderKeywords()
  renderLocations()
  renderContracts()
  $('settingsDirty').hidden = !state.dirty
}

function renderKeywords() {
  const list = $('keywordList')
  list.replaceChildren()
  if (!state.draft.keywords.length) list.append(el('li', { class: 'muted', text: t('settings.keywords_empty') }))
  state.draft.keywords.forEach((k, i) => {
    list.append(el('li', { class: 'chip' }, el('span', { text: k }),
      el('button', { type: 'button', class: 'chip-del', 'aria-label': t('settings.remove', { name: k }), text: '×', onclick: () => { state.draft.keywords.splice(i, 1); markDirty(); renderKeywords() } })))
  })
}

function onAddKeyword() {
  const input = $('keywordInput')
  const r = R.addKeyword(state.draft.keywords, input.value)
  if (r.error) { setBox('keywordStatus', statusBox('error', t('settings.err.' + r.error))); return }
  state.draft.keywords = r.keywords
  input.value = ''
  setBox('keywordStatus', null)
  markDirty()
  renderKeywords()
}

function renderLocations() {
  const box = $('locationList')
  box.replaceChildren()
  if (!state.draft.locations.length) box.append(el('p', { class: 'muted', text: t('settings.cities_empty') }))
  state.draft.locations.forEach((l, i) => {
    const sel = el('select', { 'aria-label': t('settings.radius') + ' — ' + l.city })
    const radii = R.RADII.includes(l.radius) ? R.RADII : [...R.RADII, l.radius].sort((a, b) => a - b)
    for (const r of radii) sel.append(el('option', { value: String(r), text: t('settings.radius_km', { n: r }) }))
    sel.value = String(l.radius)
    sel.addEventListener('change', () => { l.radius = Number(sel.value); markDirty() })
    const incomplete = R.isIncompleteLocation(l)
    box.append(el('div', { class: 'loc-item' + (incomplete ? ' is-incomplete' : '') },
      el('div', { class: 'loc-city' }, l.city, el('small', { text: incomplete ? t('settings.incomplete_short') : 'INSEE ' + l.insee })),
      el('label', { class: 'loc-radius' }, el('span', { class: 'visually-hidden', text: t('settings.radius') }), sel),
      el('button', { type: 'button', class: 'chip-del', 'aria-label': t('settings.remove', { name: l.city }), text: '×', onclick: () => { state.draft.locations.splice(i, 1); markDirty(); renderLocations() } })))
  })
  if (state.draft.locations.some(R.isIncompleteLocation)) box.append(statusBox('warn', t('settings.incomplete')))
}

function addLocation(loc) {
  const r = R.addLocation(state.draft.locations, loc)
  if (r.error) { setBox('cityResults', statusBox('error', t('settings.err.' + r.error))); return }
  state.draft.locations = r.locations
  $('cityInput').value = ''
  setBox('cityResults', null)
  markDirty()
  renderLocations()
}

let citySeq = 0
let cityTimer = null

async function searchCity(immediate) {
  const name = R.str($('cityInput').value, 80)
  clearTimeout(cityTimer)
  if (name.length < 2) { setBox('cityResults', null); return }
  if (!immediate) { cityTimer = setTimeout(() => void searchCity(true), 350); return }
  const seq = ++citySeq
  setBox('cityResults', el('p', { class: 'muted', text: t('settings.city_searching') }))
  let communes = null
  try {
    const url = 'https://geo.api.gouv.fr/communes?nom=' + encodeURIComponent(name) + '&fields=nom,code,codeDepartement,centre&boost=population&limit=6'
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error('geo_' + res.status)
    communes = R.readCommunes(await res.json())
  } catch (e) {
    communes = null
  }
  if (seq !== citySeq) return
  if (communes === null) {
    setBox('cityResults', statusBox('error', t('settings.city_error'), ' ',
      el('button', { type: 'button', class: 'btn btn--link', text: t('common.retry'), onclick: () => void searchCity(true) }),
      el('button', { type: 'button', class: 'btn btn--link', text: t('settings.city_add_raw', { name }), onclick: () => addLocation({ city: name, radius: 30 }) })))
    return
  }
  if (!communes.length) { setBox('cityResults', statusBox('warn', t('settings.city_none'))); return }
  setBox('cityResults', el('ul', { class: 'suggest' }, communes.map((c) => el('li', null,
    el('button', { type: 'button', onclick: () => addLocation({ city: c.city, radius: 30, insee: c.insee, lat: c.lat, lon: c.lon }) },
      c.city + ' ', el('small', { text: (c.dept ? t('settings.city_dept', { dept: c.dept }) + ' · ' : '') + 'INSEE ' + c.insee }))))))
}

function renderContracts() {
  const box = $('contractList')
  box.replaceChildren()
  for (const code of R.CONTRACT_TYPES) {
    const input = el('input', { type: 'checkbox', value: code })
    input.checked = state.draft.contractTypes.includes(code)
    input.addEventListener('change', () => {
      const set = new Set(state.draft.contractTypes)
      if (input.checked) set.add(code); else set.delete(code)
      state.draft.contractTypes = R.CONTRACT_TYPES.filter((c) => set.has(c))
      markDirty()
    })
    box.append(el('label', { class: 'check' }, input, el('span', { text: t('contract.' + code) + (t('contract.' + code).includes(code) ? '' : ' (' + code + ')') })))
  }
}

async function onSaveSettings(e) {
  e.preventDefault()
  const errors = R.settingsErrors(state.draft)
  if (errors.length) {
    setBox('settingsStatus', statusBox('error', el('ul', null, errors.map((k) => el('li', { text: t('settings.err.' + k) })))))
    return
  }
  const btn = $('settingsSave')
  btn.disabled = true
  btn.textContent = t('settings.saving')
  let ok = false
  try {
    const { error } = await state.sb.from('settings').upsert(R.settingsRow(state.user.id, state.draft), { onConflict: 'user_id' })
    ok = !error
  } catch (err) {
    ok = false
  }
  btn.disabled = false
  btn.textContent = t('settings.save')
  if (!ok) { setBox('settingsStatus', statusBox('error', t('settings.save_error'))); return }
  state.settings = R.readSettings(R.settingsRow(state.user.id, state.draft))
  state.settingsError = false
  state.dirty = false
  state.firstSettings = false
  $('settingsDirty').hidden = true
  setBox('settingsIntro', null)
  setBox('settingsStatus', statusBox('ok', t('settings.saved'), ' ',
    el('button', { type: 'button', class: 'btn btn--link', text: t('settings.saved_search'), onclick: () => { location.hash = '#offres'; void refresh() } })))
}

// ── Compte ─────────────────────────────────────────────────────────────────

async function onDeleteData() {
  if (!(await confirmBox(t('data.delete'), t('data.delete_text'), t('data.delete_confirm')))) return
  setBox('deleteStatus', null)
  let res
  try {
    res = await state.sb.rpc('delete_my_data')
  } catch (e) {
    res = { error: true }
  }
  if (res.error || typeof res.data !== 'boolean') { setBox('deleteStatus', statusBox('error', t('data.delete_error'))); return }
  $('deletedText').textContent = t(res.data ? 'data.deleted_account' : 'data.deleted')
  $('deletedText').setAttribute('data-i18n', res.data ? 'data.deleted_account' : 'data.deleted')
  try { await signOutHere(state.sb) } catch (e) { /* la session locale part quand même */ }
  state.user = null
  state.offers = null
  state.settings = undefined
  show('viewDeleted')
}

// ── Câblage ────────────────────────────────────────────────────────────────

function wire() {
  $('tabSignIn').addEventListener('click', () => setMode('signin'))
  $('tabSignUp').addEventListener('click', () => setMode('signup'))
  $('authForm').addEventListener('submit', onAuthSubmit)
  $('forgotBtn').addEventListener('click', () => void onForgot())
  $('refreshBtn').addEventListener('click', () => void refresh())
  $('settingsForm').addEventListener('submit', onSaveSettings)
  $('keywordAdd').addEventListener('click', onAddKeyword)
  $('keywordInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onAddKeyword() } })
  $('citySearch').addEventListener('click', () => void searchCity(true))
  $('cityInput').addEventListener('input', () => void searchCity(false))
  $('cityInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void searchCity(true) } })
  $('signOutBtn').addEventListener('click', async () => {
    try { await signOutHere(state.sb) } catch (e) { /* la session locale part quand même */ }
    state.user = null
    state.offers = null
    state.settings = undefined
    history.replaceState(null, '', location.pathname)
    showSignIn()
  })
  $('deleteDataBtn').addEventListener('click', () => void onDeleteData())
  $('deletedBack').addEventListener('click', () => { history.replaceState(null, '', location.pathname); showSignIn() })
  window.addEventListener('hashchange', () => { if (state.user) route() })
  document.addEventListener('jobbly:lang', () => {
    applyI18n()
    if (!$('authSubmit').disabled) $('authSubmit').textContent = t(state.mode === 'signup' ? 'auth.create' : 'auth.submit')
    if (state.user) {
      $('accountEmail').textContent = t('account.signed_in', { email: state.user.email })
      if (!$('viewDeleted').hidden) return
      route()
    }
  })
}

wire()
void start()
