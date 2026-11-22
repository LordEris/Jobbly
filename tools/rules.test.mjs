// tools/rules.test.mjs — les règles pures de l'écran (assets/js/rules.js) et
// les deux catalogues de textes (assets/js/i18n.js).
//
//   node --test tools/rules.test.mjs
//
// Sans dépendance : node:test et node:assert. i18n.js touche `document`
// seulement dans ses fonctions, pas au chargement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as R from '../assets/js/rules.js'
import { STRINGS } from '../assets/js/i18n.js'

const ID = 'ab'.repeat(16)
const row = (data, extra = {}) => ({ id: ID, data, first_seen: '2026-11-20T10:00:00Z', last_seen: '2026-11-22T10:00:00Z', gone_at: null, status: '', status_at: null, blocked: false, ...extra })

test('toOffer refuse un identifiant ou une donnée hors forme', () => {
  assert.equal(R.toOffer({ ...row({ title: 'x' }), id: 'nope' }), null)
  assert.equal(R.toOffer(row(null)), null)
  assert.equal(R.toOffer(row([1, 2])), null)
})

test('toOffer n\'ouvre que du http(s), jamais javascript:', () => {
  const o = R.toOffer(row({ title: 'Plombier', url: 'javascript:alert(1)', source: 'Jooble', links: [{ url: 'data:text/html,x', source: 'Jooble' }, { url: 'https://fr.jooble.org/desc/1', source: 'Jooble' }] }))
  assert.equal(o.url, 'https://fr.jooble.org/desc/1')
  assert.deepEqual(o.links.map((l) => l.url), ['https://fr.jooble.org/desc/1'])
})

test('toOffer : lien mort = aucun lien, la mention reste', () => {
  const o = R.toOffer(row({ title: 'Plombier', url: '', link_dead: true, links: [{ url: 'https://x.fr/a', source: 'Adzuna' }] }, { status: 'postule' }))
  assert.equal(o.linkDead, true)
  assert.equal(o.url, '')
  assert.deepEqual(o.links, [])
})

test('toOffer : sources dans l\'ordre de priorité, sans doublon, statut inconnu ramené à vide', () => {
  const o = R.toOffer(row({ title: 'Plombier', source: 'Adzuna', sources: ['Adzuna', 'France Travail', 'Jooble', 'France Travail'] }, { status: 'pirate' }))
  assert.deepEqual(o.sources, ['France Travail', 'Jooble', 'Adzuna'])
  assert.equal(o.status, '')
})

test('toOffer coupe les textes et retire les caractères de contrôle et de sens', () => {
  const o = R.toOffer(row({ title: 'A‮b\u0000c' + 'x'.repeat(400) }))
  assert.ok(o.title.length <= 200)
  assert.ok(!/[‮\u0000]/.test(o.title))
})

test('isAlternance : intitulé ou contrat, accents et casse ignorés', () => {
  assert.equal(R.isAlternance({ title: 'APPRENTI plombier', contract: '' }), true)
  assert.equal(R.isAlternance({ title: 'Plombier', contract: 'Contrat de professionnalisation' }), true)
  assert.equal(R.isAlternance({ title: 'Apprentie plombière', contract: '' }), true)
  assert.equal(R.isAlternance({ title: 'Plombier', contract: 'CDI' }), false)
})

test('isNew : après la dernière visite ; sans visite connue, tout est nouveau', () => {
  const o = { firstSeen: '2026-11-22T10:00:00.000Z' }
  assert.equal(R.isNew(o, '2026-11-21T00:00:00.000Z'), true)
  assert.equal(R.isNew(o, '2026-11-23T00:00:00.000Z'), false)
  assert.equal(R.isNew(o, null), true)
})

test('filterOffers : « Toutes » cache les ignorées, une offre signalée n\'apparaît jamais', () => {
  const list = [
    { id: '1', status: '', sources: ['Jooble'], title: 'a', contract: '', blocked: false },
    { id: '2', status: 'ignore', sources: ['Jooble'], title: 'b', contract: '', blocked: false },
    { id: '3', status: '', sources: ['Adzuna'], title: 'apprenti', contract: '', blocked: true },
  ]
  assert.deepEqual(R.filterOffers(list, { status: 'all' }).map((o) => o.id), ['1'])
  assert.deepEqual(R.filterOffers(list, { status: 'ignore' }).map((o) => o.id), ['2'])
  assert.deepEqual(R.filterOffers(list, { status: 'all', source: 'adzuna' }), [])
  const c = R.statusCounts(list)
  assert.equal(c.all, 1)
  assert.equal(c.ignore, 1)
})

