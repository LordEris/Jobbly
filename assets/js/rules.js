// ────────────────────────────────────────────────────────────────────────────
// rules.js — les règles de l'écran, pures
// ────────────────────────────────────────────────────────────────────────────
// Aucun accès au DOM, au réseau ni au stockage : ce module est lu tel quel
// par le navigateur (module ES) et par `node --test tools/rules.test.mjs`.
// Une règle écrite dans app.js ne se teste pas ; elle vient ici.
//
// Tout ce qui arrive du réseau est HOSTILE : une ligne de jobbly.offers est
// écrite par la fonction Edge depuis des annonces de sites tiers, la réponse
// de l'API Géo vient d'un autre service. Chaque champ est relu, borné, typé ;
// une adresse n'est gardée que si elle est en http(s).
// ────────────────────────────────────────────────────────────────────────────

/** Les statuts, dans l'ordre du rapport du script ; '' = à traiter. */
export const STATUSES = ['', 'postule', 'attente', 'entretien', 'refuse', 'accepte', 'ignore']

/**
 * Les sources, dans l'ordre de priorité du contrat (France Travail d'abord).
 * `key` est l'identifiant stable (classe CSS, filtre) ; `name` le nom
 * affiché, celui que la fonction Edge écrit dans `data.sources`.
 */
export const SOURCES = [
  { key: 'ft', name: 'France Travail' },
  { key: 'lba', name: 'La Bonne Alternance' },
  { key: 'jooble', name: 'Jooble' },
  { key: 'careerjet', name: 'Careerjet' },
  { key: 'adzuna', name: 'Adzuna' },
]

/**
 * Les types de contrat de France Travail (paramètre `typeContrat` de l'API
 * Offres d'emploi). Vide = pas de filtre : c'est le défaut, parce que les
 * offres d'apprentissage y sont souvent enregistrées en CDD.
 */
export const CONTRACT_TYPES = ['CDI', 'CDD', 'MIS', 'SAI', 'DDI', 'DIN', 'TTI', 'LIB', 'FRA', 'CCE', 'REP']

export const LIMITS = { keywords: 10, keywordMin: 2, keywordMax: 60, locations: 5, cityMax: 80, radiusMin: 1, radiusMax: 100, salaryMin: 100, salaryMax: 30000 }
export const RADII = [5, 10, 20, 30, 50, 75, 100]

const ID_RE = /^[0-9a-f]{32}$/
const INSEE_RE = /^[0-9AB]{5}$/

