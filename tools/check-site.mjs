#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// tools/check-site.mjs — le site dans Chromium, sous la VRAIE CSP
// ────────────────────────────────────────────────────────────────────────────
// Un serveur statique minuscule sert le dépôt comme Apache le ferait avec
// .htaccess : la CSP et la COOP relues dans .htaccess (pas recopiées : une
// copie divergerait au premier correctif), celles de l'appli pour
// offres.html, `DirectoryIndex index.html`, le renvoi d'un `?code=` arrivé à
// `/`, et le refus des fichiers internes. Puis Playwright ouvre chaque page à
// 390 et 1280 px, en clair et en sombre, en français et en anglais, et
// ÉCHOUE sur :
//   · une violation de CSP (securitypolicyviolation, ou message de console) ;
//   · une erreur JavaScript, une requête refusée par le contrôle SRI ;
//   · un défilement horizontal ;
//   · un parcours qui ne dit pas ce qu'il doit dire.
//
// Rien ne part sur le réseau. Le projet Supabase (auth, schéma jobbly,
// fonction jobbly-search), l'API Géo et Google sont IMITÉS (page.route) ; le
// SDK Supabase est le vrai fichier de jsdelivr, servi depuis le disque, et
// son empreinte SRI est vérifiée par le navigateur comme en production. Les
// données sont celles de tools/demo-data.mjs, inventées.
//
// Les parcours joués : connexion (mot de passe faux, puis juste), inscription,
// mot de passe oublié, « Continuer avec Google » (nonce haché vers Google,
// brut vers Supabase) ; la liste, ses filtres et le détail ; un statut
// enregistré (seuls `status` et `status_at` partent), un statut refusé par le
// serveur (l'écran revient en arrière et le dit) ; « Fausse offre » ;
// « Ignorer et supprimer » ; « Actualiser » (bouton désactivé pendant
// l'appel, compteurs et sources en erreur dits ensuite ; quota ; erreur du
// service ; réglages absents ; plafond de stockage) ; une liste illisible
// (jamais une liste vide muette) ; un compte sans réglages, mené aux
// réglages, qui ajoute un mot-clé et une commune (API Géo imitée, puis en
// panne) et enregistre ; « Supprimer mes données Jobbly » ; la présentation
// qui renvoie un retour d'autorisation à l'appli, puis mène à l'appli qui a
// déjà été ouverte. S'y ajoutent les contrastes des deux palettes
// (jobbly.css) et, si Account-LordEris est cloné à côté, la comparaison des
// copies telles quelles du kit.
//
// Mode d'emploi (Playwright installé hors du dépôt, Chromium présent) :
//
//   curl -sSo /tmp/supabase.js https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2/dist/umd/supabase.js
//   NODE_PATH=$(npm root -g) SUPABASE_UMD=/tmp/supabase.js node tools/check-site.mjs [dossier-des-captures]
//
// Avec `--apercu`, il refait aussi les captures de la présentation
// (assets/apercu/<écran>-<fr|en>-<light|dark>.webp, 585 px de large) :
//
//   NODE_PATH=$(npm root -g) SUPABASE_UMD=/tmp/supabase.js node tools/check-site.mjs --apercu
//
// ONLY=<motif> ne joue que les scénarios dont le nom correspond (mise au
// point) ; la vérification avant de livrer les joue tous.
// ────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as DEMO from './demo-data.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const APERCU = args.includes('--apercu')
const shotsDir = args.find((a) => !a.startsWith('--')) || null
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null
const sdkPath = process.env.SUPABASE_UMD
if (!sdkPath || !fs.existsSync(sdkPath)) {
  console.error('ÉCHEC : SUPABASE_UMD doit désigner le fichier supabase.js de jsdelivr (voir l\'en-tête).')
  process.exit(1)
}

const failures = []
const fail = (scope, msg) => { failures.push(`${scope} : ${msg}`); console.log(`  ✗ ${scope} : ${msg}`) }
const ok = (scope, msg) => console.log(`  ✓ ${scope}${msg ? ' : ' + msg : ''}`)

// ── Les en-têtes, lus dans .htaccess ───────────────────────────────────────
const htaccess = fs.readFileSync(path.join(root, '.htaccess'), 'utf8')
const local = (csp) => csp.replace(/;\s*upgrade-insecure-requests/, '')
const appBlock = htaccess.match(/<FilesMatch "\^offres\\\.html\$">([\s\S]*?)<\/FilesMatch>/)
if (!appBlock) { console.error('ÉCHEC : bloc <FilesMatch> d\'offres.html introuvable dans .htaccess'); process.exit(1) }
const outside = htaccess.replace(appBlock[0], '')
const BASE = {
  csp: local(outside.match(/Header always set Content-Security-Policy "([^"]+)"/)[1]),
  coop: outside.match(/Header always set Cross-Origin-Opener-Policy "([^"]+)"/)[1],
}
const APP = {
  csp: local(appBlock[1].match(/Header always set Content-Security-Policy "([^"]+)"/)[1]),
  coop: appBlock[1].match(/Header always set Cross-Origin-Opener-Policy "([^"]+)"/)[1],
}

// ── Le serveur : ce que fait Apache avec .htaccess ─────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' }
const DENIED = /(^|\/)\.|^\/(supabase|docs|tools|private|node_modules)(\/|$)|\.(md|sh|sql|toml|env|jsx|ts|mjs|py|ps1|bat|cmd|bak|log)$|^\/(requirements\.txt|config\.exemple\.json|LICENSE)$/
const RETURN = /(^|&)(code|error|error_code|error_description|access_token|refresh_token|provider_token|id_token|token_hash)=/i
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let file = decodeURIComponent(url.pathname)
  if (file === '/' && RETURN.test(url.search.slice(1))) {
    res.writeHead(302, { Location: '/offres.html' + url.search }); res.end(); return
  }
  if (DENIED.test(file)) { res.writeHead(403); res.end(); return }
  if (file.endsWith('/')) file += 'index.html'
  const full = path.join(root, file)
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return }
  const app = path.basename(full) === 'offres.html'
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
    'Content-Security-Policy': app ? APP.csp : BASE.csp,
    'Cross-Origin-Opener-Policy': app ? APP.coop : BASE.coop,
    'X-Content-Type-Options': 'nosniff',
  })
  fs.createReadStream(full).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ── Le projet Supabase, imité ──────────────────────────────────────────────
