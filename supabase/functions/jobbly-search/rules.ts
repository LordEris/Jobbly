// ────────────────────────────────────────────────────────────────────────────
// Règles pures de la fonction `jobbly-search` : ce qu'elle accepte, comment
// elle lit les cinq sources, comment elle regroupe les doublons, comment elle
// juge un lien et comment elle fusionne avec les offres déjà rangées. Aucun
// appel réseau, aucune API Deno : c'est ce qui permet de les éprouver avec
// Node (`node --test`, voir les fichiers `*.test.ts` à côté).
//
// Deux règles tiennent tout le fichier :
//   · ce qui arrive des sources est hostile — chaque champ est relu, typé,
//     nettoyé et borné ; un champ absent vaut vide, jamais une valeur devinée ;
//   · deux offres ne fusionnent que si rien ne dit qu'elles sont différentes :
//     deux identifiants France Travail, deux entreprises, deux départements
//     suffisent à les garder à part, même par un tiers (regroupement
//     transitif contrôlé à l'échelle du groupe).
//
// Aucun lookbehind, aucune classe de propriété Unicode, aucun échappement
// Unicode (barre oblique et « u ») dans ce fichier : le canal de déploiement
// des Edge Functions décode ces échappements, et les caractères invisibles se
// retirent donc par leur code, pas par un motif.
// ────────────────────────────────────────────────────────────────────────────

/** L'adresse publiée du site, la seule origine admise en CORS. */
export const WEB_ORIGIN = 'https://jobbly.lorderis.dev';
export const WEB_ORIGINS: readonly string[] = [WEB_ORIGIN];

// ── Les sources ──────────────────────────────────────────────────────────────
// Les noms sont ceux que le script affichait, et ceux que le site affiche :
// clés de `sources` dans la réponse, valeurs de `data.source` et
// `data.sources`. L'ordre est la priorité : la première source d'un groupe
// de doublons en donne le titre, le lien principal et l'identifiant.
export const SOURCES = ['France Travail', 'La Bonne Alternance', 'Jooble', 'Careerjet', 'Adzuna'] as const;
export type SourceName = (typeof SOURCES)[number];

export function sourcePriority(s: SourceName): number {
  return SOURCES.indexOf(s);
}

// ── Les limites ──────────────────────────────────────────────────────────────
/** Recherches par compte et par jour, et pour tous (le garde-fou des clés du propriétaire). */
export const USER_DAILY_LIMIT = 30;
export const GLOBAL_DAILY_LIMIT = 2000;

/** Budget des sources (toutes en parallèle) et délais d'un appel. */
export const SOURCES_BUDGET_MS = 60_000;
export const CALL_TIMEOUT_MS = 15_000;
export const LBA_TIMEOUT_MS = 20_000;
export const TOKEN_TIMEOUT_MS = 10_000;
export const DETAIL_TIMEOUT_MS = 10_000;
/** Descriptions détaillées France Travail : seulement s'il reste ce temps, et au plus ce nombre. */
export const DETAIL_RESERVE_MS = 8_000;
export const MAX_DETAILS = 80;
/** Appels simultanés par source : France Travail limite son débit par application. */
export const SOURCE_CONCURRENCY: Record<SourceName, number> = {
  'France Travail': 3,
  'La Bonne Alternance': 2,
  Jooble: 3,
  Careerjet: 3,
  Adzuna: 3,
};

/** Vérification des liens : budget, parallélisme, délai d'un lien, budget total. */
export const LINK_BUDGET = 150;
export const LINK_CONCURRENCY = 10;
export const LINK_TIMEOUT_MS = 8_000;
export const LINKS_BUDGET_MS = 45_000;
export const LINK_MAX_REDIRECTS = 6;
export const LINK_MAX_BODY_BYTES = 128 * 1024;
/** Durées du cache commun : un lien vivant est revu chaque jour, un lien mort au bout d'un mois. */
export const LINK_OK_TTL_MS = 24 * 3600_000;
export const LINK_DEAD_TTL_MS = 30 * 24 * 3600_000;

/** Taille d'une réponse de source lue, au plus. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
/** Offres brutes gardées au plus (bornent le regroupement, qui est quadratique par bloc). */
export const MAX_RAW_OFFERS = 3000;
/** `jobbly.offers.data` : 64 Ko au plus côté base ; on reste en dessous. */
export const MAX_DATA_BYTES = 60 * 1024;
/** Corps de la requête : `{}`. */
export const MAX_BODY_BYTES = 1024;

// ── Les codes ────────────────────────────────────────────────────────────────
export type ErrorCode =
  | 'method_not_allowed'
  | 'invalid_request'
  | 'not_authenticated'
  | 'no_settings'
  | 'quota'
  | 'not_configured'
  | 'storage_limit'
  | 'save_failed';

/**
 * Statut HTTP de chaque refus. `no_settings`, `quota` et `storage_limit`
 * (le plafond d'offres d'un compte, levé par la base) sont des réponses
 * normales (200) portant `ok: false` : le site les lit comme un résultat,
 * `functions.invoke` compris, qui ne rend pas le corps d'une réponse en
 * erreur.
 */
export const STATUS: Record<ErrorCode, number> = {
  method_not_allowed: 405,
  invalid_request: 400,
  not_authenticated: 401,
  no_settings: 200,
  quota: 200,
  storage_limit: 200,
  not_configured: 503,
  save_failed: 500,
};

/**
 * Le plafond d'offres par compte (20 000 offres, 128 Mio) lève l'une de ces
 * exceptions dans la base (`jobbly.check_offer_limits`) : un refus, jamais un
 * succès.
 */
export function isStorageLimit(message: unknown): boolean {
  return typeof message === 'string' && (message.includes('offer_limit_exceeded') || message.includes('storage_limit_exceeded'));
}

/** Code d'une source : un nombre d'offres, ou ce qui l'en a empêchée. */
export type SourceCode = number | 'not_configured' | 'skipped' | 'timeout' | 'error' | `http_${number}`;

// ── CORS : le site, et lui seul ──────────────────────────────────────────────
// Jamais `*` : n'importe quel site pourrait sinon lancer des recherches avec
// la session d'un visiteur connecté et vider son quota. Les en-têtes admis
// sont ceux qu'envoie supabase-js.
const ALLOWED_REQUEST_HEADERS = [
  'authorization',
  'x-client-info',
  'apikey',
  'content-type',
  'x-region',
  'x-retry-count',
  'traceparent',
  'tracestate',
  'baggage',
].join(', ');