function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Une chaîne de confiance : texte, sans caractère de contrôle, coupée. */
export function str(v, max) {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** Une adresse ouvrable : http ou https, sinon ''. Jamais `javascript:`. */
export function safeUrl(v) {
  if (typeof v !== 'string' || v.length > 2048) return ''
  try {
    const u = new URL(v.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''
  } catch (e) {
    return ''
  }
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch (e) { return '' }
}

/** La clé d'une source, d'après son nom ou son identifiant ; 'other' sinon. */
export function sourceKey(name) {
  const n = fold(typeof name === 'string' ? name : '').replace(/[^a-z0-9]/g, '')
  if (n === 'francetravail' || n === 'ft' || n === 'poleemploi') return 'ft'
  if (n === 'labonnealternance' || n === 'lba') return 'lba'
  if (n === 'jooble') return 'jooble'
  if (n === 'careerjet') return 'careerjet'
  if (n === 'adzuna') return 'adzuna'
  return 'other'
}

export function sourceName(name) {
  const k = sourceKey(name)
  const s = SOURCES.find((x) => x.key === k)
  return s ? s.name : str(name, 40)
}

function sourceRank(name) {
  const i = SOURCES.findIndex((x) => x.key === sourceKey(name))
  return i < 0 ? SOURCES.length : i
}

function isoOrNull(v) {
  if (typeof v !== 'string' || v.length > 40) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Une date YYYY-MM-DD (ou le début d'un ISO), sinon ''. */
function dayOrEmpty(v) {
  if (typeof v !== 'string') return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  return m ? m[0] : ''
}

/**
 * Une ligne de jobbly.offers → l'offre que l'écran affiche, ou null si elle
 * ne se lit pas (identifiant hors forme, `data` qui n'est pas un objet).
 */
export function toOffer(row) {
  if (!row || typeof row !== 'object' || !ID_RE.test(row.id || '')) return null
  const d = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : null
  if (!d) return null
  const links = []
  const seen = new Set()
  const pushLink = (url, source) => {
    const u = safeUrl(url)
    if (!u || seen.has(u)) return
    seen.add(u)
    links.push({ url: u, source: sourceName(source) })
  }
  if (Array.isArray(d.links)) {
    for (const l of d.links.slice(0, 12)) if (l && typeof l === 'object') pushLink(l.url, l.source)
  }
  const linkDead = d.link_dead === true
  const url = linkDead ? '' : safeUrl(d.url)
  if (url && !seen.has(url)) { seen.add(url); links.unshift({ url, source: sourceName(d.source) }) }
  links.sort((a, b) => (a.url === url ? -1 : b.url === url ? 1 : sourceRank(a.source) - sourceRank(b.source)))
  const names = []
  const addName = (n) => { const s = sourceName(n); if (s && !names.includes(s)) names.push(s) }
  if (Array.isArray(d.sources)) d.sources.slice(0, 8).forEach(addName)
  if (typeof d.source === 'string') addName(d.source)
  links.forEach((l) => addName(l.source))
  names.sort((a, b) => sourceRank(a) - sourceRank(b))
  const status = STATUSES.includes(row.status) ? row.status : ''
  return {
    salary: readSalary(d.salary),
    id: row.id,
    title: str(d.title, 200) || '—',
    company: str(d.company, 120),
    location: str(d.location, 120),
    contract: str(d.contract, 80),
    date: dayOrEmpty(d.date),
    expires: dayOrEmpty(d.expires),
    summary: str(d.summary, 20000),
    url: linkDead ? '' : (url || (links[0] ? links[0].url : '')),
    links: linkDead ? [] : links,
    sources: names,
    linkDead,
    firstSeen: isoOrNull(row.first_seen),
    lastSeen: isoOrNull(row.last_seen),
    goneAt: isoOrNull(row.gone_at),
    status,
    statusAt: isoOrNull(row.status_at),
    blocked: row.blocked === true,
  }
}

// ── La rémunération ────────────────────────────────────────────────────────
//
// La fonction Edge ramène chaque salaire annoncé à des euros PAR MOIS (heure,
// jour, semaine, année convertis), tels que la source les donne — brut ou
// net, elle ne le dit presque jamais. Une offre sans montant lisible n'est
// jamais cachée par le salaire minimum : une donnée absente n'est pas
// défavorable, l'écran la dit « non indiquée ».

function salaryAmount(v) {
  return Number.isInteger(v) && v >= 100 && v <= 100000 ? v : null
}

/** `data.salary` → `{label, min, max}` (€/mois), ou null s'il n'y a rien à dire. */
export function readSalary(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const label = str(v.label, 120)
  let min = salaryAmount(v.min)
  let max = salaryAmount(v.max)
  if (min === null && max !== null) { min = max; max = null }
  if (min !== null && max !== null && max < min) [min, max] = [max, min]
  if (max === min) max = null
  if (!label && min === null) return null
  return { label, min, max }
}

/** Le haut de la fourchette annoncée, ou null si aucun montant ne se lit. */
export function salaryTop(o) {
  if (!o.salary || o.salary.min === null) return null
  return o.salary.max ?? o.salary.min
}

/** Sous le minimum : seulement si le montant annoncé, haut de la fourchette compris, est plus bas. */
export function salaryUnder(o, minSalary) {
  if (!Number.isInteger(minSalary)) return false
  const top = salaryTop(o)
  return top !== null && top < minSalary
}

/** « 2 000 – 2 500 € / mois » ; '' si aucun montant. */
export function formatSalary(salary, lang) {
  if (!salary || salary.min === null) return ''
  const nf = new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { maximumFractionDigits: 0 })
  const range = salary.max === null ? nf.format(salary.min) : `${nf.format(salary.min)} – ${nf.format(salary.max)}`
  return `${range} €`
}

/**
 * Le salaire minimum tapé dans les réglages : `{value}` (null = aucun) ou
 * `{error}`. Des euros entiers par mois ; espaces et « € » tolérés.
 */
export function parseMinSalary(raw) {
  const s = typeof raw === 'string' ? raw.replace(/[\s\u00a0\u202f€]/g, '') : ''
  if (!s) return { value: null }
  if (!/^\d{1,6}$/.test(s)) return { error: 'salary_bad' }
  const n = Number(s)
  if (n < LIMITS.salaryMin || n > LIMITS.salaryMax) return { error: 'salary_range' }
  return { value: n }
}

/** Alternance ou apprentissage : l'intitulé (règle du script), et le contrat. */
export function isAlternance(o) {
  const re = /\b(apprenti|apprentie|apprentis|apprentissage|alternance|alternant|alternante|professionnalisation)\b/
  return re.test(fold(o.title)) || re.test(fold(o.contract))
}

/**
 * Nouvelle depuis la dernière visite : vue la première fois après elle.
 * Sans visite connue (premier passage sur cet appareil), tout est nouveau.
 */
export function isNew(o, lastVisit) {
  if (!o.firstSeen) return false
  if (!lastVisit) return true
  return o.firstSeen > lastVisit
}

/**
 * Les filtres de la liste. `status` vaut 'all' ou un statut ; « Toutes »
 * cache les offres ignorées (règle du script), le filtre « Ignoré » les
 * montre. Une offre signalée fausse (`blocked`) n'apparaît jamais.
 */
export function filterOffers(list, f) {
  return list.filter((o) => {
    if (o.blocked) return false
    if (f.status === 'all' ? o.status === 'ignore' : o.status !== f.status) return false
    if (f.alt && !isAlternance(o)) return false
    if (f.source && f.source !== 'all' && !o.sources.some((s) => sourceKey(s) === f.source)) return false
    if (f.onlyNew && !isNew(o, f.lastVisit)) return false
    if (f.onlySalary && salaryTop(o) === null) return false
    if (!f.showUnderSalary && salaryUnder(o, f.minSalary)) return false
    return true
  })
}

/** Combien d'offres le salaire minimum cache, parmi celles que les autres filtres montreraient. */
export function countUnderSalary(list, f) {
  if (!Number.isInteger(f.minSalary)) return 0
  return filterOffers(list, { ...f, showUnderSalary: true }).filter((o) => salaryUnder(o, f.minSalary)).length
}

/** Le compte de chaque statut, sur ce que la liste peut montrer. */
export function statusCounts(list) {
  const c = { all: 0 }
  for (const s of STATUSES) c[s] = 0
  for (const o of list) {
    if (o.blocked) continue
    c[o.status] += 1
    if (o.status !== 'ignore') c.all += 1
  }
  return c
}

/** Plus récente d'abord : date de l'annonce, sinon première vue. */
export function sortOffers(list) {
  const key = (o) => o.date || (o.firstSeen || '').slice(0, 10)
  return list.slice().sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : a.id < b.id ? -1 : 1))
}

/**
 * Les sections de la liste : celles encore publiées ; celles qui ne le sont
 * plus mais qu'on suit (un statut autre que « ignoré ») ; et le nombre des
 * autres, qui ne s'affichent que si on le demande.
 */
export function splitSections(list, showAllGone) {
  const active = []
  const followed = []
  const gone = []
  for (const o of list) {
    if (!o.goneAt) active.push(o)
    else if (o.status && o.status !== 'ignore') followed.push(o)
    else gone.push(o)
  }
  return { active, followed, gone: showAllGone ? gone : [], goneHidden: showAllGone ? 0 : gone.length }
}

/** « 2026-11-22 » → « 22/11/2026 » (fr) ou « 22 Nov 2026 » (en). */
export function formatDay(day, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '')
  if (!m) return ''
  if (lang === 'en') {
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]
    return mon ? `${Number(m[3])} ${mon} ${m[1]}` : ''
  }
  return `${m[3]}/${m[2]}/${m[1]}`
}