const SB = 'https://imbfggbrkpzbqcouxseo.supabase.co'
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const jwt = (uid) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: uid, role: 'authenticated', exp: 4102444800 }) + '.c2lnbmF0dXJl'
const userOf = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, identities: [{ id: '1' }], created_at: '2026-10-01T00:00:00Z' })
const sessionOf = (u) => ({ access_token: jwt(u.id), refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: userOf(u) })
const clone = (o) => JSON.parse(JSON.stringify(o))

/**
 * Imite le projet pour une page. `opt` règle les cas : settings (null =
 * aucun réglage), search ('ok' | 'quota' | 'error' | 'no_settings' |
 * 'storage_limit'), offersFail, patchFailId, google (true/false).
 */
async function mockProject(page, opt = {}) {
  const st = {
    settings: opt.settings === null ? null : clone(opt.settings || DEMO.SETTINGS),
    offers: clone(DEMO.OFFERS),
    patches: [], upserts: [], idTokens: [], searches: 0, geo: [], deleted: false,
  }
  page.__st = st
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: fs.readFileSync(sdkPath) }))
  await page.route(SB + '/**', async (route) => {
    const req = route.request()
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const json = (body, status = 200) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) })
    const u = new URL(req.url())
    const p = u.pathname
    const body = () => { try { return JSON.parse(req.postData() || '{}') } catch (e) { return {} } }
    if (p === '/auth/v1/settings') return json({ external: { google: opt.google !== false, email: true }, disable_signup: false })
    if (p === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const b = body()
      if (b.password !== 'bon-mot-de-passe') return json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
      return json(sessionOf(DEMO.USER))
    }
    if (p === '/auth/v1/token' && u.searchParams.get('grant_type') === 'id_token') {
      st.idTokens.push(body())
      return json(sessionOf(DEMO.USER))
    }
    if (p === '/auth/v1/signup') return json(userOf({ id: 'b2b2b2b2-0000-4000-8000-000000000002', email: body().email }))
    if (p === '/auth/v1/recover') return json({})
    if (p === '/auth/v1/user') return json(userOf(DEMO.USER))
    if (p === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors })
    // Le schéma jobbly, et lui seul.
    if (p.startsWith('/rest/v1/')) {
      const profile = req.headers()['accept-profile'] || req.headers()['content-profile']
      if (profile !== 'jobbly') return json({ message: 'schéma attendu : jobbly, reçu : ' + profile }, 400)
    }
    if (p === '/rest/v1/settings' && req.method() === 'GET') {
      const rows = st.settings ? [st.settings] : []
      if ((req.headers().accept || '').includes('vnd.pgrst.object')) return st.settings ? json(st.settings) : json({ code: 'PGRST116', message: 'no rows' }, 406)
      return json(rows)
    }
    if (p === '/rest/v1/settings' && req.method() === 'POST') {
      const b = body()
      st.upserts.push({ body: b, query: u.search })
      st.settings = { ...b, updated_at: new Date().toISOString() }
      return route.fulfill({ status: 201, headers: cors })
    }
    if (p === '/rest/v1/offers' && req.method() === 'GET') {
      if (opt.offersFail) return json({ message: 'simulé : indisponible' }, 500)
      return json(st.offers.filter((o) => !o.blocked))
    }
    if (p === '/rest/v1/offers' && req.method() === 'PATCH') {
      const id = (u.searchParams.get('id') || '').replace(/^eq\./, '')
      const b = body()
      st.patches.push({ id, body: b })
      if (id === opt.patchFailId) return json({ message: 'simulé : refus' }, 500)
      const o = st.offers.find((x) => x.id === id)
      if (o) Object.assign(o, b)
      return route.fulfill({ status: 204, headers: cors })
    }
    if (p === '/rest/v1/rpc/delete_my_data') { st.deleted = true; return json(false) }
    if (p === '/functions/v1/jobbly-search') {
      st.searches += 1
      st.searchAuth = req.headers().authorization || ''
      await new Promise((r) => setTimeout(r, 700))
      const mode = opt.search || 'ok'
      if (mode === 'ok') { st.offers.push(...clone(DEMO.NEW_OFFERS)); return json(DEMO.SEARCH_OK) }
      // Les codes de supabase/functions/README.md : en HTTP 200 pour
      // no_settings, quota et storage_limit ; en erreur pour les autres.
      if (['quota', 'no_settings', 'storage_limit'].includes(mode)) return json({ ok: false, code: mode })
      if (mode === 'not_authenticated') return json({ ok: false, code: mode }, 401)
      if (mode === 'not_configured') return json({ ok: false, code: mode }, 503)
      if (mode === 'save_failed') return json({ ok: false, code: mode }, 500)
      if (mode === 'bad_response') return route.fulfill({ status: 200, headers: cors, contentType: 'text/plain', body: 'pas du JSON' })
      return route.fulfill({ status: 500, headers: cors, contentType: 'text/plain', body: 'Internal Server Error' })
    }
    return json({ message: 'non simulé : ' + req.method() + ' ' + p }, 501)
  })
  // L'API Géo : « orl » trouve deux communes ; un nom qui contient « panne »
  // simule le service en panne.
  await page.route('https://geo.api.gouv.fr/**', (route) => {
    const u = new URL(route.request().url())
    st.geo.push(u.search)
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if ((u.searchParams.get('nom') || '').includes('panne')) return route.fulfill({ status: 503, headers: cors, body: '' })
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(DEMO.COMMUNES) })
  })
  await mockGoogle(page)
}