export function corsHeaders(origin: string | null): Record<string, string> {
  // `Vary` toujours : une réponse mise en cache pour une origine ne doit pas
  // resservir à une autre.
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (!origin || !WEB_ORIGINS.includes(origin)) return headers;
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = ALLOWED_REQUEST_HEADERS;
  headers['Access-Control-Max-Age'] = '86400';
  return headers;
}

/** Le corps attendu est `{}` (ou rien). Tout autre champ est refusé : on ne lit rien du client. */
export function validateBody(text: string): boolean {
  if (text.trim() === '') return true;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  return isObject(v) && Object.keys(v).length === 0;
}

// ── Texte ────────────────────────────────────────────────────────────────────

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Contrôles, formats invisibles, séparateurs de ligne : retirés par leur code, sans motif. */
function invisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', laquo: '"', raquo: '"', hellip: '...', ndash: '-', mdash: '-',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', ccedil: 'ç',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', uuml: 'ü', oelig: 'œ',
  Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç', bull: '-', middot: '·', euro: 'EUR',
};

/** Décode les entités HTML courantes ; une entité inconnue reste telle quelle. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Retire les balises (les agrégateurs surlignent en `<b>`), décode les entités. */
export function stripTags(s: string): string {
  return decodeEntities(
    s
      .replace(/<(script|style)\b[\s\S]*?<\/(script|style)\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  );
}

/** Texte d'une source : sans balise, sans invisible, espaces réduits, coupé. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const chars = Array.from(stripTags(v)).map((ch) => (invisible(ch.codePointAt(0) ?? 0) ? ' ' : ch));
  const s = chars.join('').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}

/** Comme `cleanText`, mais garde les retours à la ligne d'une description. */
export function cleanLongText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const chars = Array.from(stripTags(v)).map((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x0a) return '\n';
    return invisible(c) ? ' ' : ch;
  });
  const s = chars
    .join('')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(s).slice(0, max).join('');
}

/** Une date lue : `AAAA-MM-JJ` (ISO ou date HTTP), sinon vide. */
export function cleanDate(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  if (s.length > 64 || !/[a-zA-Z]{3}/.test(s)) return '';
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  const out = new Date(t).toISOString().slice(0, 10);
  return out >= '2000-01-01' && out <= '2100-12-31' ? out : '';
}

/** Le jour du serveur (UTC). */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ── URL ──────────────────────────────────────────────────────────────────────

/** Une adresse http(s) absolue, sans identifiants, sinon vide. */
export function safeHttpUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length === 0 || s.length > 2048) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.username || u.password || !u.hostname) return '';
  return u.toString();
}

/** Paramètres de pistage retirés toujours. */
const TRACKING_ALWAYS = new Set(['gclid', 'fbclid', 'xtor', 'trk', 'tracking', 'cmp', 'campaign']);
/**
 * Paramètres retirés quand leur valeur ne porte pas de chiffre : `ref=jooble`
 * est du pistage, `ref=123456` est souvent l'identifiant de l'offre, et le
 * retirer ferait passer deux offres du même site pour une seule.
 */
const TRACKING_WORDS = new Set(['ref', 'from', 'source', 'src', 'origin']);

function isTrackingParam(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith('utm_') || k.startsWith('at_')) return true;
  if (TRACKING_ALWAYS.has(k)) return true;
  if (TRACKING_WORDS.has(k)) return !/[0-9]/.test(value);
  return false;
}

/**
 * L'adresse canonique d'une offre : https, hôte en minuscules sans `www.`,
 * sans port par défaut, sans ancre ni barre finale, sans pistage, autres
 * paramètres triés. Vide pour une adresse illisible. Elle sert à reconnaître
 * deux fois la même page, et de clé (hachée) au cache des liens.
 */