test('splitSections : les disparues suivies restent, les autres se comptent', () => {
  const s = R.splitSections([{ goneAt: null, status: '' }, { goneAt: 'x', status: 'postule' }, { goneAt: 'x', status: '' }, { goneAt: 'x', status: 'ignore' }], false)
  assert.equal(s.active.length, 1)
  assert.equal(s.followed.length, 1)
  assert.equal(s.goneHidden, 2)
})

test('readSearchResult : succès lu, sources dans l\'ordre, codes de source compris', () => {
  const r = R.readSearchResult({ ok: true, counts: { raw: 10, duplicates: 2, dead_links: 1, kept: 7, new: 3 }, sources: { Adzuna: 'not_configured', 'France Travail': 4, Jooble: 'http_502', 'La Bonne Alternance': 'skipped', Careerjet: 'timeout' } }, 200)
  assert.equal(r.kind, 'ok')
  assert.equal(r.counts.kept, 7)
  assert.deepEqual(r.sources.map((s) => s.name), ['France Travail', 'La Bonne Alternance', 'Jooble', 'Careerjet', 'Adzuna'])
  assert.deepEqual(r.sources.map((s) => s.outcome.kind), ['count', 'skipped', 'http', 'timeout', 'not_configured'])
  assert.equal(r.sources[2].outcome.code, 502)
})

test('readSearchResult : chaque code du contrat est gardé, un corps illisible n\'est jamais un succès', () => {
  for (const code of ['no_settings', 'quota', 'storage_limit']) assert.deepEqual(R.readSearchResult({ ok: false, code }, 200), { kind: 'error', code })
  for (const [code, http] of [['not_authenticated', 401], ['invalid_request', 400], ['method_not_allowed', 405], ['not_configured', 503], ['save_failed', 500]]) {
    assert.deepEqual(R.readSearchResult({ ok: false, code }, http), { kind: 'error', code })
  }
  assert.deepEqual(R.readSearchResult('pas du JSON', 200), { kind: 'error', code: 'bad_response' })
  assert.deepEqual(R.readSearchResult({ ok: true }, 200), { kind: 'error', code: 'bad_response' })
  assert.deepEqual(R.readSearchResult(null, 401), { kind: 'error', code: 'not_authenticated' })
  assert.deepEqual(R.readSearchResult(null, 502), { kind: 'error', code: 'failed', http: 502 })
  assert.deepEqual(R.readSearchResult({ ok: false, code: 'inventé' }, 0), { kind: 'error', code: 'network' })
})

test('mots-clés : 2 à 60 caractères, 10 au plus, sans doublon (casse et accents ignorés)', () => {
  assert.equal(R.addKeyword([], 'p').error, 'keyword_short')
  assert.equal(R.addKeyword([], 'x'.repeat(61)).error, 'keyword_long')
  assert.equal(R.addKeyword(['Plombier'], ' plombier ').error, 'keyword_dup')
  assert.equal(R.addKeyword(Array.from({ length: 10 }, (_, i) => 'mot' + i), 'nouveau').error, 'keyword_max')
  assert.deepEqual(R.addKeyword([], '  aide   plombier ').keywords, ['aide plombier'])
})

test('villes : la forme de la base (clés, rayon entier 1–100, INSEE, coordonnées)', () => {
  assert.deepEqual(R.cleanLocation({ city: 'Orléans', radius: 30, insee: '45234', lat: 47.9, lon: 1.9, extra: 1 }), { city: 'Orléans', radius: 30, insee: '45234', lat: 47.9, lon: 1.9 })
  assert.equal(R.cleanLocation({ city: '   ', radius: 30 }), null)
  assert.equal(R.cleanLocation({ city: 'X', radius: 0 }), null)
  assert.equal(R.cleanLocation({ city: 'X', radius: 30.5 }), null)
  assert.deepEqual(R.cleanLocation({ city: 'Ajaccio', radius: 10, insee: '2A004', lat: 91, lon: 8 }), { city: 'Ajaccio', radius: 10, insee: '2A004' })
  assert.equal(R.addLocation([{ city: 'Tours', radius: 30, insee: '37261' }], { city: 'tours', radius: 10 }).error, 'location_dup')
  assert.equal(R.isIncompleteLocation({ city: 'Tours', radius: 30 }), true)
  assert.equal(R.isIncompleteLocation({ city: 'Tours', radius: 30, insee: '37261', lat: 47.4, lon: 0.7 }), false)
})

