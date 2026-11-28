// ────────────────────────────────────────────────────────────────────────────
// Les cinq sources, appelées comme le faisait `job_alert.py` (mêmes adresses,
// mêmes paramètres, mêmes champs lus). Sans API Deno : `fetch` est passé en
// paramètre, si bien que les tests jouent chaque source contre une imitation
// et que la fonction lui donne le vrai.
//
// Ce qui change par rapport au script, et pourquoi :
//   · toutes les sources partent en parallèle, chacune avec son nombre
//     d'appels simultanés, un délai par appel et un budget commun (~60 s) ;
//     une source qui échoue n'arrête pas les autres et rend un code ;
//   · France Travail rend 206 quand il y a plus de 20 résultats : c'est un
//     succès (le script le prenait pour un échec et ne gardait rien) ;
//   · France Travail n'est pas interrogé pour une ville sans code INSEE : sans
//     `commune`, la recherche est nationale et ignore la ville ;
//   · les descriptions détaillées France Travail ne sont demandées que s'il
//     reste du temps, et pour un nombre borné d'offres ;
//   · La Bonne Alternance garde les codes ROME du script (plomberie) ;
//   · chaque offre, quelle que soit sa source, doit parler du mot-clé
//     cherché (`relevant`) : France Travail, Careerjet et Adzuna élargissent
//     le mot-clé, et « Plombier » rendait des offres de couvreur.
//
// Aucun mot-clé, aucune ville, aucun contenu d'offre dans un message d'erreur
// ou un journal : les échecs rendent un code.
// ────────────────────────────────────────────────────────────────────────────
import {
  CALL_TIMEOUT_MS,
  DETAIL_RESERVE_MS,
  DETAIL_TIMEOUT_MS,
  failureCode,
  LBA_TIMEOUT_MS,
  MAX_DETAILS,
  MAX_RAW_OFFERS,
  MAX_SOURCE_BYTES,
  notExpired,
  parseAdzuna,
  parseCareerjet,
  parseFranceTravail,
  parseFranceTravailDetail,
  parseFtToken,
  parseJooble,
  parseLba,
  type RawOffer,
  relevant,
  type SearchLocation,
  type Settings,
  SOURCE_CONCURRENCY,
  type SourceCode,
  type SourceName,
  SOURCES,
  sourcePriority,
  TOKEN_TIMEOUT_MS,
} from './rules.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Les secrets des sources ; une chaîne vide vaut « absent ». */
export interface SourceKeys {
  ftClientId: string;
  ftClientSecret: string;
  lbaApiKey: string;
  joobleApiKey: string;
  careerjetAffid: string;
  adzunaAppId: string;
  adzunaAppKey: string;
}

export interface SearchDeps {
  fetch: Fetch;
  now: () => number;
  /** Instant (ms) au-delà duquel plus aucun appel ne part. */
  deadline: number;
  /** Le jour (AAAA-MM-JJ) : une offre échue n'est pas gardée. */
  today: string;
}

export interface SearchOutcome {
  offers: RawOffer[];
  sources: Record<SourceName, SourceCode>;
  /** Sources dont un appel au moins a échoué : leurs offres absentes ne sont pas « disparues ». */
  incomplete: SourceName[];
}

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  Accept: 'application/json',
};

/** Fixe le nombre de lectures rendu par une source sans que rien ne fuie : un statut HTTP, jamais le corps. */
export class HttpError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`http_${status}`);
    this.name = 'HttpError';
    this.httpStatus = status;
  }
}

class Timeout extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/** Un appel borné par son délai et par le budget commun ; un statut hors 2xx lève `HttpError`. */
async function call(deps: SearchDeps, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const left = deps.deadline - deps.now();
  if (left <= 0) throw new Timeout();
  const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(timeoutMs, left)) });
  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(res.status);
  }
  return res;
}

/** Lit un JSON borné ; 204 ou corps vide → `null`. Illisible → erreur (la source est en `error`). */
export async function readJson(res: Response, max = MAX_SOURCE_BYTES): Promise<unknown> {
  if (res.status === 204) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error('too_large');
  }
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('too_large');
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/** Exécute des tâches, `n` à la fois, dans l'ordre. */
export async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

// ── France Travail : le jeton, gardé en mémoire du worker ────────────────────

let ftToken: { token: string; expiresAt: number; client: string } | null = null;
let ftTokenPending: Promise<string> | null = null;

/** Pour les tests : oublie le jeton. */
export function resetFtToken(): void {
  ftToken = null;
  ftTokenPending = null;
}