export function canonicalUrl(v: unknown): string {
  const s = safeHttpUrl(v);
  if (!s) return '';
  const u = new URL(s);
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  let path = u.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  const params: [string, string][] = [];
  for (const [k, val] of u.searchParams) if (!isTrackingParam(k, val)) params.push([k, val]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = params.length ? '?' + params.map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`).join('&') : '';
  return `https://${host}${port}${path}${query}`;
}

// ── Empreintes ───────────────────────────────────────────────────────────────

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'identifiant d'une offre, comme `make_id` du script : les statuts suivent d'une recherche à l'autre. */
export async function makeId(url: string, title: string): Promise<string> {
  return (await sha256Hex(`${url}|${title}`)).slice(0, 32);
}

// ── Réglages ─────────────────────────────────────────────────────────────────

export interface SearchLocation {
  city: string;
  radius: number;
  insee: string;
  lat: number | null;
  lon: number | null;
}
export interface Settings {
  keywords: string[];
  locations: SearchLocation[];
  contractTypes: string[];
}

/**
 * Relit la ligne de `jobbly.settings`. La base en tient déjà la forme ; la
 * relire ici coûte peu et garde la fonction juste si une contrainte change.
 * `null` : rien d'utilisable.
 */
export function parseSettings(row: unknown): Settings | null {
  if (!isObject(row)) return null;
  const kwRaw = row.keywords;
  const locRaw = row.locations;
  if (!Array.isArray(kwRaw) || !Array.isArray(locRaw)) return null;
  const keywords: string[] = [];
  for (const k of kwRaw.slice(0, 10)) {
    const s = cleanText(k, 60);
    if (Array.from(s).length >= 2 && !keywords.includes(s)) keywords.push(s);
  }
  const locations: SearchLocation[] = [];
  for (const l of locRaw.slice(0, 5)) {
    if (!isObject(l)) continue;
    const city = cleanText(l.city, 80);
    const radius = typeof l.radius === 'number' && Number.isInteger(l.radius) ? l.radius : NaN;
    if (!city || !(radius >= 1 && radius <= 100)) continue;
    const insee = typeof l.insee === 'string' && /^[0-9AB]{5}$/.test(l.insee) ? l.insee : '';
    const lat = typeof l.lat === 'number' && Number.isFinite(l.lat) && l.lat >= -90 && l.lat <= 90 ? l.lat : null;
    const lon = typeof l.lon === 'number' && Number.isFinite(l.lon) && l.lon >= -180 && l.lon <= 180 ? l.lon : null;
    locations.push({ city, radius, insee, lat: lat !== null && lon !== null ? lat : null, lon: lat !== null && lon !== null ? lon : null });
  }
  const contractTypes: string[] = [];
  if (Array.isArray(row.contract_types)) {
    for (const c of row.contract_types.slice(0, 20)) {
      if (typeof c === 'string' && /^[A-Z0-9]{1,10}$/.test(c) && !contractTypes.includes(c)) contractTypes.push(c);
    }
  }
  if (!keywords.length || !locations.length) return null;
  return { keywords, locations, contractTypes };
}

// ── Les offres lues aux sources ──────────────────────────────────────────────

export interface RawOffer {
  source: SourceName;
  title: string;
  company: string;
  location: string;
  url: string;
  date: string;
  expires: string;
  summary: string;
  contract: string;
  /** Identifiant France Travail : deux identifiants différents, deux offres. */
  ftId: string;
}

const MAX_TITLE = 200;
const MAX_COMPANY = 100;
const MAX_LOCATION = 100;
const MAX_CONTRACT = 80;
const MAX_SUMMARY = 12_000;

function offer(
  source: SourceName,
  f: { title: unknown; company: unknown; location: unknown; url: unknown; date: unknown; expires?: unknown; summary: unknown; contract: unknown; ftId?: string },
  fallbackLocation: string,
): RawOffer | null {
  const title = cleanText(f.title, MAX_TITLE);
  if (!title) return null;
  return {
    source,
    title,
    company: cleanText(f.company, MAX_COMPANY),
    location: cleanText(f.location, MAX_LOCATION) || cleanText(fallbackLocation, MAX_LOCATION),
    url: safeHttpUrl(f.url),
    date: cleanDate(f.date),
    expires: cleanDate(f.expires),
    summary: cleanLongText(f.summary, MAX_SUMMARY),
    contract: cleanText(f.contract, MAX_CONTRACT),
    ftId: f.ftId ?? '',
  };
}

const get = (o: unknown, ...path: string[]): unknown => {
  let cur: unknown = o;
  for (const p of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
};

/** Le premier texte non vide parmi des candidats (les sources changent de forme d'une version à l'autre). */
function firstText(...vs: unknown[]): unknown {
  for (const v of vs) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/** Une réponse illisible rend `null` : la source est en `error`, pas à zéro offre. */
export function parseFranceTravail(json: unknown, city: string): RawOffer[] | null {
  if (!isObject(json)) return null;
  const list = json.resultats;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const out: RawOffer[] = [];
  for (const o of list.slice(0, 50)) {
    if (!isObject(o)) continue;
    const id = typeof o.id === 'string' && /^[A-Za-z0-9]{3,20}$/.test(o.id) ? o.id : '';
    const origin = safeHttpUrl(get(o, 'origineOffre', 'urlOrigine'));
    const url = origin || (id ? `https://candidat.francetravail.fr/offres/recherche/detail/${id}` : '');
    const r = offer(
      'France Travail',
      {
        title: o.intitule,
        company: get(o, 'entreprise', 'nom'),
        location: get(o, 'lieuTravail', 'libelle'),
        url,
        date: o.dateCreation,
        expires: o.dateEcheance,
        summary: o.description,
        contract: o.typeContratLibelle,
        ftId: id,
      },
      city,
    );
    if (r) out.push(r);
  }
  return out;
}

/** La description d'une offre lue par l'adresse de détail ; vide si illisible. */
export function parseFranceTravailDetail(json: unknown): string {
  return isObject(json) ? cleanLongText(json.description, MAX_SUMMARY) : '';
}

/** Le jeton France Travail : `{token, expiresIn}` (secondes), ou `null`. */
export function parseFtToken(json: unknown): { token: string; expiresIn: number } | null {
  if (!isObject(json)) return null;
  const token = typeof json.access_token === 'string' ? json.access_token.trim() : '';
  if (!token || token.length > 4096 || /\s/.test(token)) return null;
  const e = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) ? json.expires_in : 1200;
  return { token, expiresIn: Math.max(60, Math.min(e, 24 * 3600)) };
}

/**
 * La Bonne Alternance. Le script lisait `title`, `description`,
 * `publication.creation` à la racine de l'offre ; l'API publiée les range
 * aussi sous `offer` : les deux formes sont lues.
 */
export function parseLba(json: unknown, city: string): RawOffer[] | null {
  if (!isObject(json)) return null;
  const list = json.jobs;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: RawOffer[] = [];
  for (const o of list.slice(0, 150)) {
    if (!isObject(o)) continue;
    const ct = get(o, 'contract', 'type');
    const contract = Array.isArray(ct) ? ct.filter((x) => typeof x === 'string').join(', ') : ct;
    const r = offer(
      'La Bonne Alternance',
      {
        title: firstText(o.title, get(o, 'offer', 'title')),
        company: firstText(get(o, 'workplace', 'name'), get(o, 'workplace', 'legal_name'), get(o, 'apply', 'company')),
        location: firstText(get(o, 'workplace', 'location', 'city'), get(o, 'workplace', 'location', 'address')),
        url: get(o, 'apply', 'url'),
        date: firstText(get(o, 'publication', 'creation'), get(o, 'offer', 'publication', 'creation')),
        expires: firstText(get(o, 'publication', 'expiration'), get(o, 'offer', 'publication', 'expiration')),
        summary: firstText(o.description, get(o, 'offer', 'description')),
        contract: (typeof contract === 'string' && contract.trim()) || 'Alternance',
      },
      city,
    );
    if (r) out.push(r);
  }
  return out;
}

const KEYWORD_STOPWORDS = new Set(['de', 'du', 'le', 'la', 'les', 'en', 'et', 'un', 'une', 'au', 'aux']);

/**
 * Au moins un mot significatif d'un mot-clé dans le titre ou le résumé
 * (`_jooble_relevant` du script). Jooble rend des offres voisines ; La Bonne
 * Alternance est interrogée par codes ROME fixes (ceux du script, plomberie)
 * et ne garde donc que ce qui parle des mots-clés de la personne.
 */
export function relevant(title: string, summary: string, keywords: string[]): boolean {
  const text = (title + ' ' + summary).toLowerCase();
  for (const k of keywords) {
    const words = k.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !KEYWORD_STOPWORDS.has(w));
    if (words.some((w) => text.includes(w))) return true;
  }
  return false;
}

export function parseJooble(json: unknown, city: string, keyword: string): RawOffer[] | null {
  if (!isObject(json)) return null;
  const list = json.jobs;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: RawOffer[] = [];
  for (const o of list.slice(0, 30)) {
    if (!isObject(o)) continue;
    const r = offer(
      'Jooble',
      { title: o.title, company: o.company, location: o.location, url: o.link, date: o.updated, summary: o.snippet, contract: o.type },
      city,
    );
    if (r && relevant(r.title, r.summary, [keyword])) out.push(r);
  }
  return out;
}

export function parseCareerjet(json: unknown, city: string): RawOffer[] | null {
  if (!isObject(json)) return null;
  const list = json.jobs;
  // Careerjet rend `type: "LOCATIONS"` quand la ville est ambiguë : aucune offre, pas une panne.
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: RawOffer[] = [];
  for (const o of list.slice(0, 30)) {
    if (!isObject(o)) continue;
    const r = offer(
      'Careerjet',
      { title: o.title, company: o.company, location: o.locations, url: o.url, date: o.date, summary: o.description, contract: o.contract_type },
      city,
    );
    if (r) out.push(r);
  }
  return out;
}

export function parseAdzuna(json: unknown, city: string): RawOffer[] | null {
  if (!isObject(json)) return null;
  const list = json.results;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const out: RawOffer[] = [];
  for (const o of list.slice(0, 50)) {
    if (!isObject(o)) continue;
    const rawId = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '';
    const id = /^[0-9A-Za-z_-]{1,40}$/.test(rawId) ? rawId : '';
    const area = get(o, 'location', 'area');
    const areaLast = Array.isArray(area) && typeof area[area.length - 1] === 'string' ? (area[area.length - 1] as string) : '';
    const display = get(o, 'location', 'display_name');
    const loc = [typeof display === 'string' ? display : '', areaLast].filter((x) => x.trim()).join(', ');
    const r = offer(
      'Adzuna',
      {
        title: o.title,
        company: get(o, 'company', 'display_name'),
        location: loc,
        url: id ? `https://www.adzuna.fr/details/${id}` : o.redirect_url,
        date: o.created,
        summary: o.description,
        contract: firstText(o.contract_type, o.contract_time),
      },
      city,
    );
    if (r) out.push(r);
  }
  return out;
}

/** Une offre dont l'échéance est passée n'est pas gardée. */
export function notExpired(o: RawOffer, today: string): boolean {
  return !o.expires || o.expires >= today;
}

// ── Normalisation ────────────────────────────────────────────────────────────

const LIGATURES: Record<string, string> = { 'œ': 'oe', 'æ': 'ae', 'ß': 'ss' };

/** Minuscules, accents retirés, ponctuation gardée : la base des motifs de genre. */
function lowerAscii(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFD').toLowerCase()) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue;
    out += LIGATURES[ch] ?? ch;
  }
  return out;
}