test('settingsRow : seulement les colonnes du contrat', () => {
  const r = R.settingsRow('u', { keywords: ['a b'], locations: [{ city: 'Tours', radius: 30, insee: '37261', lat: 1, lon: 2, junk: 1 }], contractTypes: ['CDI', 'XYZ'] })
  assert.deepEqual(Object.keys(r).sort(), ['contract_types', 'keywords', 'locations', 'min_salary', 'user_id'])
  assert.deepEqual(r.contract_types, ['CDI'])
  assert.equal(r.min_salary, null)
  assert.equal(R.settingsRow('u', { keywords: [], locations: [], contractTypes: [], minSalary: 2000 }).min_salary, 2000)
  assert.equal(R.settingsRow('u', { keywords: [], locations: [], contractTypes: [], minSalary: '2000' }).min_salary, null)
  assert.deepEqual(Object.keys(r.locations[0]).sort(), ['city', 'insee', 'lat', 'lon', 'radius'])
  for (const c of R.CONTRACT_TYPES) assert.match(c, /^[A-Z0-9]{1,10}$/)
})

test('readCommunes : la réponse de l\'API Géo est hostile', () => {
  const out = R.readCommunes([{ nom: 'Orléans', code: '45234', codeDepartement: '45', centre: { coordinates: [1.9, 47.9] } }, { nom: '<b>x</b>', code: '../etc' }, 'x', null])
  assert.deepEqual(out, [{ city: 'Orléans', insee: '45234', dept: '45', lat: 47.9, lon: 1.9 }])
  assert.deepEqual(R.readCommunes({ error: 1 }), [])
})

test('dernière visite : par compte, cinq au plus', () => {
  let raw = null
  for (let i = 0; i < 7; i++) raw = R.nextLastVisit(raw, 'u' + i, '2026-11-2' + i + 'T00:00:00.000Z')
  const m = JSON.parse(raw)
  assert.equal(Object.keys(m).length, 5)
  assert.equal(R.readLastVisit(raw, 'u6'), '2026-11-26T00:00:00.000Z')
  assert.equal(R.readLastVisit('{pas du json', 'u6'), null)
})

test('erreurs d\'authentification → une clé de texte connue', () => {
  assert.equal(R.authErrorKey({ code: 'invalid_credentials' }), 'auth.err_credentials')
  assert.equal(R.authErrorKey({ message: 'Email not confirmed' }), 'auth.err_unconfirmed')
  assert.equal(R.authErrorKey({ status: 429 }), 'auth.err_rate')
  assert.equal(R.authErrorKey({ status: 0 }), 'auth.err_network')
  assert.equal(R.authErrorKey({ message: 'autre' }), 'auth.err_generic')
})

test('les deux catalogues ont les mêmes clés et les mêmes {variables}', () => {
  const fr = Object.keys(STRINGS.fr).sort()
  const en = Object.keys(STRINGS.en).sort()
  assert.deepEqual(en, fr)
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
  for (const k of fr) assert.equal(vars(STRINGS.en[k]), vars(STRINGS.fr[k]), k)
})

test('chaque code d\'erreur de la recherche a sa phrase, dans les deux langues', () => {
  for (const code of ['no_settings', 'quota', 'storage_limit', 'not_authenticated', 'invalid_request', 'method_not_allowed', 'not_configured', 'save_failed', 'bad_response', 'network', 'failed']) {
    assert.ok(STRINGS.fr['search.' + code], code)
    assert.ok(STRINGS.en['search.' + code], code)
  }
})

test('les textes du kit Lorderis sont au mot près', () => {
  assert.equal(STRINGS.fr['auth.lead'], 'Connecte-toi avec ton compte Lorderis — le même pour toutes nos apps.')
  assert.equal(STRINGS.fr['auth.signup_note'], 'Ce compte Lorderis te servira aussi dans nos autres apps. Supprimer tes données de Jobbly ne supprime pas ton compte tant qu\'une autre app s\'en sert.')
  assert.equal(STRINGS.fr['data.delete'], 'Supprimer mes données Jobbly')
  assert.equal(STRINGS.fr['data.deleted'], 'Tes données Jobbly sont supprimées. Ton compte Lorderis reste actif si tu utilises une autre de nos apps ; tu peux le gérer sur account.lorderis.dev.')
  assert.equal(STRINGS.en['data.where'], 'To delete your Lorderis account and the data of all our apps at once, go to account.lorderis.dev.')
  assert.equal(STRINGS.fr['auth.google_off'], 'La connexion avec Google n\'est pas encore activée. Utilise ton adresse e-mail et ton mot de passe.')
})