// ── Google, imité : ce que fait son script dans la page ────────────────────
const GSI = 'https://accounts.google.com/gsi/'
const FAKE_GSI = `(function () {
  var st = window.__gis = { cfg: null, renders: 0 }
  window.google = { accounts: { id: {
    initialize: function (cfg) {
      st.cfg = cfg
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${GSI}style'; document.head.appendChild(l)
    },
    renderButton: function (el, o) {
      st.renders++
      var w = Math.max(200, Math.min(400, o.width || 400))
      el.innerHTML = '<div style="position: relative;"><iframe title="Google" style="display: block; border: 0; width: ' + w + 'px; height: 44px;"></iframe></div>'
      el.querySelector('iframe').src = '${GSI}button?theme=' + o.theme + '&hl=' + o.locale
    },
    prompt: function () { fetch('${GSI}status').catch(function () {}) },
    cancel: function () {},
  } } }
})()`
function fakeButtonPage(url) {
  const u = new URL(url)
  const dark = u.searchParams.get('theme') === 'filled_black'
  const text = u.searchParams.get('hl') === 'en' ? 'Continue with Google' : 'Continuer avec Google'
  const [bg, fg, rule] = dark ? ['#131314', '#e3e3e3', '#8e918f'] : ['#ffffff', '#1f1f1f', '#747775']
  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>html,body{margin:0;background:transparent}div{box-sizing:border-box;height:40px;margin:2px 0;border:1px solid ${rule};border-radius:20px;background:${bg};color:${fg};display:flex;align-items:center;justify-content:center;font:500 14px/1 Arial,sans-serif}</style><div>G&nbsp;&nbsp;${text}</div>`
}
async function mockGoogle(page) {
  await page.route('https://accounts.google.com/**', (route) => {
    const url = route.request().url()
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if (url.startsWith(GSI + 'client')) return route.fulfill({ status: 200, contentType: 'text/javascript', headers: cors, body: FAKE_GSI })
    if (url.startsWith(GSI + 'style')) return route.fulfill({ status: 200, contentType: 'text/css', headers: cors, body: '#credential_picker_container{position:fixed}' })
    if (url.startsWith(GSI + 'button')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakeButtonPage(url) })
    if (url.startsWith(GSI + 'status')) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{}' })
    return route.fulfill({ status: 404, headers: cors, body: '' })
  })
}

// ── Une page surveillée ────────────────────────────────────────────────────
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {})

async function withPage(name, setup, fn) {
  if (ONLY && !ONLY.test(name)) return
  console.log(`· ${name}`)
  const page = await openPageWith(setup)
  try {
    await fn(page)
  } catch (e) {
    fail(name, 'exception : ' + e.message.split('\n')[0])
  }
  await audit(name, page)
  await page.context().close()
}

async function openPageWith(setup = {}) {
  const ctx = await browser.newContext({
    viewport: { width: setup.width || 390, height: (setup.width || 390) < 600 ? 844 : 900 },
    colorScheme: setup.theme || 'light',
    locale: setup.lang === 'en' ? 'en-GB' : 'fr-FR',
    deviceScaleFactor: setup.scale || 1,
  })
  const page = await ctx.newPage()
  page.__problems = []
  const prefs = JSON.stringify({ theme: setup.theme || 'light', language: setup.lang || 'fr' })
  const visit = setup.lastVisit === false ? null : JSON.stringify({ [DEMO.USER.id]: new Date(Date.UTC(2026, 10, 21, 18, 0)).toISOString() })
  await page.addInitScript(([prefs, visit, storage]) => {
    try {
      if (!sessionStorage.getItem('__init')) {
        sessionStorage.setItem('__init', '1')
        localStorage.setItem('jobbly:prefs', prefs)
        if (visit) localStorage.setItem('jobbly:last-visit', visit)
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v)
      }
    } catch (e) { /* rien */ }
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI))
  }, [prefs, visit, setup.storage || {}])
  page.on('pageerror', (e) => page.__problems.push('erreur JS : ' + e.message))
  page.on('console', (m) => {
    const t = m.text()
    if (/Content Security Policy|Refused to|integrity/i.test(t)) page.__problems.push('console : ' + t)
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) page.__problems.push('console.error : ' + t)
  })
  await mockProject(page, setup.project || {})
  return page
}

/** Après chaque scénario : CSP, erreurs JS, défilement horizontal. */
async function audit(name, page) {
  let csp = []
  let overflow = 0
  try {
    csp = await page.evaluate(() => window.__csp || [])
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  } catch (e) { /* page fermée */ }
  for (const v of csp) fail(name, 'violation de CSP : ' + v)
  for (const p of page.__problems) {
    // Les réponses d'erreur simulées (500, 503…) laissent une ligne
    // « Failed to load resource », écartée plus haut ; tout le reste compte.
    fail(name, p)
  }
  if (overflow > 1) fail(name, `défilement horizontal de ${overflow} px`)
}

async function shot(page, file) {
  if (!shotsDir) return
  await page.screenshot({ path: path.join(shotsDir, file), fullPage: false })
}

async function signIn(page, password = 'bon-mot-de-passe') {
  await page.goto(base + '/offres.html')
  await page.waitForSelector('#viewSignIn:not([hidden])')
  await page.fill('#authEmail', DEMO.USER.email)
  await page.fill('#authPassword', password)
  await page.click('#authSubmit')
}

const visibleText = (page, sel) => page.locator(sel).innerText()
async function expectText(name, page, sel, re, label) {
  try {
    await page.waitForFunction(([sel, src, flags]) => {
      const el = document.querySelector(sel)
      return el && new RegExp(src, flags).test(el.innerText)
    }, [sel, re.source, re.flags], { timeout: 6000 })
    ok(name, label)
  } catch (e) {
    let got = ''
    try { got = (await visibleText(page, sel)).slice(0, 200) } catch (err) { got = '(absent)' }
    fail(name, `${label} — attendu ${re} dans ${sel}, lu « ${got} »`)
  }
}

// ═══ 1. Chaque page, chaque format, chaque thème, chaque langue ═══════════
for (const width of [390, 1280]) {
  for (const theme of ['light', 'dark']) {
    for (const lang of ['fr', 'en']) {
      const tag = `${width}-${theme}-${lang}`
      await withPage(`présentation ${tag}`, { width, theme, lang }, async (page) => {
        await page.goto(base + '/?presentation')
        await page.waitForSelector('.lorderis-toggles:not([hidden])')
        const h1 = await page.locator(`[data-lang-block="${lang}"] h1`).first().isVisible()
        if (!h1) fail(`présentation ${tag}`, 'le bloc de la langue n\'est pas visible')
        const other = await page.locator(`[data-lang-block="${lang === 'fr' ? 'en' : 'fr'}"] h1`).first().isVisible()
        if (other) fail(`présentation ${tag}`, 'le bloc de l\'autre langue est visible')
        const t = await page.getAttribute('html', 'data-theme')
        if (t !== theme) fail(`présentation ${tag}`, `data-theme = ${t}`)
        // Chaque capture citée existe (une image cassée se verrait à peine).
        const broken = await page.evaluate(async () => {
          const out = []
          for (const img of document.querySelectorAll('img')) {
            const r = await fetch(img.getAttribute('src'), { method: 'GET' })
            if (!r.ok) out.push(img.getAttribute('src'))
          }
          return out
        })
        for (const b of broken) fail(`présentation ${tag}`, 'image absente : ' + b)
        await shot(page, `presentation-${tag}.png`)
      })
      await withPage(`politique ${tag}`, { width, theme, lang }, async (page) => {
        await page.goto(base + '/confidentialite.html')
        await page.waitForSelector('.lorderis-toggles:not([hidden])')
        const n = await page.locator(`[data-lang-block="${lang}"] .legal-body > section`).count()
        if (n !== 15) fail(`politique ${tag}`, `${n} sections au lieu de 15`)
        await shot(page, `confidentialite-${tag}.png`)
      })
      await withPage(`appli ${tag}`, { width, theme, lang }, async (page) => {
        const name = `appli ${tag}`
        await page.goto(base + '/offres.html')
        await page.waitForSelector('#viewSignIn:not([hidden])')
        await page.waitForSelector('#googleGis:not([hidden]) iframe', { timeout: 6000 }).then(() => ok(name, 'bouton Google monté'), () => fail(name, 'bouton Google non monté'))
        await shot(page, `connexion-${tag}.png`)
        await signIn(page)
        await page.waitForSelector('#viewOffers:not([hidden]) .card')
        await expectText(name, page, '#offersTitle', lang === 'en' ? /My offers/ : /Mes offres/, 'titre de la liste dans la langue')
        await shot(page, `offres-${tag}.png`)
        await page.click(`.card[data-id="${DEMO.OFFERS[0].id}"] h3 a`)
        await page.waitForSelector('#viewOffer:not([hidden]) .op-title')
        await shot(page, `detail-${tag}.png`)
        await page.click('#navSettings')
        await page.waitForSelector('#viewSettings:not([hidden]) .chip')
        await shot(page, `reglages-${tag}.png`)
      })
    }
  }
}

// ═══ 2. Les parcours ═══════════════════════════════════════════════════════
await withPage('connexion : mot de passe faux, inscription, oubli', {}, async (page) => {
  const n = 'connexion'
  await signIn(page, 'faux')
  await expectText(n, page, '#authStatus', /Adresse e-mail ou mot de passe incorrect/, 'mot de passe faux dit')
  await page.click('#forgotBtn')
  await expectText(n, page, '#authStatus', /un e-mail vient de partir/, 'mot de passe oublié envoyé')
  await page.fill('#authEmail', '')
  await page.click('#forgotBtn')
  await expectText(n, page, '#authStatus', /Saisis ton adresse e-mail/, 'oubli sans adresse dit')
  await page.click('#tabSignUp')
  if (!(await page.isVisible('#signUpNote'))) fail(n, 'le texte du kit de l\'inscription manque')
  await page.fill('#authEmail', 'nouveau@exemple.fr')
  await page.fill('#authPassword', 'Un-mot-de-passe-1!')
  await page.click('#authSubmit')
  await expectText(n, page, '#authStatus', /Compte créé : ouvre le lien/, 'inscription : lien de confirmation annoncé')
})

await withPage('connexion avec Google', { width: 1280, theme: 'dark', lang: 'en' }, async (page) => {
  const n = 'Google'
  await page.goto(base + '/offres.html')
  await page.waitForSelector('#googleGis:not([hidden]) iframe')
  const hashed = await page.evaluate(() => window.__gis.cfg.nonce)
  await page.evaluate(() => window.__gis.cfg.callback({ credential: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln' }))
  await page.waitForSelector('#viewOffers:not([hidden]) .card')
  const sent = page.__st.idTokens[0] || {}
  if (sent.provider !== 'google') fail(n, 'fournisseur non google')
  if (!sent.nonce || sha256(sent.nonce) !== hashed) fail(n, 'nonce : le brut vers Supabase ne correspond pas au haché vers Google')
  else ok(n, 'nonce haché vers Google, brut vers Supabase')
})

await withPage('Google désactivé', { project: { google: false } }, async (page) => {
  await page.goto(base + '/offres.html')
  await expectText('Google désactivé', page, '#googleNote', /pas encore activée/, 'la phrase du kit')
  if (await page.locator('script[src*="accounts.google.com"]').count()) fail('Google désactivé', 'le script de Google a été chargé')
})

await withPage('liste, filtres, détail, statut', {}, async (page) => {
  const n = 'liste'
  await signIn(page)
  await page.waitForSelector('#viewOffers:not([hidden]) .card')
  const cards = await page.locator('.card').count()
  // 9 offres de démo : une ignorée cachée par « Toutes », une disparue sans
  // statut cachée tant qu'on ne la demande pas → 7.
  if (cards !== 7) fail(n, `${cards} cartes au lieu de 7`); else ok(n, '7 cartes (ignorée et disparue sans statut cachées)')
  await expectText(n, page, '#offersBody', /1 offre\(s\) ne sont plus publiées/, 'offre disparue sans statut comptée')
  if (await page.locator(`.card[data-id="${DEMO.OFFERS[0].id}"] .badge--new`).count() !== 1) fail(n, 'badge Nouveau absent')
  if (await page.locator(`.card[data-id="${DEMO.OFFERS[0].id}"] .badge--multi`).count() !== 1) fail(n, 'badge Multi-sites absent')
  if (await page.locator(`.card[data-id="${DEMO.OFFERS[6].id}"] .badge--dead`).count() !== 1) fail(n, 'badge Lien mort absent')
  await page.getByRole('button', { name: /Alternance seulement/ }).click()
  const alt = await page.locator('.card').count()
  if (alt !== 2) fail(n, `${alt} offres en alternance au lieu de 2`); else ok(n, 'filtre alternance')
  await page.getByRole('button', { name: /Alternance seulement/ }).click()
  await page.getByRole('button', { name: /^✓?Ignoré/ }).click()
  if (await page.locator('.card').count() !== 1) fail(n, 'filtre Ignoré'); else ok(n, 'filtre Ignoré')
  await page.getByRole('button', { name: /^✓?Toutes\s*\d/ }).click()
  await page.getByRole('button', { name: /^✓?Adzuna/ }).click()
  if (await page.locator('.card').count() !== 2) fail(n, 'filtre Adzuna'); else ok(n, 'filtre par source')
  await page.getByRole('button', { name: /Toutes les sources/ }).click()
  // Statut enregistré tout de suite : seuls status et status_at partent.
  await page.selectOption(`#st-${DEMO.OFFERS[0].id}`, 'postule')
  await expectText(n, page, '#toast', /Statut enregistré : Postulé/, 'statut enregistré dit')
  const patch = page.__st.patches.at(-1)
  if (!patch || Object.keys(patch.body).sort().join() !== 'status,status_at' || patch.body.status !== 'postule') fail(n, 'mise à jour du statut : ' + JSON.stringify(patch))
  else ok(n, 'seuls status et status_at écrits')
  // Le détail : tous les liens.
  await page.click(`.card[data-id="${DEMO.OFFERS[0].id}"] h3 a`)
  await page.waitForSelector('#viewOffer:not([hidden])')
  const links = await page.locator('#viewOffer .op-links a').evaluateAll((as) => as.map((a) => [a.href, a.target, a.rel]))
  if (links.length !== 3 || links.some(([, t, r]) => t !== '_blank' || !/noopener/.test(r))) fail(n, 'liens du détail : ' + JSON.stringify(links))
  else ok(n, '« Voir l\'offre » et « Aussi sur » (3 liens, noopener)')
  if ((await page.inputValue('#opStatus')) !== 'postule') fail(n, 'le détail ne reprend pas le statut')
  // Un lien mort se dit.
  await page.goto(base + '/offres.html#offre-' + DEMO.OFFERS[6].id)
  await expectText(n, page, '#viewOffer', /ne mène plus à rien/, 'lien mort dit dans le détail')
})