/** Ne garde que lettres et chiffres, en mots séparés d'une espace. */
export function fold(s: string): string {
  let out = '';
  for (const ch of lowerAscii(s)) {
    const c = ch.codePointAt(0) ?? 0;
    out += (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ? ch : ' ';
  }
  return out.replace(/ +/g, ' ').trim();
}

/** Les mots vides du script (`_STOPWORDS`), et les mots de contrat. */
const STOPWORDS = new Set([
  'h/f', 'f/h', 'hf', 'fh', 'hfx', 'fhx', 'cdi', 'cdd', 'alternance', 'apprentissage', 'stage', 'interim',
  'contrat', 'poste', 'offre', 'emploi', 'recherche', 'urgent',
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'en', 'et', 'ou',
  'au', 'aux', 'ce', 'se', 'sa', 'son', 'ses', 'nous', 'vous', 'ils',
  'elles', 'que', 'qui', 'sur', 'par', 'pour', 'dans', 'avec', 'est',
  'sont', 'avoir', 'faire', 'plus', 'tout', 'tous', 'bien', 'votre',
  'notre', 'vos', 'nos', 'leur', 'leurs', 'pas', 'ne', 'si', 'tres',
]);

/** Mentions de genre retirées avant tout : `H/F`, `(F/H)`, `h/f/x`, `homme/femme`, `(e)`, `·e`. */
function dropGender(lower: string): string {
  return lower
    .replace(/\b(homme|femme)\s*[/|-]\s*(femme|homme)\b/g, ' ')
    .replace(/\b[hf]\s*[/|\\-]\s*[hf](\s*[/|\\-]\s*(x|n|d|nb))?\b/g, ' ')
    .replace(/\((e|ne|le|te|se|ere|euse|rice|trice)\)/g, '')
    .replace(/([a-z]{3})[·.](e|ne|le|te|ere|euse|rice|trice)\b/g, '$1');
}

/** Les mots d'un texte, à la manière de `_normalize` du script (mots de plus de deux lettres, hors mots vides). */
export function words(text: string): string[] {
  return fold(dropGender(lowerAscii(text)))
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Mots du lieu d'une offre (la ville, sans code), et des villes cherchées : retirés du titre. */
export function placeWords(location: string): string[] {
  const head = location.split(',')[0] ?? '';
  return fold(head)
    .split(' ')
    .filter((w) => w.length > 2 && !/^[0-9]+$/.test(w) && w !== 'cedex');
}

/**
 * Le titre normalisé : accents, casse, ponctuation, genre, contrat, mots
 * vides, nombres (codes postaux, départements) et noms de lieu retirés.
 */
export function titleWords(title: string, location: string, extraPlaces: readonly string[] = []): string[] {
  const places = new Set([...placeWords(location), ...extraPlaces.flatMap((p) => placeWords(p))]);
  const out: string[] = [];
  for (const w of words(title)) {
    if (/^[0-9]+$/.test(w) || places.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

const LEGAL_FORMS = new Set(['sas', 'sasu', 'sarl', 'sa', 'eurl', 'sci', 'scop', 'snc']);
const COMPANY_NOISE = new Set(['groupe', 'group', 'france', 'ets', 'etablissements', 'etablissement', 'societe', 'cie']);
/** Ce que les agrégateurs écrivent à la place d'une entreprise : vaut « inconnue ». */
const NO_COMPANY = new Set(['confidentiel', 'confidentielle', 'entreprise confidentielle', 'anonyme', 'non communique', 'non renseigne', 'n a', 'na']);

/** L'entreprise normalisée, en mots ; vide si inconnue. */
export function companyWords(company: string): string[] {
  const raw = fold(company).split(' ').filter(Boolean);
  // « S.A.R.L. » devient « s a r l » : on recolle les lettres seules.
  const glued: string[] = [];
  let letters = '';
  for (const w of raw) {
    if (w.length === 1) {
      letters += w;
      continue;
    }
    if (letters) glued.push(letters);
    letters = '';
    glued.push(w);
  }
  if (letters) glued.push(letters);
  if (NO_COMPANY.has(glued.join(' '))) return [];
  return glued.filter((w) => !LEGAL_FORMS.has(w) && !COMPANY_NOISE.has(w) && !STOPWORDS.has(w));
}

export interface Place {
  dept: string;
  city: string;
}

function validDept(d: string): string {
  const x = d.toLowerCase();
  if (x === '2a' || x === '2b') return '20';
  if (/^97[1-6]$/.test(x)) return x;
  if (/^[0-9]{2}$/.test(x) && x !== '00' && Number(x) <= 95) return x;
  return '';
}

/** Le département (tiré du code postal, ou de « 45 - Orléans », « Orléans (45) ») et la ville normalisée. */
export function placeOf(location: string): Place {
  const s = location.trim();
  let dept = '';
  const cp = /\b([0-9]{5})\b/.exec(s);
  if (cp) dept = validDept(cp[1].startsWith('97') ? cp[1].slice(0, 3) : cp[1].slice(0, 2));
  if (!dept) {
    const lead = /^\s*([0-9]{2,3}|2[abAB])\s*-\s*/.exec(s);
    if (lead) dept = validDept(lead[1]);
  }
  if (!dept) {
    const paren = /\(\s*([0-9]{2,3}|2[abAB])\s*\)/.exec(s);
    if (paren) dept = validDept(paren[1]);
  }
  const head = (s.split(',')[0] ?? '').replace(/^\s*([0-9]{2,3}|2[abAB])\s*-\s*/, '').replace(/\([^)]*\)/g, ' ');
  const city = fold(head)
    .split(' ')
    .filter((w) => w && !/^[0-9]+$/.test(w) && w !== 'cedex' && w !== 'arrondissement' && w !== 'er' && w !== 'e' && w !== 'eme')
    .map((w) => (w === 'st' ? 'saint' : w === 'ste' ? 'sainte' : w))
    .join(' ');
  return { dept, city };
}

/** Lieux compatibles : même département, ou à défaut même ville, ou l'un inconnu. */
export function placesCompatible(a: Place, b: Place): boolean {
  if (a.dept && b.dept) return a.dept === b.dept;
  if (a.city && b.city) return a.city === b.city;
  return true;
}

/** Les deux lieux se disent le même, l'un et l'autre connus (département ou ville). */
function placesSame(a: Place, b: Place): boolean {
  if (a.dept && b.dept) return a.dept === b.dept;
  return !!a.city && !!b.city && a.city === b.city;
}

function subset(a: string[], b: string[]): boolean {
  return a.every((w) => b.includes(w));
}

/** Entreprises compatibles : égales, l'une contient l'autre (en mots), ou l'une inconnue. */
export function companiesCompatible(a: string[], b: string[]): boolean {
  if (!a.length || !b.length || a === b) return true;
  return subset(a, b) || subset(b, a);
}

/** max(Jaccard, recouvrement), la mesure du script (`_similarity`). */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of small) if (big.has(w)) inter++;
  return Math.max(inter / (a.size + b.size - inter), inter / small.size);
}

export const TITLE_THRESHOLD = 0.85;
export const CONTENT_THRESHOLD = 0.55;
export const MIN_WORDS_FOR_CONTENT_MATCH = 12;

// ── Regroupement ─────────────────────────────────────────────────────────────

interface Item {
  index: number;
  raw: RawOffer;
  prio: number;
  canon: string;
  title: string[];
  titleSet: Set<string>;
  titleKey: string;
  company: string[];
  place: Place;
  content: Set<string>;
}

/** Pourquoi deux offres ont fusionné : 1 même adresse, 2 même titre, 3 même contenu. */
export type MergeRule = 1 | 2 | 3;

export interface DedupeResult {
  /** Les groupes, chacun en ordre de priorité ; le premier est la représentante. */
  groups: RawOffer[][];
  merges: Record<MergeRule, number>;
}

/** Au-delà de ce nombre d'offres qui l'emploient, un mot de description ne sert plus à trouver des candidates. */
export const RARE_DF = 60;
const EMPTY: Set<string> = new Set();

function postings(items: Item[], wordsOf: (it: Item) => Set<string>): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const it of items) for (const w of wordsOf(it)) {
    const list = index.get(w);
    if (list) list.push(it.index);
    else index.set(w, [it.index]);
  }
  return index;
}

