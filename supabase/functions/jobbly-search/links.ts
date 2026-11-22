// ────────────────────────────────────────────────────────────────────────────
// La vérification des liens : une offre dont tous les liens ne mènent à rien
// n'est plus montrée. Sans API Deno : `fetch` et la résolution DNS sont
// passés en paramètre, et les tests jouent chaque cas contre une imitation.
//
//   · Les redirections sont suivies à la main, six au plus, et chaque saut
//     est revérifié (forme de l'adresse, puis DNS) : on ne suit jamais une
//     redirection vers une adresse privée — le site d'une offre est choisi
//     par n'importe qui, et la fonction tourne dans le réseau de Supabase.
//   · `dead` seulement sur une preuve : 404, 410, domaine introuvable,
//     renvoi vers l'accueil ou vers une recherche qui a perdu l'offre, phrase
//     d'offre expirée. Tout le reste (délai, 401, 403, 429, 5xx, connexion
//     refusée, adresse refusée) vaut `unknown`, et l'offre est gardée : un
//     contrôle qui ne peut pas juger ne conclut pas.
//   · Le cache commun (`jobbly.link_checks`) range l'empreinte de l'adresse
//     canonique, jamais l'adresse : `ok` 24 h, `dead` 30 jours ; `unknown`
//     n'est pas rangé.
//
// Rien de l'adresse ni de la page dans un journal.
// ────────────────────────────────────────────────────────────────────────────
import {
  bodyVerdict,
  cacheFresh,
  canonicalUrl,
  isIpLiteral,
  isPublicIp,
  LINK_BUDGET,
  LINK_CONCURRENCY,
  LINK_MAX_BODY_BYTES,
  LINK_MAX_REDIRECTS,
  LINK_TIMEOUT_MS,
  type LinkState,
  type LinkVerdict,
  type OfferLink,
  redirectVerdict,
  sha256Hex,
  statusVerdict,
  visitableUrl,
} from './rules.ts';
import { type Fetch, pool } from './sources.ts';

/** Réponse du DNS pour un nom : ses adresses, « n'existe pas », ou « je ne sais pas ». */
export type DnsAnswer = { kind: 'ok'; addresses: string[] } | { kind: 'nxdomain' } | { kind: 'error' };
/** `null` : pas de résolution possible ici ; seules les IP littérales et `localhost` sont alors refusées. */
export type Resolve = ((host: string, signal: AbortSignal) => Promise<DnsAnswer>) | null;

export interface CheckDeps {
  fetch: Fetch;
  resolve: Resolve;
  now: () => number;
  /** Au-delà de cet instant, plus rien ne part : `unknown`. */
  deadline: number;
  timeoutMs?: number;
}

/** En-têtes d'un navigateur : certains sites refusent un client qui ne s'annonce pas. */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

const unknown = (reason: string): LinkVerdict => ({ state: 'unknown', reason });

/** Lit au plus `max` octets d'une page, dans son jeu de caractères, puis coupe la connexion. */
export async function readHead(res: Response, max = LINK_MAX_BODY_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.byteLength - at));
    all.set(part, at);
    at += part.byteLength;
    if (at >= all.byteLength) break;
  }
  const charset = /charset=["']?([A-Za-z0-9_-]{1,40})/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(all);
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Juge un lien : `ok`, `dead` ou `unknown`, avec un code court. */
export async function check(url: string, deps: CheckDeps): Promise<LinkVerdict> {
  const left = deps.deadline - deps.now();
  if (left <= 0) return unknown('budget');
  const signal = AbortSignal.timeout(Math.min(deps.timeoutMs ?? LINK_TIMEOUT_MS, left));
  let current = url;
  try {
    for (let hop = 0; hop <= LINK_MAX_REDIRECTS; hop++) {
      const u = visitableUrl(current);
      if (!u) return unknown('blocked');
      const host = u.hostname;
      if (!isIpLiteral(host) && deps.resolve) {
        const answer = await abortable(deps.resolve(host, signal), signal);
        if (answer.kind === 'nxdomain') return { state: 'dead', reason: 'dns' };
        if (answer.kind === 'error') return unknown('dns_error');
        if (!answer.addresses.length) return { state: 'dead', reason: 'dns' };
        if (!answer.addresses.every(isPublicIp)) return unknown('blocked');
      }
      const res = await deps.fetch(u.toString(), { method: 'GET', redirect: 'manual', headers: BROWSER_HEADERS, signal });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) return unknown(`http_${res.status}`);
        try {
          current = new URL(location, u).toString();
        } catch {
          return unknown('bad_redirect');
        }
        continue;
      }
      const byStatus = statusVerdict(res.status);
      if (byStatus) {
        await res.body?.cancel().catch(() => {});
        return byStatus;
      }
      if (hop > 0) {
        const byRedirect = redirectVerdict(url, current);
        if (byRedirect) {
          await res.body?.cancel().catch(() => {});
          return byRedirect;
        }
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type && !type.includes('html') && !type.startsWith('text/')) {
        await res.body?.cancel().catch(() => {});
        return { state: 'ok', reason: 'ok' };
      }
      return bodyVerdict(await readHead(res)) ?? { state: 'ok', reason: 'ok' };
    }
    return unknown('redirects');
  } catch (e) {
    const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : '';
    return unknown(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error');
  }
}