await withPage('statut refusé par le serveur', { project: { patchFailId: DEMO.OFFERS[1].id } }, async (page) => {
  const n = 'statut refusé'
  await signIn(page)
  await page.waitForSelector('.card')
  await page.selectOption(`#st-${DEMO.OFFERS[1].id}`, 'entretien')
  await expectText(n, page, '#toast', /n'a pas pu être enregistré/, 'échec dit')
  if ((await page.inputValue(`#st-${DEMO.OFFERS[1].id}`)) !== '') fail(n, 'la liste n\'est pas revenue en arrière')
  else ok(n, 'le choix revient à l\'état enregistré')
})

await withPage('fausse offre, ignorer', { width: 1280 }, async (page) => {
  const n = 'fausse offre'
  await signIn(page)
  await page.waitForSelector('.card')
  await page.click(`.card[data-id="${DEMO.OFFERS[4].id}"] .block-btn`)
  await page.waitForSelector('#confirmDialog[open]')
  await shot(page, 'confirmation-fausse-offre-1280.png')
  await page.click('#confirmOk')
  await expectText(n, page, '#toast', /Offre masquée/, 'masquée')
  if (await page.locator(`.card[data-id="${DEMO.OFFERS[4].id}"]`).count()) fail(n, 'la carte est restée')
  const p = page.__st.patches.at(-1)
  if (!p || JSON.stringify(p.body) !== '{"blocked":true}') fail(n, 'écriture : ' + JSON.stringify(p)); else ok(n, 'seul blocked écrit')
  await page.click(`.card[data-id="${DEMO.OFFERS[3].id}"] h3 a`)
  await page.getByRole('button', { name: /Ignorer et supprimer/ }).click()
  await page.click('#confirmOk')
  await page.waitForSelector('#viewOffers:not([hidden])')
  if (await page.locator(`.card[data-id="${DEMO.OFFERS[3].id}"]`).count()) fail(n, 'l\'offre ignorée est restée dans « Toutes »')
  else ok(n, 'ignorée, retour à la liste')
})

await withPage('actualiser : succès', {}, async (page) => {
  const n = 'actualiser'
  await signIn(page)
  await page.waitForSelector('.card')
  await page.click('#refreshBtn')
  await page.waitForTimeout(150)
  if (!(await page.isDisabled('#refreshBtn'))) fail(n, 'bouton non désactivé pendant l\'appel'); else ok(n, 'bouton désactivé pendant l\'appel')
  await expectText(n, page, '#searchStatus', /Recherche en cours/, 'recherche en cours dite')
  await shot(page, 'actualiser-en-cours-390.png')
  await expectText(n, page, '#searchStatus', /11 offre\(s\) gardée\(s\), dont 2 nouvelle\(s\)/, 'compteurs dits')
  await expectText(n, page, '#searchStatus', /Jooble : délai dépassé/, 'source en délai dépassé nommée')
  await expectText(n, page, '#searchStatus', /Adzuna : pas encore configurée/, 'source non configurée nommée')
  await expectText(n, page, '#searchStatus', /La Bonne Alternance : sautée/, 'source sautée nommée')
  if (await page.isDisabled('#refreshBtn')) fail(n, 'bouton resté désactivé')
  if (!/^Bearer /.test(page.__st.searchAuth || '')) fail(n, 'la fonction est appelée sans la session')
  if (await page.locator(`.card[data-id="${DEMO.NEW_OFFERS[0].id}"]`).count() !== 1) fail(n, 'nouvelle offre non affichée'); else ok(n, 'liste relue après la recherche')
  await shot(page, 'actualiser-ok-390.png')
})

for (const [mode, re, label] of [
  ['quota', /Limite de recherches atteinte pour aujourd'hui/, 'quota'],
  ['error', /La recherche a échoué \(HTTP 500\)/, 'erreur du service'],
  ['no_settings', /Il manque tes réglages/, 'réglages absents'],
  ['storage_limit', /taille maximale/, 'plafond de stockage'],
  ['not_authenticated', /Ta session a expiré/, 'session expirée'],
  ['not_configured', /Aucune source n'est configurée/, 'aucune source configurée'],
  ['save_failed', /trouvées, mais pas enregistrées/, 'enregistrement raté'],
  ['bad_response', /quelque chose d'illisible/, 'réponse illisible'],
]) {
  await withPage(`actualiser : ${label}`, { width: mode === 'quota' ? 1280 : 390, theme: mode === 'quota' ? 'dark' : 'light', project: { search: mode } }, async (page) => {
    await signIn(page)
    await page.waitForSelector('.card')
    const before = await page.locator('.card').count()
    await page.click('#refreshBtn')
    await expectText(`actualiser ${label}`, page, '#searchStatus', re, 'phrase dite')
    if (await page.isDisabled('#refreshBtn')) fail(`actualiser ${label}`, 'bouton resté désactivé')
    if ((await page.locator('.card').count()) !== before) fail(`actualiser ${label}`, 'la liste a changé')
    if (mode === 'no_settings' && !(await page.locator('#searchStatus a[href="#reglages"]').count())) fail(`actualiser ${label}`, 'pas de lien vers les réglages')
    await shot(page, `actualiser-${mode}.png`)
  })
}

await withPage('liste illisible', { project: { offersFail: true } }, async (page) => {
  await signIn(page)
  await expectText('liste illisible', page, '#offersStatus', /n'a pas pu être chargée/, 'échec de lecture dit, pas de liste vide')
  if (await page.locator('.empty').count()) fail('liste illisible', 'un état vide est affiché')
  await shot(page, 'liste-illisible-390.png')
})

await withPage('compte sans réglages', { width: 1280, lang: 'en', theme: 'dark', project: { settings: null } }, async (page) => {
  const n = 'sans réglages'
  await signIn(page)
  await page.waitForSelector('#viewSettings:not([hidden])')
  if (!(await page.url()).endsWith('#reglages')) fail(n, 'pas mené aux réglages')
  await expectText(n, page, '#settingsIntro', /Welcome! Choose your keywords/, 'accueil des réglages')
  await page.click('#settingsSave')
  await expectText(n, page, '#settingsStatus', /Add at least one keyword[\s\S]*Add at least one city/, 'réglages incomplets dits avant l\'envoi')
  if (page.__st.upserts.length) fail(n, 'des réglages incomplets sont partis')
  await page.fill('#keywordInput', 'p')
  await page.click('#keywordAdd')
  await expectText(n, page, '#keywordStatus', /at least 2 characters/, 'mot-clé trop court refusé')
  await page.fill('#keywordInput', '  plombier   chauffagiste ')
  await page.keyboard.press('Enter')
  await page.fill('#cityInput', 'zzpanne')
  await page.click('#citySearch')
  await expectText(n, page, '#cityResults', /did not succeed[\s\S]*without its town/, 'API Géo en panne dite, ajout sans commune proposé')
  await page.getByRole('button', { name: /without its town/ }).click()
  await expectText(n, page, '#locationList', /Incomplete: France Travail and La Bonne Alternance/, 'ville sans commune signalée incomplète')
  await page.locator('#locationList .chip-del').first().click()
  await page.fill('#cityInput', 'orl')
  await page.click('#citySearch')
  await page.waitForSelector('#cityResults .suggest button')
  await shot(page, 'reglages-commune-1280-dark-en.png')
  await page.locator('#cityResults .suggest button').first().click()
  await page.locator('#contractList input[value="CDI"]').check()
  await page.click('#settingsSave')
  await expectText(n, page, '#settingsStatus', /Settings saved/, 'enregistrés')
  const up = page.__st.upserts.at(-1)
  const b = up && up.body
  const good = b && b.user_id === DEMO.USER.id && JSON.stringify(b.keywords) === '["plombier chauffagiste"]' &&
    JSON.stringify(b.locations) === '[{"city":"Orléans","radius":30,"insee":"45234","lat":47.9029,"lon":1.9097}]' &&
    JSON.stringify(b.contract_types) === '["CDI"]' && Object.keys(b).sort().join() === 'contract_types,keywords,locations,user_id' && /on_conflict=user_id/.test(up.query)
  if (!good) fail(n, 'ligne écrite : ' + JSON.stringify(up)); else ok(n, 'ligne au contrat (user_id, keywords, locations, contract_types)')
  const geo = page.__st.geo.at(-1) || ''
  if (!/fields=nom%2Ccode%2CcodeDepartement%2Ccentre|fields=nom,code,codeDepartement,centre/.test(geo)) fail(n, 'requête Géo : ' + geo)
  await page.getByRole('button', { name: /Run the search/ }).click()
  await expectText(n, page, '#searchStatus', /Search finished/, 'recherche lancée depuis les réglages')
})

await withPage('supprimer mes données', {}, async (page) => {
  const n = 'suppression'
  await signIn(page)
  await page.waitForSelector('.card')
  await page.click('#navSettings')
  await page.click('#deleteDataBtn')
  await page.click('#confirmOk')
  await expectText(n, page, '#deletedText', /Tes données Jobbly sont supprimées\. Ton compte Lorderis reste actif/, 'texte du kit')
  if (!page.__st.deleted) fail(n, 'delete_my_data non appelée')
  await shot(page, 'suppression-390.png')
  await page.click('#deletedBack')
  await page.waitForSelector('#viewSignIn:not([hidden])')
})

await withPage('langue dans l\'appli', { width: 1280 }, async (page) => {
  await signIn(page)
  await page.waitForSelector('.card')
  await page.click('.lorderis-lang-toggle')
  await expectText('langue', page, '#offersTitle', /My offers/, 'titre réécrit en anglais')
  await expectText('langue', page, '#offersBody', /Live offers/, 'liste réécrite en anglais')
  const stored = await page.evaluate(() => localStorage.getItem('jobbly:prefs'))
  if (!/"language":"en"/.test(stored)) fail('langue', 'langue non retenue')
  await page.click('.lorderis-theme-toggle')
  const pref = await page.getAttribute('html', 'data-theme-pref')
  if (pref !== 'dark') fail('thème', `après Clair, ${pref} au lieu de dark`); else ok('thème', 'Clair → Sombre')
})

await withPage('présentation → appli', {}, async (page) => {
  const n = 'présentation'
  const seen = []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) seen.push(f.url()) })
  await page.goto(base + '/?code=abc123')
  await page.waitForURL(/\/offres\.html/)
  if (seen.some((u) => /\/offres\.html\?code=abc123$/.test(u))) ok(n, 'retour d\'autorisation renvoyé à l\'appli, requête intacte')
  else fail(n, 'retour non renvoyé : ' + seen.join(' → '))
  await page.goto(base + '/#access_token=x&type=signup')
  await page.waitForTimeout(500)
  if (seen.some((u) => /\/offres\.html#access_token=x&type=signup$/.test(u))) ok(n, 'fragment renvoyé à l\'appli, intact')
  else fail(n, 'fragment non renvoyé : ' + seen.join(' → '))
  // L'appli a lu puis retiré les jetons de l'adresse.
  if (/access_token|code=/.test(page.url())) fail(n, 'jetons restés dans l\'adresse : ' + page.url()); else ok(n, 'jetons retirés de l\'adresse')
  await page.evaluate(() => localStorage.removeItem('jobbly:app-opened'))
  await page.goto(base + '/')
  if (/offres\.html/.test(page.url())) fail(n, 'mené à l\'appli sans l\'avoir ouverte')
  await signIn(page)
  await page.waitForSelector('.card')
  await page.goto(base + '/')
  await page.waitForURL(/\/offres\.html$/).then(() => ok(n, 'appli déjà ouverte : / y mène'), () => fail(n, '/ ne mène pas à l\'appli ouverte'))
  await page.goto(base + '/?presentation')
  await page.waitForTimeout(300)
  if (/offres\.html/.test(page.url())) fail(n, '?presentation ne montre pas la présentation'); else ok(n, '?presentation montre la présentation')
})

await withPage('fichiers internes refusés', {}, async (page) => {
  for (const f of ['/job_alert.py', '/requirements.txt', '/config.exemple.json', '/planifier.ps1', '/README.md', '/supabase/config.toml', '/tools/check-site.mjs', '/docs/', '/.htaccess', '/.github/workflows/deploy.yml']) {
    const r = await page.request.get(base + f)
    if (r.status() !== 403 && r.status() !== 404) fail('refus', `${f} répond ${r.status()}`)
  }
  ok('refus', 'scripts Windows, documentation, outils et fichiers cachés refusés')
})

// ═══ 3. Contrastes des deux palettes ═══════════════════════════════════════
if (!ONLY || ONLY.test('contrastes')) {
  console.log('· contrastes')
  const css = fs.readFileSync(path.join(root, 'assets/css/jobbly.css'), 'utf8')
  const block = (sel) => {
    const i = css.indexOf(sel + ' {')
    const body = css.slice(i, css.indexOf('}', i))
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]))
  }
  const light = block(':root')
  const dark = { ...light, ...block(':root[data-theme="dark"]') }
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const TEXT = [['--ink', '--bg'], ['--ink', '--card'], ['--ink-2', '--card'], ['--muted', '--bg'], ['--muted', '--card'], ['--muted', '--card-2'], ['--accent-ink', '--card'], ['--accent-ink', '--bg'], ['--on-accent', '--accent'], ['--on-accent', '--accent-hover'], ['--hero-ink', '--hero-a'], ['--hero-ink', '--hero-b'], ['--danger', '--danger-bg'], ['--ok', '--ok-bg'], ['--warn', '--warn-bg'], ['--ink', '--accent-soft']]
  for (const k of ['new', 'alt', 'multi', 'gone', 'dead', 'ft', 'lba', 'jooble', 'cj', 'adzuna']) TEXT.push([`--b-${k}-ink`, `--b-${k}-bg`])
  for (const k of ['none', 'postule', 'attente', 'entretien', 'refuse', 'accepte', 'ignore']) TEXT.push([`--s-${k}-ink`, `--s-${k}-bg`])
  const UI = [['--field-line', '--card']]
  for (const [name, pal] of [['clair', light], ['sombre', dark]]) {
    let worst = 99
    for (const [a, b] of TEXT) {
      if (!pal[a] || !pal[b]) { fail('contrastes', `${name} : ${a} ou ${b} absent`); continue }
      const r = ratio(pal[a], pal[b]); worst = Math.min(worst, r)
      if (r < 4.5) fail('contrastes', `${name} : ${a} sur ${b} = ${r.toFixed(2)}:1 (< 4,5)`)
    }
    for (const [a, b] of UI) { const r = ratio(pal[a], pal[b]); if (r < 3) fail('contrastes', `${name} : ${a} sur ${b} = ${r.toFixed(2)}:1 (< 3)`) }
    ok('contrastes', `${name} : ${TEXT.length} paires de texte, la plus faible à ${worst.toFixed(2)}:1`)
  }
}

// ═══ 4. Les copies du kit, telles quelles ══════════════════════════════════
const kit = process.env.ACCOUNT_LORDERIS || path.join(root, '..', 'account-lorderis')
if ((!ONLY || ONLY.test('copies')) && fs.existsSync(path.join(kit, 'reference'))) {
  console.log('· copies du kit (' + kit + ')')
  const same = (mine, ref) => fs.readFileSync(path.join(root, mine), 'utf8') === fs.readFileSync(path.join(kit, ref), 'utf8')
  for (const [mine, ref] of [
    ['assets/css/presentation.css', 'reference/presentation/presentation.css'],
    ['assets/js/presentation.js', 'reference/presentation/presentation.js'],
    ['assets/css/legal.css', 'reference/privacy/legal.css'],
    ['assets/js/toc-spy.js', 'reference/privacy/toc-spy.js'],
    ['assets/css/lorderis-toggles.css', 'reference/toggles/lorderis-toggles.css'],
    ['assets/css/lorderis-footer.css', 'assets/css/lorderis-footer.css'],
  ]) {
    if (same(mine, ref)) ok('copies', mine); else fail('copies', `${mine} s'écarte de ${ref}`)
  }
  const tail = (f) => { const s = fs.readFileSync(f, 'utf8'); return s.slice(s.indexOf(';(function')) }
  if (tail(path.join(root, 'assets/js/google-auth.js')) === tail(path.join(kit, 'reference/web/google-auth.js'))) ok('copies', 'google-auth.js, hors en-tête')
  else fail('copies', 'google-auth.js s\'écarte de reference/web/google-auth.js')
} else if (!ONLY) {
  console.log('· copies du kit : Account-LordEris absent à côté, comparaison non faite (ACCOUNT_LORDERIS=<chemin> pour la faire)')
}

// ═══ 5. Les captures de la présentation ════════════════════════════════════
if (APERCU) {
  console.log('· captures de la présentation')
  const out = path.join(root, 'assets/apercu')
  fs.mkdirSync(out, { recursive: true })
  for (const lang of ['fr', 'en']) {
    for (const theme of ['light', 'dark']) {
      const page = await openPageWith({ width: 390, theme, lang, scale: 1.5 })
      await signIn(page)
      await page.waitForSelector('.card')
      // Les dates des démos sont relatives au 22 novembre 2026 : l'écran est
      // pris tel qu'il s'affiche, sans rien retoucher.
      const save = async (name) => {
        const png = await page.screenshot({ type: 'png' })
        const webp = await page.evaluate(async (b64) => {
          const img = new Image()
          img.src = 'data:image/png;base64,' + b64
          await img.decode()
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
          c.getContext('2d').drawImage(img, 0, 0)
          for (const q of [0.8, 0.7, 0.6, 0.5]) {
            const d = c.toDataURL('image/webp', q)
            if (d.length * 0.75 < 80000) return d
          }
          return c.toDataURL('image/webp', 0.4)
        }, png.toString('base64'))
        const file = path.join(out, `${name}-${lang}-${theme}.webp`)
        fs.writeFileSync(file, Buffer.from(webp.split(',')[1], 'base64'))
        console.log(`  ${path.relative(root, file)} : ${Math.round(fs.statSync(file).size / 1024)} ko`)
      }
      // L'encodage en WebP se fait par un <canvas> de la page même : img-src
      // de l'appli admet data:, et Chromium sait écrire du WebP.
      await save('offers')
      await page.click(`.card[data-id="${DEMO.OFFERS[0].id}"] h3 a`)
      await page.waitForSelector('#viewOffer:not([hidden]) .op-title')
      await save('offer')
      await page.click('#navSettings')
      await page.waitForSelector('#viewSettings:not([hidden]) .chip')
      await save('settings')
      await page.context().close()
    }
  }
}

await browser.close()
server.close()
console.log('')
if (failures.length) {
  console.log(`ÉCHEC : ${failures.length} problème(s).`)
  process.exit(1)
}
console.log('Tout est vert : 0 violation de CSP, 0 erreur JS, aucun défilement horizontal.')