function prepare(raw: RawOffer[], extraPlaces: readonly string[]): Item[] {
  // Les mêmes mots d'entreprise partagent le même tableau : la comparaison la plus fréquente devient `===`.
  const interned = new Map<string, string[]>();
  const intern = (w: string[]): string[] => {
    const k = w.join(' ');
    const hit = interned.get(k);
    if (hit) return hit;
    interned.set(k, w);
    return w;
  };
  return raw.map((r, index) => {
    const title = titleWords(r.title, r.location, extraPlaces);
    return {
      index,
      raw: r,
      prio: sourcePriority(r.source),
      canon: canonicalUrl(r.url),
      title,
      titleSet: new Set(title),
      titleKey: [...title].sort().join(' '),
      company: intern(companyWords(r.company)),
      place: placeOf(r.location),
      content: new Set(words(r.summary)),
    };
  });
}

/** Deux offres d'une paire sont-elles compatibles ? (rien ne dit qu'elles diffèrent) */
function pairCompatible(a: Item, b: Item): boolean {
  if (a.raw.ftId && b.raw.ftId && a.raw.ftId !== b.raw.ftId) return false;
  return companiesCompatible(a.company, b.company) && placesCompatible(a.place, b.place);
}

/**
 * Regroupe les doublons. Trois règles, appliquées dans cet ordre, chacune
 * unissant deux groupes seulement si TOUTES leurs offres restent deux à deux
 * compatibles — c'est ce qui rend le regroupement transitif sans laisser une
 * offre sans entreprise relier deux entreprises différentes :
 *   1. même adresse canonique (et un mot du titre en commun) ;
 *   2. titres normalisés égaux, ou semblables à 0,85 avec au moins deux mots,
 *      entreprises et lieux compatibles ; deux offres sans entreprise
 *      demandent en plus un titre égal et le même lieu, connu des deux ;
 *   3. contenus semblables (≥ 12 mots, ≥ 0,55), un mot du titre en commun,
 *      entreprises et lieux compatibles.
 * Deux identifiants France Travail ne sont jamais dans le même groupe : la
 * source les tient pour deux offres.
 */