async function franceTravailToken(keys: SourceKeys, deps: SearchDeps): Promise<string> {
  const client = keys.ftClientId;
  if (ftToken && ftToken.client === client && ftToken.expiresAt > deps.now() + 60_000) return ftToken.token;
  // Un seul échange à la fois : les recherches qui partent ensemble attendent le même jeton.
  ftTokenPending ??= (async () => {
    try {
      const res = await call(
        deps,
        'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire',
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(`${keys.ftClientId}:${keys.ftClientSecret}`),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'api_offresdemploiv2 o2dsoffre' }).toString(),
        },
        TOKEN_TIMEOUT_MS,
      );
      const t = parseFtToken(await readJson(res, 64 * 1024));
      if (!t) throw new Error('no_token');
      ftToken = { token: t.token, expiresAt: deps.now() + t.expiresIn * 1000, client };
      return t.token;
    } catch (e) {
      ftToken = null;
      throw e;
    } finally {
      ftTokenPending = null;
    }
  })();
  return ftTokenPending;
}

// ── Les appels, un par source ────────────────────────────────────────────────

async function searchFranceTravail(keys: SourceKeys, deps: SearchDeps, keyword: string, loc: SearchLocation, contractTypes: string[]): Promise<RawOffer[]> {
  const token = await franceTravailToken(keys, deps);
  const params = new URLSearchParams({ motsCles: keyword, distance: String(loc.radius), range: '0-19', commune: loc.insee });
  if (contractTypes.length) params.set('typeContrat', contractTypes.join(','));
  try {
    const res = await call(
      deps,
      `https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?${params}`,
      { headers: { ...HEADERS, Authorization: `Bearer ${token}` } },
      CALL_TIMEOUT_MS,
    );
    const offers = parseFranceTravail(await readJson(res), loc.city, keyword);
    if (!offers) throw new Error('invalid');
    return offers;
  } catch (e) {
    // Un jeton refusé ne resservira pas.
    if (e instanceof HttpError && e.httpStatus === 401) ftToken = null;
    throw e;
  }
}

async function franceTravailDetail(keys: SourceKeys, deps: SearchDeps, ftId: string): Promise<string> {
  const token = await franceTravailToken(keys, deps);
  const res = await call(
    deps,
    `https://api.francetravail.io/partenaire/offresdemploi/v2/offres/${encodeURIComponent(ftId)}`,
    { headers: { ...HEADERS, Authorization: `Bearer ${token}` } },
    DETAIL_TIMEOUT_MS,
  );
  return parseFranceTravailDetail(await readJson(res));
}

async function searchLba(keys: SourceKeys, deps: SearchDeps, loc: SearchLocation, keywords: string[]): Promise<RawOffer[]> {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    radius: String(loc.radius),
    // Les codes ROME du script (`_LBA_ROMES`) : plomberie, chauffage, sanitaire.
    romes: 'F1603,I1310,F1604,I1302',
  });
  const res = await call(
    deps,
    `https://api.apprentissage.beta.gouv.fr/api/job/v1/search?${params}`,
    { headers: { ...HEADERS, Authorization: `Bearer ${keys.lbaApiKey}` } },
    LBA_TIMEOUT_MS,
  );
  const offers = parseLba(await readJson(res), loc.city);
  if (!offers) throw new Error('invalid');
  return offers.filter((o) => relevant(o.title, o.summary, keywords));
}

async function searchJooble(keys: SourceKeys, deps: SearchDeps, keyword: string, loc: SearchLocation): Promise<RawOffer[]> {
  const res = await call(
    deps,
    `https://jooble.org/api/${encodeURIComponent(keys.joobleApiKey)}`,
    {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: keyword, location: loc.city, radius: String(loc.radius), resultonpage: 20 }),
    },
    CALL_TIMEOUT_MS,
  );
  const offers = parseJooble(await readJson(res), loc.city, keyword);
  if (!offers) throw new Error('invalid');
  return offers;
}

async function searchCareerjet(keys: SourceKeys, deps: SearchDeps, keyword: string, loc: SearchLocation): Promise<RawOffer[]> {
  const params = new URLSearchParams({
    keywords: keyword,
    location: loc.city,
    locale_code: 'fr_FR',
    affid: keys.careerjetAffid,
    pagesize: '20',
    sort: 'date',
  });
  const res = await call(deps, `https://public.api.careerjet.net/search?${params}`, { headers: HEADERS }, CALL_TIMEOUT_MS);
  const offers = parseCareerjet(await readJson(res), loc.city, keyword);
  if (!offers) throw new Error('invalid');
  return offers;
}

async function searchAdzuna(keys: SourceKeys, deps: SearchDeps, keyword: string, loc: SearchLocation): Promise<RawOffer[]> {
  const params = new URLSearchParams({
    app_id: keys.adzunaAppId,
    app_key: keys.adzunaAppKey,
    what: keyword,
    where: loc.city,
    distance: String(loc.radius),
    results_per_page: '20',
    'content-type': 'application/json',
    sort_by: 'date',
  });
  const res = await call(deps, `https://api.adzuna.com/v1/api/jobs/fr/search/1?${params}`, { headers: HEADERS }, CALL_TIMEOUT_MS);
  const offers = parseAdzuna(await readJson(res), loc.city, keyword);
  if (!offers) throw new Error('invalid');
  return offers;
}