// ── Toutes les offres d'une recherche ────────────────────────────────────────

export interface CacheRow {
  url_hash: string;
  state: 'ok' | 'dead';
  reason: string;
  checked_at: string;
}

/** Le cache commun : lire des empreintes, ranger des verdicts. Une panne du cache n'arrête rien. */
export interface LinkCache {
  get(hashes: string[]): Promise<{ url_hash: string; state: string; checked_at: string }[]>;
  put(rows: CacheRow[]): Promise<void>;
}

export interface LinksDeps {
  check: (url: string) => Promise<LinkVerdict>;
  cache: LinkCache;
  now: () => number;
  deadline: number;
  budget?: number;
  concurrency?: number;
}

export interface LinkOutcome {
  /** Le premier lien qui n'est pas mort (vide si l'offre n'a pas de lien). */
  url: string;
  /** Tous ses liens sont morts. */
  dead: boolean;
}

export interface LinksReport {
  outcomes: LinkOutcome[];
  /** Liens réellement visités (hors cache). */
  fetched: number;
  /** Liens restés sans verdict faute de budget. */
  skipped: number;
}

/**
 * Juge les liens de chaque offre, dans l'ordre donné (les nouvelles d'abord) :
 * on visite le premier lien, puis le suivant seulement s'il est mort. Une
 * offre vit dès qu'un lien n'est pas mort ; `unknown` (faute de budget
 * compris) compte comme vivant.
 */
export async function checkLinks(offers: { links: OfferLink[] }[], deps: LinksDeps): Promise<LinksReport> {
  const budget = deps.budget ?? LINK_BUDGET;
  const concurrency = deps.concurrency ?? LINK_CONCURRENCY;
  // L'empreinte de chaque lien, par son adresse canonique.
  const keyOf = new Map<string, string>();
  for (const o of offers) {
    for (const l of o.links) {
      const c = canonicalUrl(l.url);
      if (c && !keyOf.has(l.url)) keyOf.set(l.url, await sha256Hex(c));
    }
  }
  const state = new Map<string, LinkState>();
  const hashes = [...new Set(keyOf.values())];
  for (let i = 0; i < hashes.length; i += 100) {
    try {
      for (const row of await deps.cache.get(hashes.slice(i, i + 100))) {
        const fresh = cacheFresh(row.state, row.checked_at, deps.now());
        if (fresh) state.set(row.url_hash, fresh);
      }
    } catch {
      // Un cache illisible : on vérifie, voilà tout.
    }
  }

  const cursor = offers.map(() => 0);
  const outcomes: (LinkOutcome | null)[] = offers.map(() => null);
  const toStore: CacheRow[] = [];
  let fetched = 0;
  let skipped = 0;
  for (;;) {
    const wanted = new Map<string, string>(); // empreinte → adresse à visiter
    offers.forEach((o, i) => {
      if (outcomes[i]) return;
      while (cursor[i] < o.links.length) {
        const link = o.links[cursor[i]];
        const h = keyOf.get(link.url);
        const s = h ? state.get(h) : 'unknown';
        if (s === 'dead') {
          cursor[i]++;
          continue;
        }
        if (s === 'ok' || s === 'unknown') {
          outcomes[i] = { url: link.url, dead: false };
          return;
        }
        if (h && !wanted.has(h)) wanted.set(h, link.url);
        return;
      }
      outcomes[i] = o.links.length ? { url: '', dead: true } : { url: '', dead: false };
    });
    if (!wanted.size) break;
    const batch = [...wanted.entries()];
    await pool(
      batch.map(([h, url]) => async () => {
        if (fetched >= budget || deps.deadline - deps.now() <= 0) {
          skipped++;
          state.set(h, 'unknown');
          return;
        }
        fetched++;
        const v = await deps.check(url);
        state.set(h, v.state);
        if (v.state !== 'unknown') {
          toStore.push({ url_hash: h, state: v.state, reason: v.reason.slice(0, 64), checked_at: new Date(deps.now()).toISOString() });
        }
      }),
      concurrency,
    );
  }
  if (toStore.length) {
    try {
      await deps.cache.put(toStore);
    } catch {
      // Le verdict sert cette recherche ; la suivante revérifiera.
    }
  }
  return { outcomes: outcomes.map((o) => o ?? { url: '', dead: false }), fetched, skipped };
}