export function dedupe(raw: RawOffer[], extraPlaces: readonly string[] = []): DedupeResult {
  const items = prepare(raw, extraPlaces);
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const merges: Record<MergeRule, number> = { 1: 0, 2: 0, 3: 0 };
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number, rule: MergeRule): void => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    for (const x of members[a]) for (const y of members[b]) if (!pairCompatible(items[x], items[y])) return;
    const [keep, drop] = a < b ? [a, b] : [b, a];
    parent[drop] = keep;
    members[keep] = members[keep].concat(members[drop]);
    members[drop] = [];
    merges[rule]++;
  };
  const shareTitleWord = (a: Item, b: Item): boolean => {
    for (const w of a.titleSet) if (b.titleSet.has(w)) return true;
    return false;
  };

  // 1. Même adresse.
  const byUrl = new Map<string, number>();
  for (const it of items) {
    if (!it.canon) continue;
    const first = byUrl.get(it.canon);
    if (first === undefined) byUrl.set(it.canon, it.index);
    else if (shareTitleWord(items[first], it) || !items[first].title.length || !it.title.length) union(first, it.index, 1);
  }

  // Les candidates. Comparer toutes les paires qui partagent un mot du titre
  // coûte trop quand toutes les offres disent « plombier » (la fonction a
  // deux secondes de calcul). On indexe donc chaque offre par ses mots les
  // plus rares :
  //   · règle 2 : ses deux mots de titre les plus rares. Deux titres
  //     semblables à 0,85 de moins de 14 mots ont au plus un mot d'écart sur
  //     le plus court : l'un des deux plus rares est forcément commun ;
  //   · règle 3 : ses huit mots de description les plus rares, parmi ceux
  //     qu'au plus RARE_DF offres emploient. Deux descriptions recopiées
  //     partagent leurs mots rares ; un gabarit répété des centaines de fois
  //     ne crée pas de candidates à lui seul (c'est le cas où la règle 3
  //     serait la plus dangereuse).
  const titleDf = new Map<string, number>();
  for (const it of items) for (const w of it.titleSet) titleDf.set(w, (titleDf.get(w) ?? 0) + 1);
  const contentDf = new Map<string, number>();
  for (const it of items) for (const w of it.content) contentDf.set(w, (contentDf.get(w) ?? 0) + 1);
  const byTitle = postings(items, (it) => it.titleSet);
  const byContent = postings(items, (it) => (it.content.size >= MIN_WORDS_FOR_CONTENT_MATCH ? it.content : EMPTY));
  const rarest = (set: Set<string>, df: Map<string, number>, k: number, maxDf: number): string[] =>
    [...set]
      .filter((w) => (df.get(w) ?? 0) <= maxDf)
      .sort((x, y) => (df.get(x) ?? 0) - (df.get(y) ?? 0) || (x < y ? -1 : x > y ? 1 : 0))
      .slice(0, k);
  // Les paires (i < j) sont rangées sous i, puis lues dans l'ordre : le
  // résultat ne dépend pas de l'ordre de découverte.
  const adjacency = (keysOf: (it: Item) => string[] | null, index: Map<string, number[]>, keep: (a: Item, b: Item) => boolean): number[][] => {
    const adj: number[][] = Array.from({ length: n }, () => []);
    const mark = new Int32Array(n).fill(-1);
    for (const it of items) {
      const keys = keysOf(it);
      if (!keys) continue;
      const i = it.index;
      for (const w of keys) for (const j of index.get(w) ?? []) {
        if (j === i || mark[j] === i) continue;
        mark[j] = i;
        if (keep(it, items[j])) adj[Math.min(i, j)].push(Math.max(i, j));
      }
    }
    for (const list of adj) {
      list.sort((x, y) => x - y);
      let w = 0;
      for (let r = 0; r < list.length; r++) if (r === 0 || list[r] !== list[r - 1]) list[w++] = list[r];
      list.length = w;
    }
    return adj;
  };

  // 2. Même titre.
  const adj2 = adjacency((it) => rarest(it.titleSet, titleDf, 2, Infinity), byTitle, () => true);
  for (let i = 0; i < n; i++) {
    const a = items[i];
    for (const j of adj2[i]) {
      const b = items[j];
      if (find(i) === find(j)) continue;
      const equal = a.titleKey === b.titleKey;
      const close = equal || (a.title.length >= 2 && b.title.length >= 2 && similarity(a.titleSet, b.titleSet) >= TITLE_THRESHOLD);
      if (!close || !pairCompatible(a, b)) continue;
      if (!a.company.length && !b.company.length && !(equal && placesSame(a.place, b.place))) continue;
      union(i, j, 2);
    }
  }

  // 3. Même contenu.
  const adj3 = adjacency(
    (it) => (it.content.size >= MIN_WORDS_FOR_CONTENT_MATCH && it.title.length ? rarest(it.content, contentDf, 8, RARE_DF) : null),
    byContent,
    shareTitleWord,
  );
  for (let i = 0; i < n; i++) {
    const a = items[i];
    for (const j of adj3[i]) {
      const b = items[j];
      if (find(i) === find(j) || !pairCompatible(a, b)) continue;
      if (similarity(a.content, b.content) >= CONTENT_THRESHOLD) union(i, j, 3);
    }
  }

  const groups: RawOffer[][] = [];
  for (let i = 0; i < n; i++) {
    if (find(i) !== i) continue;
    const g = members[i].map((k) => items[k]).sort((p, q) => p.prio - q.prio || p.index - q.index);
    groups.push(g.map((it) => it.raw));
  }
  return { groups, merges };
}

// ── L'offre rangée ───────────────────────────────────────────────────────────

export interface OfferLink {
  url: string;
  source: SourceName;
}

/** Ce que `jobbly.offers.data` porte. */
export interface OfferData {
  title: string;
  company: string;
  location: string;
  url: string;
  links: OfferLink[];
  date: string;
  expires: string;
  source: SourceName;
  sources: SourceName[];
  summary: string;
  contract: string;
  link_dead?: boolean;
}

export interface MergedOffer {
  /** L'adresse d'origine de la représentante, qui fait l'identifiant. */
  idUrl: string;
  data: OfferData;
}

/** Fusionne un groupe : la représentante donne titre et lien principal, les autres comblent les vides. */
export function mergeGroup(group: RawOffer[]): MergedOffer {
  const rep = group[0];
  const firstNonEmpty = (k: 'company' | 'location' | 'contract' | 'expires'): string => {
    for (const o of group) if (o[k]) return o[k];
    return '';
  };
  let summary = '';
  let date = '';
  const sources: SourceName[] = [];
  const links: OfferLink[] = [];
  const seenCanon = new Set<string>();
  for (const o of group) {
    if (o.summary.length > summary.length) summary = o.summary;
    if (o.date > date) date = o.date;
    if (!sources.includes(o.source)) sources.push(o.source);
    const c = canonicalUrl(o.url);
    if (c && !seenCanon.has(c)) {
      seenCanon.add(c);
      links.push({ url: o.url, source: o.source });
    }
  }
  const data: OfferData = {
    title: rep.title,
    company: firstNonEmpty('company'),
    location: firstNonEmpty('location'),
    url: links[0]?.url ?? '',
    links: links.slice(0, 10),
    date,
    expires: rep.expires || firstNonEmpty('expires'),
    source: rep.source,
    sources: [...sources].sort((a, b) => sourcePriority(a) - sourcePriority(b)),
    summary,
    contract: firstNonEmpty('contract'),
  };
  return { idUrl: rep.url, data: fitData(data) };
}