test('salaire : lu, borné, jamais deviné', () => {
  assert.deepEqual(R.readSalary({ label: 'Mensuel de 2000 Euros', min: 2000, max: 2500 }), { label: 'Mensuel de 2000 Euros', min: 2000, max: 2500 })
  assert.deepEqual(R.readSalary({ label: '', min: 2500, max: 2000 }), { label: '', min: 2000, max: 2500 })
  assert.deepEqual(R.readSalary({ label: '', min: null, max: 2000 }), { label: '', min: 2000, max: null })
  assert.deepEqual(R.readSalary({ label: 'Selon profil', min: null, max: null }), { label: 'Selon profil', min: null, max: null })
  assert.equal(R.readSalary({ label: '', min: '2000' }), null)
  assert.equal(R.readSalary({ min: 2000.5 }), null)
  assert.equal(R.readSalary({ min: 10 ** 9 }), null)
  assert.equal(R.readSalary([2000]), null)
  assert.equal(R.readSalary(null), null)
  assert.equal(R.readSalary({ label: '<b>x</b>'.repeat(100), min: null }).label.length <= 120, true)
  const o = R.toOffer({ id: 'a'.repeat(32), data: { title: 'Plombier', salary: { label: '', min: 1800, max: 2200 } } })
  assert.deepEqual(o.salary, { label: '', min: 1800, max: 2200 })
  assert.equal(R.toOffer({ id: 'b'.repeat(32), data: { title: 'Plombier' } }).salary, null)
})

test('salaire minimum : cache ce qui annonce moins, garde ce qui n\'annonce rien', () => {
  const mk = (id, salary) => R.toOffer({ id: id.repeat(32), data: { title: 'Plombier', salary } })
  const low = mk('a', { label: '', min: 1600, max: null })
  const range = mk('b', { label: '', min: 1700, max: 2300 })
  const high = mk('c', { label: '', min: 2500, max: null })
  const none = mk('d', undefined)
  const text = mk('e', { label: 'Selon profil', min: null, max: null })
  const all = [low, range, high, none, text]
  const base = { status: 'all', source: 'all', alt: false, onlyNew: false, lastVisit: null }
  const ids = (l) => l.map((o) => o.id[0]).sort().join('')
  assert.equal(ids(R.filterOffers(all, base)), 'abcde')
  // Le haut de la fourchette compte : 1 700 – 2 300 reste au-dessus de 2 000.
  assert.equal(ids(R.filterOffers(all, { ...base, minSalary: 2000 })), 'bcde')
  assert.equal(R.countUnderSalary(all, { ...base, minSalary: 2000 }), 1)
  assert.equal(ids(R.filterOffers(all, { ...base, minSalary: 2000, showUnderSalary: true })), 'abcde')
  assert.equal(ids(R.filterOffers(all, { ...base, onlySalary: true })), 'abc')
  assert.equal(R.countUnderSalary(all, { ...base, minSalary: null }), 0)
  assert.equal(R.salaryUnder(none, 5000), false)
})

test('salaire minimum : la saisie', () => {
  assert.deepEqual(R.parseMinSalary(''), { value: null })
  assert.deepEqual(R.parseMinSalary('  '), { value: null })
  assert.deepEqual(R.parseMinSalary('2000'), { value: 2000 })
  assert.deepEqual(R.parseMinSalary('2 000 €'), { value: 2000 })
  assert.deepEqual(R.parseMinSalary('2000,50'), { error: 'salary_bad' })
  assert.deepEqual(R.parseMinSalary('-5'), { error: 'salary_bad' })
  assert.deepEqual(R.parseMinSalary('abc'), { error: 'salary_bad' })
  assert.deepEqual(R.parseMinSalary('50'), { error: 'salary_range' })
  assert.deepEqual(R.parseMinSalary('40000'), { error: 'salary_range' })
  assert.equal(R.readSettings({ keywords: ['plombier'], locations: [], min_salary: 2000 }).minSalary, 2000)
  assert.equal(R.readSettings({ keywords: ['plombier'], locations: [], min_salary: 5 }).minSalary, null)
  assert.equal(R.readSettings({ keywords: ['plombier'], locations: [] }).minSalary, null)
  assert.deepEqual(R.settingsErrors({ keywords: ['a'], locations: [{}], minSalary: 50 }), ['salary_range'])
  assert.equal(R.formatSalary({ min: 1800, max: 2200 }, 'fr').replace(/\s/g, ' '), '1 800 – 2 200 €')
  assert.equal(R.formatSalary({ min: 1800, max: null }, 'en'), '1,800 €')
  assert.equal(R.formatSalary(null, 'fr'), '')
})