// ── La réponse de jobbly-search ────────────────────────────────────────────

// Les codes de jobbly-search (supabase/functions/README.md) : en HTTP 200,
// no_settings, quota et storage_limit ; en erreur, not_authenticated (401),
// invalid_request (400), method_not_allowed (405), not_configured (503,
// aucune source configurée) et save_failed (500).
const KNOWN_CODES = ['no_settings', 'quota', 'storage_limit', 'not_authenticated', 'invalid_request', 'method_not_allowed', 'not_configured', 'save_failed']
const COUNT_KEYS = ['raw', 'duplicates', 'dead_links', 'kept', 'new']

function count(v) {
  return Number.isInteger(v) && v >= 0 && v < 1e7 ? v : null
}

/** Ce que rend une source : un nombre, ou un code. */
export function sourceOutcome(v) {
  if (count(v) !== null) return { kind: 'count', n: v }
  if (v === 'not_configured') return { kind: 'not_configured' }
  if (v === 'skipped') return { kind: 'skipped' }
  if (v === 'timeout') return { kind: 'timeout' }
  if (typeof v === 'string' && /^http_\d{3}$/.test(v)) return { kind: 'http', code: Number(v.slice(5)) }
  return { kind: 'error' }
}

/**
 * Le corps rendu par la fonction (2xx ou non) → ce que l'écran dira.
 * `{kind:'ok', counts, sources}` ou `{kind:'error', code}` ; un corps
 * illisible n'est jamais lu comme un succès.
 */