// ── Toutes les sources ───────────────────────────────────────────────────────

export function configured(keys: SourceKeys): Record<SourceName, boolean> {
  return {
    'France Travail': !!(keys.ftClientId && keys.ftClientSecret),
    'La Bonne Alternance': !!keys.lbaApiKey,
    Jooble: !!keys.joobleApiKey,
    Careerjet: !!keys.careerjetAffid,
    Adzuna: !!(keys.adzunaAppId && keys.adzunaAppKey),
  };
}

/** Le résultat d'une source : le nombre d'offres si un appel au moins a abouti, sinon le code du premier échec. */
type SourceRun = { offers: RawOffer[]; code: SourceCode; failed: boolean };

async function runSource(tasks: (() => Promise<RawOffer[]>)[], concurrency: number): Promise<SourceRun> {
  if (!tasks.length) return { offers: [], code: 'skipped', failed: false };
  let ok = 0;
  let failure: SourceCode | null = null;
  const offers: RawOffer[] = [];
  await pool(
    tasks.map((t) => async () => {
      try {
        offers.push(...(await t()));
        ok++;
      } catch (e) {
        failure ??= failureCode(e);
      }
    }),
    concurrency,
  );
  return { offers, code: ok > 0 ? offers.length : (failure ?? 'error'), failed: failure !== null };
}

export async function searchAll(settings: Settings, keys: SourceKeys, deps: SearchDeps): Promise<SearchOutcome> {
  const on = configured(keys);
  const { keywords, locations, contractTypes } = settings;
  const pairs = keywords.flatMap((kw) => locations.map((loc) => [kw, loc] as const));

  const ft = async () => {
    const tasks = pairs.filter(([, loc]) => loc.insee).map(([kw, loc]) => () => searchFranceTravail(keys, deps, kw, loc, contractTypes));
    const r = await runSource(tasks, SOURCE_CONCURRENCY['France Travail']);
    // Les descriptions détaillées, s'il reste du temps : une offre par identifiant.
    const byId = new Map<string, RawOffer[]>();
    for (const o of r.offers) if (o.ftId) byId.set(o.ftId, [...(byId.get(o.ftId) ?? []), o]);
    const ids = [...byId.keys()].slice(0, MAX_DETAILS);
    await pool(
      ids.map((id) => async () => {
        if (deps.deadline - deps.now() < DETAIL_RESERVE_MS) return;
        try {
          const desc = await franceTravailDetail(keys, deps, id);
          if (desc) for (const o of byId.get(id) ?? []) if (desc.length > o.summary.length) o.summary = desc;
        } catch {
          // La description de la recherche reste : une description manquante n'est pas une panne.
        }
      }),
      SOURCE_CONCURRENCY['France Travail'],
    );
    return r;
  };
  const lba = () =>
    runSource(
      locations.filter((loc) => loc.lat !== null && loc.lon !== null).map((loc) => () => searchLba(keys, deps, loc, keywords)),
      SOURCE_CONCURRENCY['La Bonne Alternance'],
    );
  const perPair = (name: SourceName, f: (kw: string, loc: SearchLocation) => Promise<RawOffer[]>) => () =>
    runSource(pairs.map(([kw, loc]) => () => f(kw, loc)), SOURCE_CONCURRENCY[name]);

  const runners: Record<SourceName, () => Promise<SourceRun>> = {
    'France Travail': ft,
    'La Bonne Alternance': lba,
    Jooble: perPair('Jooble', (kw, loc) => searchJooble(keys, deps, kw, loc)),
    Careerjet: perPair('Careerjet', (kw, loc) => searchCareerjet(keys, deps, kw, loc)),
    Adzuna: perPair('Adzuna', (kw, loc) => searchAdzuna(keys, deps, kw, loc)),
  };

  const results = await Promise.all(
    SOURCES.map(async (name): Promise<SourceRun> => (on[name] ? await runners[name]() : { offers: [], code: 'not_configured', failed: false })),
  );
  const sources = {} as Record<SourceName, SourceCode>;
  const offers: RawOffer[] = [];
  const incomplete: SourceName[] = [];
  SOURCES.forEach((name, i) => {
    if (results[i].failed) incomplete.push(name);
    // Une offre échue n'est pas gardée, ni comptée.
    const live = results[i].offers.filter((o) => notExpired(o, deps.today));
    const code = results[i].code;
    sources[name] = typeof code === 'number' ? live.length : code;
    offers.push(...live);
  });
  offers.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  return { offers: offers.slice(0, MAX_RAW_OFFERS), sources, incomplete };
}