/** Garde `data` sous la borne de la base : c'est le résumé qui cède. */
export function fitData(data: OfferData): OfferData {
  const size = (d: OfferData) => new TextEncoder().encode(JSON.stringify(d)).byteLength;
  let d = data;
  while (size(d) > MAX_DATA_BYTES && d.summary.length > 0) {
    d = { ...d, summary: Array.from(d.summary).slice(0, Math.floor(Array.from(d.summary).length / 2)).join('') };
  }
  return d;
}

// ── Liens morts : ce qui se juge sans réseau ─────────────────────────────────

export type LinkState = 'ok' | 'dead' | 'unknown';
export interface LinkVerdict {
  state: LinkState;
  /** Un code court : `http_404`, `dns`, `home`, `search`, `expired`, `timeout`, `blocked`… */
  reason: string;
}

function ipv4Parts(s: string): number[] | null {
  const m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(s);
  if (!m) return null;
  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return p.every((x) => x <= 255) ? p : null;
}

function publicIpv4(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // ce réseau, privé, boucle, multidiffusion, réservé
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // lien local (métadonnées des nuages)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Les 8 groupes d'une IPv6 (forme écrite par l'analyseur d'URL ou par le DNS), sinon `null`. */
function ipv6Groups(s: string): number[] | null {
  let x = s.toLowerCase();
  if (x.startsWith('[') && x.endsWith(']')) x = x.slice(1, -1);
  if (!x.includes(':')) return null;
  const pct = x.indexOf('%');
  if (pct >= 0) x = x.slice(0, pct);
  // `::ffff:10.0.0.1` : la fin en IPv4 devient deux groupes hexadécimaux.
  const lastColon = x.lastIndexOf(':');
  const v4 = ipv4Parts(x.slice(lastColon + 1));
  if (v4) x = x.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  const halves = x.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill(0), ...right];
  } else groups = left;
  return groups.length === 8 ? groups : null;
}

function publicIpv6(g: number[]): boolean {
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicIpv4(embedded); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return publicIpv4(embedded); // ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicIpv4(embedded); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA
  if ((g[0] & 0xffc0) === 0xfe80) return false; // lien local
  if ((g[0] & 0xff00) === 0xff00) return false; // multidiffusion
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // à jeter
  if (g[0] === 0x2002) return publicIpv4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]); // 6to4
  return true;
}

/** Une adresse IP joignable sur Internet (ni privée, ni locale, ni réservée). `false` si ce n'est pas une IP. */
export function isPublicIp(s: string): boolean {
  const v4 = ipv4Parts(s);
  if (v4) return publicIpv4(v4);
  const v6 = ipv6Groups(s);
  return v6 ? publicIpv6(v6) : false;
}

export function isIpLiteral(host: string): boolean {
  return ipv4Parts(host) !== null || ipv6Groups(host) !== null;
}

/**
 * La forme d'une adresse qu'on accepte de visiter, avant même le DNS : http(s),
 * ports par défaut, sans identifiants, un nom public (pas `localhost`, `.local`,
 * `.internal`, ni un nom sans point) ou une IP publique. `null` si refusée.
 */
export function visitableUrl(v: string): URL | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  if (isIpLiteral(host)) return isPublicIp(host) ? u : null;
  if (!host.includes('.') || host.endsWith('.')) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || host.endsWith('.lan')) return null;
  return u;
}

/** Un statut HTTP final, avant de lire le corps : `null` quand il faut continuer (2xx). */
export function statusVerdict(status: number): LinkVerdict | null {
  if (status === 404 || status === 410) return { state: 'dead', reason: `http_${status}` };
  if (status >= 200 && status < 300) return null;
  // 401, 403, 429, 5xx, et tout le reste : on ne peut pas juger, l'offre est gardée.
  return { state: 'unknown', reason: `http_${status}` };
}

/** Jetons qui ressemblent à l'identifiant d'une offre : 5 signes ou plus, dont un chiffre. */
export function idTokens(url: URL): string[] {
  const parts = [...decodeSafe(url.pathname).split(/[^A-Za-z0-9]+/)];
  for (const [, v] of url.searchParams) parts.push(...v.split(/[^A-Za-z0-9]+/));
  return parts.filter((t) => t.length >= 5 && /[0-9]/.test(t)).map((t) => t.toLowerCase());
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const SEARCH_SEGMENTS = new Set([
  'recherche', 'rechercher', 'search', 'resultats', 'results', 'result', 'emplois', 'emploi', 'offres', 'offres-emploi',
  'offres-d-emploi', 'jobs', 'job-search', 'jobsearch', 'liste', 'list', 'listing', 'annonces', 'carrieres', 'careers', 'recrutement',
]);
const SEARCH_PARAMS = new Set(['q', 'query', 'keywords', 'keyword', 'motscles', 'k', 'kw', 'what', 's', 'search']);

/** Un chemin de page d'accueil : `/`, ou une langue seule (`/fr`, `/en-gb`). */
function isHomePath(path: string): boolean {
  const p = path.replace(/\/+$/, '');
  return p === '' || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(p);
}

/**
 * Une redirection qui dit que l'offre n'est plus là : vers la page d'accueil
 * alors que l'adresse d'origine avait un chemin, ou vers une page de
 * recherche ou de liste qui a perdu l'identifiant de l'offre.
 */
export function redirectVerdict(original: string, final: string): LinkVerdict | null {
  let o: URL;
  let f: URL;
  try {
    o = new URL(original);
    f = new URL(final);
  } catch {
    return null;
  }
  if (canonicalUrl(original) === canonicalUrl(final)) return null;
  if (!isHomePath(o.pathname) && isHomePath(f.pathname)) return { state: 'dead', reason: 'home' };
  const ids = idTokens(o);
  if (!ids.length) return null;
  const finalText = (decodeSafe(f.pathname) + ' ' + decodeSafe(f.search)).toLowerCase();
  if (ids.some((id) => finalText.includes(id))) return null;
  // Une page de liste finit par son mot (`/emplois`, `/offres/recherche`) ou
  // porte une requête de recherche ; `/carrieres/plombier-orleans` est une offre.
  const last = f.pathname.toLowerCase().split('/').filter(Boolean).pop() ?? '';
  const searchy = SEARCH_SEGMENTS.has(last.replace(/\.(html?|php|aspx?)$/, '')) || [...f.searchParams.keys()].some((k) => SEARCH_PARAMS.has(k.toLowerCase()));
  return searchy ? { state: 'dead', reason: 'search' } : null;
}

/** Les phrases d'une offre expirée, en FR et en EN (comparées sans accent ni ponctuation). */
export const EXPIRED_PHRASES: readonly string[] = [
  "offre n'est plus disponible",
  "n'est plus en ligne",
  'offre a expiré',
  'offre expirée',
  'a été pourvue',
  "n'existe plus",
  'page introuvable',
  'job is no longer available',
  'this job has expired',
  'no longer accepting applications',
  'position has been filled',
];
const FOLDED_PHRASES = EXPIRED_PHRASES.map((p) => ' ' + fold(p) + ' ');

/** Le texte visible d'un début de page HTML, replié pour la comparaison. */
export function visibleText(html: string): string {
  const cut = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/(script|style|noscript|template)\s*>/gi, ' ')
    // Une balise de script coupée par la limite de lecture : tout ce qui suit est du code.
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return ' ' + fold(decodeEntities(cut.replace(/<[^>]*>/g, ' '))) + ' ';
}