export function readSearchResult(body, httpStatus) {
  if (body && typeof body === 'object' && body.ok === true) {
    const counts = {}
    for (const k of COUNT_KEYS) counts[k] = count(body.counts && body.counts[k])
    if (counts.kept === null) return { kind: 'error', code: 'bad_response' }
    const sources = []
    const raw = body.sources && typeof body.sources === 'object' && !Array.isArray(body.sources) ? body.sources : {}
    for (const [name, v] of Object.entries(raw).slice(0, 10)) {
      sources.push({ key: sourceKey(name), name: sourceName(name), outcome: sourceOutcome(v) })
    }
    sources.sort((a, b) => sourceRank(a.name) - sourceRank(b.name))
    return { kind: 'ok', counts, sources }
  }
  if (body && typeof body === 'object' && body.ok === false && KNOWN_CODES.includes(body.code)) {
    return { kind: 'error', code: body.code }
  }
  if (httpStatus === 401) return { kind: 'error', code: 'not_authenticated' }
  if (httpStatus === 429) return { kind: 'error', code: 'quota' }
  if (httpStatus === 0) return { kind: 'error', code: 'network' }
  // Un 2xx dont le corps ne se lit pas n'est pas un succès : il se dit.
  if (Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300) return { kind: 'error', code: 'bad_response' }
  return { kind: 'error', code: 'failed', http: Number.isInteger(httpStatus) ? httpStatus : null }
}

// ── Réglages ───────────────────────────────────────────────────────────────

export function cleanKeyword(v) {
  return str(typeof v === 'string' ? v.replace(/\s+/g, ' ') : '', 200)
}

/** Ajouter un mot-clé : `{ok, keywords}` ou `{error}` (code stable). */
export function addKeyword(list, raw) {
  const k = cleanKeyword(raw)
  if (k.length < LIMITS.keywordMin) return { error: 'keyword_short' }
  if (k.length > LIMITS.keywordMax) return { error: 'keyword_long' }
  if (list.some((x) => fold(x) === fold(k))) return { error: 'keyword_dup' }
  if (list.length >= LIMITS.keywords) return { error: 'keyword_max' }
  return { ok: true, keywords: [...list, k] }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Une ville bien formée pour jobbly.settings.locations, ou null. */
export function cleanLocation(l) {
  if (!l || typeof l !== 'object') return null
  const city = str(l.city, 200)
  if (!city || city.length > LIMITS.cityMax) return null
  const radius = Number.isInteger(l.radius) && l.radius >= LIMITS.radiusMin && l.radius <= LIMITS.radiusMax ? l.radius : null
  if (radius === null) return null
  const out = { city, radius }
  if (typeof l.insee === 'string' && INSEE_RE.test(l.insee)) out.insee = l.insee
  const lat = num(l.lat)
  const lon = num(l.lon)
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) { out.lat = lat; out.lon = lon }
  return out
}

export function addLocation(list, loc) {
  const c = cleanLocation(loc)
  if (!c) return { error: 'location_bad' }
  if (list.length >= LIMITS.locations) return { error: 'location_max' }
  if (list.some((x) => (c.insee && x.insee === c.insee) || fold(x.city) === fold(c.city))) return { error: 'location_dup' }
  return { ok: true, locations: [...list, c] }
}

/** Une ligne de jobbly.settings, relue ; null si absente. */
export function readSettings(row) {
  if (!row || typeof row !== 'object') return null
  const keywords = Array.isArray(row.keywords) ? row.keywords.map(cleanKeyword).filter((k) => k.length >= LIMITS.keywordMin && k.length <= LIMITS.keywordMax).slice(0, LIMITS.keywords) : []
  const locations = Array.isArray(row.locations) ? row.locations.map(cleanLocation).filter(Boolean).slice(0, LIMITS.locations) : []
  const contractTypes = Array.isArray(row.contract_types) ? row.contract_types.filter((c) => CONTRACT_TYPES.includes(c)) : []
  const minSalary = Number.isInteger(row.min_salary) && row.min_salary >= LIMITS.salaryMin && row.min_salary <= LIMITS.salaryMax ? row.min_salary : null
  return { keywords, locations, contractTypes, minSalary, updatedAt: isoOrNull(row.updated_at) }
}

/**
 * Une ville sans code de commune est incomplète : France Travail ne la
 * cherche pas (il lui faut le code INSEE), La Bonne Alternance non plus (il
 * lui faut la position). La fonction la saute (`skipped`) ; l'écran le dit.
 */
export function isIncompleteLocation(l) {
  return !l.insee || typeof l.lat !== 'number' || typeof l.lon !== 'number'
}

/** Les erreurs qui empêchent d'enregistrer ; [] si tout va. */
export function settingsErrors(s) {
  const e = []
  if (!s.keywords.length) e.push('need_keyword')
  if (!s.locations.length) e.push('need_location')
  if (s.minSalary !== null && s.minSalary !== undefined && !(Number.isInteger(s.minSalary) && s.minSalary >= LIMITS.salaryMin && s.minSalary <= LIMITS.salaryMax)) e.push('salary_range')
  return e
}

/** La ligne à écrire (colonnes du contrat). */
export function settingsRow(userId, s) {
  return {
    user_id: userId,
    keywords: s.keywords.slice(0, LIMITS.keywords),
    locations: s.locations.map(cleanLocation).filter(Boolean).slice(0, LIMITS.locations),
    contract_types: s.contractTypes.filter((c) => CONTRACT_TYPES.includes(c)),
    min_salary: Number.isInteger(s.minSalary) ? s.minSalary : null,
  }
}

/**
 * La réponse de l'API Géo (`/communes?nom=…&fields=nom,code,codeDepartement,centre`)
 * → au plus six communes {city, insee, dept, lat, lon}. Ce qui n'a pas la
 * forme attendue est écarté.
 */
export function readCommunes(json) {
  if (!Array.isArray(json)) return []
  const out = []
  for (const c of json.slice(0, 20)) {
    if (!c || typeof c !== 'object') continue
    const city = str(c.nom, 80)
    const insee = typeof c.code === 'string' && INSEE_RE.test(c.code) ? c.code : ''
    if (!city || !insee) continue
    const coords = c.centre && Array.isArray(c.centre.coordinates) ? c.centre.coordinates : []
    const lon = num(coords[0])
    const lat = num(coords[1])
    const dept = typeof c.codeDepartement === 'string' && /^[0-9AB]{2,3}$/.test(c.codeDepartement) ? c.codeDepartement : ''
    out.push({ city, insee, dept, lat, lon })
    if (out.length === 6) break
  }
  return out
}

// ── La dernière visite, par compte, sur cet appareil ───────────────────────

/** `jobbly:last-visit` → la visite précédente de ce compte, ou null. */
export function readLastVisit(raw, userId) {
  try {
    const m = JSON.parse(raw || '{}')
    const v = m && typeof m === 'object' ? m[userId] : null
    return isoOrNull(v)
  } catch (e) {
    return null
  }
}

/** La valeur à réécrire : cette visite pour ce compte, cinq comptes au plus. */
export function nextLastVisit(raw, userId, nowIso) {
  let m = {}
  try { m = JSON.parse(raw || '{}') || {} } catch (e) { m = {} }
  if (typeof m !== 'object' || Array.isArray(m)) m = {}
  delete m[userId]
  const entries = Object.entries(m).filter(([, v]) => isoOrNull(v)).slice(-4)
  entries.push([userId, nowIso])
  return JSON.stringify(Object.fromEntries(entries))
}

/** Le code d'une erreur d'authentification de Supabase → une clé de texte. */
export function authErrorKey(error) {
  if (!error) return 'auth.err_generic'
  const code = typeof error.code === 'string' ? error.code : ''
  const msg = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  const status = typeof error.status === 'number' ? error.status : null
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return 'auth.err_credentials'
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return 'auth.err_unconfirmed'
  if (code === 'user_already_exists' || msg.includes('already registered')) return 'auth.err_exists'
  if (code === 'weak_password' || msg.includes('password should')) return 'auth.err_weak'
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) return 'auth.err_rate'
  if (status === 0 || error.name === 'AuthRetryableFetchError' || msg.includes('failed to fetch')) return 'auth.err_network'
  return 'auth.err_generic'
}