/**
 * Le titre de la page et ses grands intitulés (h1 à h3), repliés. Un site
 * annonce une offre expirée là ; le reste de la page porte des phrases qui
 * ressemblent à une annonce sans en être une — le formulaire « Signaler cette
 * offre » de France Travail, présent sur chaque offre vivante, liste « l'offre
 * n'existe plus sur le site partenaire » parmi ses motifs.
 */
export function headlineText(html: string): string {
  const cut = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/(script|style|noscript|template)\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const parts: string[] = [];
  const re = /<(title|h1|h2|h3)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (let m = re.exec(cut); m; m = re.exec(cut)) parts.push(m[2]);
  return ' ' + fold(decodeEntities(parts.join(' ').replace(/<[^>]*>/g, ' '))) + ' ';
}

export function bodyVerdict(html: string): LinkVerdict | null {
  const text = headlineText(html);
  return FOLDED_PHRASES.some((p) => text.includes(p)) ? { state: 'dead', reason: 'expired' } : null;
}

/** Une ligne du cache encore valable : `ok` 24 h, `dead` 30 jours. */
export function cacheFresh(state: string, checkedAt: string, now: number): LinkState | null {
  const t = Date.parse(checkedAt);
  if (!Number.isFinite(t)) return null;
  if (state === 'ok') return now - t < LINK_OK_TTL_MS ? 'ok' : null;
  if (state === 'dead') return now - t < LINK_DEAD_TTL_MS ? 'dead' : null;
  return null;
}

// ── Fusion avec les offres de la personne ────────────────────────────────────

export interface ExistingOffer {
  id: string;
  status: string;
  blocked: boolean;
  gone_at: string | null;
  /** Les sources qui la rendaient (`data.sources`) ; vide si illisible. */
  sources: SourceName[];
}

export interface FoundOffer {
  id: string;
  data: OfferData;
  /** Tous ses liens vérifiés sont morts. */
  dead: boolean;
}

export interface MergePlan {
  /** Offres nouvelles : `first_seen` et `last_seen` posés maintenant. */
  insert: { id: string; data: OfferData; first_seen: string; last_seen: string; gone_at: null }[];
  /** Offres connues : seuls `data`, `last_seen` et `gone_at` changent. */
  update: { id: string; data: OfferData; last_seen: string; gone_at: null }[];
  /** Connues, plus rendues : `gone_at` posé (si elles ne l'avaient pas). */
  gone: string[];
  /** Mortes, sans statut ni signalement : supprimées. */
  remove: string[];
  counts: { dead_links: number; kept: number; new: number };
}

/**
 * Ce qu'une recherche change aux offres de la personne. Le statut,
 * `status_at`, `blocked` et `first_seen` d'une offre connue ne bougent jamais.
 *
 * `unsure` : les sources qui n'ont pas entièrement répondu (délai, refus,
 * réponse illisible). Une offre qu'elles rendaient n'est pas déclarée
 * disparue : une source muette n'est pas une source vide. Une offre dont on
 * ne sait plus quelles sources la rendaient ne l'est pas non plus dès qu'une
 * source a manqué.
 */
export function planMerge(existing: ExistingOffer[], found: FoundOffer[], nowIso: string, unsure: readonly SourceName[] = []): MergePlan {
  const known = new Map(existing.map((e) => [e.id, e]));
  const plan: MergePlan = { insert: [], update: [], gone: [], remove: [], counts: { dead_links: 0, kept: 0, new: 0 } };
  const rendered = new Set<string>();
  for (const f of found) {
    if (rendered.has(f.id)) continue;
    rendered.add(f.id);
    const e = known.get(f.id);
    if (f.dead) {
      plan.counts.dead_links++;
      if (!e) continue;
      if (e.status === '' && !e.blocked) {
        plan.remove.push(f.id);
        continue;
      }
      plan.update.push({ id: f.id, data: { ...f.data, url: '', link_dead: true }, last_seen: nowIso, gone_at: null });
      plan.counts.kept++;
      continue;
    }
    const data: OfferData = { ...f.data };
    delete data.link_dead;
    if (e) plan.update.push({ id: f.id, data, last_seen: nowIso, gone_at: null });
    else {
      plan.insert.push({ id: f.id, data, first_seen: nowIso, last_seen: nowIso, gone_at: null });
      plan.counts.new++;
    }
    plan.counts.kept++;
  }
  for (const e of existing) {
    if (rendered.has(e.id) || e.gone_at) continue;
    if (unsure.length && (!e.sources.length || e.sources.some((x) => unsure.includes(x)))) continue;
    plan.gone.push(e.id);
  }
  return plan;
}

/** Une ligne de `jobbly.offers` relue pour la fusion ; `null` si illisible. */
export function parseExisting(row: unknown): ExistingOffer | null {
  if (!isObject(row) || typeof row.id !== 'string' || !/^[0-9a-f]{32}$/.test(row.id)) return null;
  return {
    id: row.id,
    status: typeof row.status === 'string' ? row.status : '',
    blocked: row.blocked === true,
    gone_at: typeof row.gone_at === 'string' ? row.gone_at : null,
    sources: Array.isArray(row.sources) ? SOURCES.filter((x) => (row.sources as unknown[]).includes(x)) : [],
  };
}

/** Le code d'une source qui a échoué, à partir de ce qui l'a arrêtée. */
export function failureCode(e: unknown): SourceCode {
  if (typeof e !== 'object' || e === null) return 'error';
  const o = e as { httpStatus?: unknown; name?: unknown };
  if (typeof o.httpStatus === 'number' && Number.isInteger(o.httpStatus) && o.httpStatus >= 100 && o.httpStatus <= 599) return `http_${o.httpStatus}`;
  // Un `DOMException` n'est pas toujours un `Error` : on lit son nom.
  if (o.name === 'TimeoutError' || o.name === 'AbortError') return 'timeout';
  return 'error';
}
