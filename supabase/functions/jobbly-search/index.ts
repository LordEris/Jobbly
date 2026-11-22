// ────────────────────────────────────────────────────────────────────────────
// jobbly-search — lance la recherche d'offres d'une personne, comme le faisait
// `job_alert.py` sur son poste, et range le résultat dans ses offres.
//
// Les clés des cinq sources sont celles du propriétaire ; elles vivent dans
// les secrets de la fonction (JOBBLY_*) et ne la quittent jamais. Le site
// n'envoie que la session de son compte Lorderis et `{}`.
//
// L'ordre compte, et chaque étape refuse avant la suivante :
//   1. un compte connecté (JWT vérifié par la passerelle, verify_jwt = true,
//      puis relu ici par l'API d'authentification : c'est elle qui donne
//      l'identifiant, jamais le corps de la requête) ;
//   2. ses réglages, lus avec SON jeton (RLS) ;
//   3. une recherche prise sur le quota (jobbly.consume_search_quota, client
//      service_role) ;
//   4. les sources, en parallèle, dans un budget d'environ 60 s ;
//   5. les doublons regroupés (rules.ts) ;
//   6. les liens vérifiés, avec le cache commun (links.ts) ;
//   7. la fusion avec ses offres, écrite avec SON jeton : le statut,
//      `status_at`, `blocked` et `first_seen` ne sont jamais envoyés.
//
// Rien de ce que la personne a saisi, rien d'une offre ni d'une adresse dans
// un journal : seulement des codes.
// ────────────────────────────────────────────────────────────────────────────
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0';
import {
  corsHeaders,
  dedupe,
  type ErrorCode,
  type ExistingOffer,
  type FoundOffer,
  GLOBAL_DAILY_LIMIT,
  isStorageLimit,
  LINKS_BUDGET_MS,
  makeId,
  MAX_BODY_BYTES,
  mergeGroup,
  parseExisting,
  parseSettings,
  planMerge,
  SOURCES_BUDGET_MS,
  STATUS,
  USER_DAILY_LIMIT,
  utcDay,
  validateBody,
} from './rules.ts';
import { searchAll, type SourceKeys } from './sources.ts';
import { check, checkLinks, type DnsAnswer, type LinkCache, type Resolve } from './links.ts';

// deno-lint-ignore no-explicit-any
type Client = SupabaseClient<any, any, any>;

const CLIENT_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

// Construit au premier appel, jamais à l'import : une variable absente ferait
// sinon tomber la fonction au chargement, en 500 sans corps.
let admin: Client | null = null;
function adminClient(): Client | null {
  if (admin) return admin;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  admin = createClient(url, key, { auth: CLIENT_OPTIONS, db: { schema: 'jobbly' } });
  return admin;
}

/** Le client de la personne : la clé publiable, et SON jeton. La RLS décide. */
function userClient(jwt: string, apikey: string): Client | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') || apikey;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: CLIENT_OPTIONS,
    db: { schema: 'jobbly' },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

function sourceKeys(): SourceKeys {
  const env = (n: string) => Deno.env.get(n)?.trim() ?? '';
  return {
    ftClientId: env('JOBBLY_FT_CLIENT_ID'),
    ftClientSecret: env('JOBBLY_FT_CLIENT_SECRET'),
    lbaApiKey: env('JOBBLY_LBA_API_KEY'),
    joobleApiKey: env('JOBBLY_JOOBLE_API_KEY'),
    careerjetAffid: env('JOBBLY_CAREERJET_AFFID'),
    adzunaAppId: env('JOBBLY_ADZUNA_APP_ID'),
    adzunaAppKey: env('JOBBLY_ADZUNA_APP_KEY'),
  };
}

/**
 * La résolution DNS de Deno, si le runtime la permet. Une erreur autre que
 * « nom introuvable » vaut « je ne sais pas » : le lien n'est pas visité, et
 * l'offre est gardée.
 */
const resolveDns: Resolve =
  typeof Deno.resolveDns === 'function'
    ? async (host: string, signal: AbortSignal): Promise<DnsAnswer> => {
      const one = async (type: 'A' | 'AAAA'): Promise<string[] | 'nx' | 'err'> => {
        try {
          return await Deno.resolveDns(host, type, { signal });
        } catch (e) {
          return e instanceof Deno.errors.NotFound ? 'nx' : 'err';
        }
      };
      const [a, aaaa] = await Promise.all([one('A'), one('AAAA')]);
      if (a === 'err' || aaaa === 'err') {
        // Une famille introuvable et l'autre en erreur : on ne conclut pas.
        if (Array.isArray(a) && a.length) return { kind: 'ok', addresses: a };
        if (Array.isArray(aaaa) && aaaa.length) return { kind: 'ok', addresses: aaaa };
        return { kind: 'error' };
      }
      const addresses = [...(Array.isArray(a) ? a : []), ...(Array.isArray(aaaa) ? aaaa : [])];
      return addresses.length ? { kind: 'ok', addresses } : { kind: 'nxdomain' };
    }
    : null;

function linkCache(db: Client): LinkCache {
  return {
    async get(hashes) {
      const { data, error } = await db.from('link_checks').select('url_hash,state,checked_at').in('url_hash', hashes);
      if (error) throw new Error('cache_read');
      return (data ?? []) as { url_hash: string; state: string; checked_at: string }[];
    },
    async put(rows) {
      const { error } = await db.from('link_checks').upsert(rows, { onConflict: 'url_hash' });
      if (error) throw new Error('cache_write');
    },
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

async function readBody(req: Request): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Toutes les offres connues de la personne (id, statut, signalement, disparition), page par page. */
async function readExisting(db: Client, userId: string): Promise<ExistingOffer[] | null> {
  const out: ExistingOffer[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('offers').select('id,status,blocked,gone_at,sources:data->sources').eq('user_id', userId).order('id').range(from, from + 999);
    if (error) return null;
    for (const r of data ?? []) {
      const e = parseExisting(r);
      if (e) out.push(e);
    }
    if (!data || data.length < 1000) return out;
    if (from > 50_000) return out;
  }
}

// Lignes par écriture (corps de requête), et identifiants par filtre `in` (dans l'adresse : elle reste courte).
const CHUNK = 250;
const IN_CHUNK = 100;

/** Écrit la fusion : suppressions et disparitions d'abord, pour libérer la place sous le plafond. */
async function writePlan(db: Client, userId: string, plan: ReturnType<typeof planMerge>, nowIso: string): Promise<ErrorCode | null> {
  const failed = (error: { message?: string } | null): ErrorCode | null =>
    error ? (isStorageLimit(error.message) ? 'storage_limit' : 'save_failed') : null;
  for (let i = 0; i < plan.remove.length; i += IN_CHUNK) {
    const { error } = await db.from('offers').delete().eq('user_id', userId).in('id', plan.remove.slice(i, i + IN_CHUNK)).eq('status', '').eq('blocked', false);
    const f = failed(error);
    if (f) return f;
  }
  for (let i = 0; i < plan.gone.length; i += IN_CHUNK) {
    const { error } = await db.from('offers').update({ gone_at: nowIso }).eq('user_id', userId).in('id', plan.gone.slice(i, i + IN_CHUNK)).is('gone_at', null);
    const f = failed(error);
    if (f) return f;
  }
  // Connues : seuls data, last_seen et gone_at. Le statut, status_at, blocked
  // et first_seen ne sont pas dans la requête, donc pas dans le SET.
  for (let i = 0; i < plan.update.length; i += CHUNK) {
    const rows = plan.update.slice(i, i + CHUNK).map((r) => ({ user_id: userId, ...r }));
    const { error } = await db.from('offers').upsert(rows, { onConflict: 'user_id,id', defaultToNull: false });
    const f = failed(error);
    if (f) return f;
  }
  // Nouvelles : `ignoreDuplicates`, pour qu'une recherche lancée en même
  // temps sur un autre onglet ne réécrive pas une offre que l'autre a déjà rangée.
  for (let i = 0; i < plan.insert.length; i += CHUNK) {
    const rows = plan.insert.slice(i, i + CHUNK).map((r) => ({ user_id: userId, ...r }));
    const { error } = await db.from('offers').upsert(rows, { onConflict: 'user_id,id', ignoreDuplicates: true, defaultToNull: false });
    const f = failed(error);
    if (f) return f;
  }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const fail = (code: ErrorCode): Response => json({ ok: false, code }, STATUS[code], origin);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('method_not_allowed');

  const db = adminClient();
  if (!db) {
    // Le NOM de ce qui manque, jamais une valeur.
    console.error('jobbly-search: not_configured', 'supabase');
    return fail('not_configured');
  }

  // 1. Le compte.
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return fail('not_authenticated');
  const { data: auth, error: authError } = await db.auth.getUser(jwt);
  const userId = auth?.user?.id;
  if (authError || !userId || auth.user.is_anonymous) return fail('not_authenticated');

  const body = await readBody(req);
  if (body === null || !validateBody(body)) return fail('invalid_request');

  // 2. Les réglages, avec SON jeton.
  const mine = userClient(jwt, req.headers.get('apikey') ?? '');
  if (!mine) return fail('not_configured');
  const { data: row, error: settingsError } = await mine.from('settings').select('keywords,locations,contract_types').eq('user_id', userId).maybeSingle();
  if (settingsError) {
    console.error('jobbly-search: settings_error', settingsError.code ?? 'unknown');
    return fail('not_configured');
  }
  const settings = parseSettings(row);
  if (!settings) return fail('no_settings');

  // 3. Le quota : une recherche lancée compte, qu'elle trouve ou non.
  const { data: verdict, error: quotaError } = await db.rpc('consume_search_quota', {
    p_user: userId,
    p_user_limit: USER_DAILY_LIMIT,
    p_global_limit: GLOBAL_DAILY_LIMIT,
  });
  if (quotaError) {
    // Un quota qu'on ne sait pas lire n'est pas un quota libre.
    console.error('jobbly-search: quota_error', quotaError.code ?? 'unknown');
    return fail('not_configured');
  }
  if (verdict === 'user_limit' || verdict === 'global_limit') return fail('quota');
  if (verdict !== 'ok') return fail('not_configured');

  // 4. Les sources.
  const started = Date.now();
  const today = utcDay();
  const { offers: raw, sources, incomplete } = await searchAll(settings, sourceKeys(), {
    fetch,
    now: Date.now,
    deadline: started + SOURCES_BUDGET_MS,
    today,
  });

  // 5. Les doublons.
  const { groups } = dedupe(raw, settings.locations.map((l) => l.city));
  const merged = groups.map(mergeGroup);
  const ids = await Promise.all(merged.map((m) => makeId(m.idUrl, m.data.title)));

  const existing = await readExisting(mine, userId);
  if (!existing) return fail('save_failed');
  const known = new Set(existing.map((e) => e.id));

  // 6. Les liens : les offres nouvelles d'abord, celles qu'on connaît sont en cache.
  const order = merged.map((_, i) => i).sort((a, b) => Number(known.has(ids[a])) - Number(known.has(ids[b])));
  const linksStart = Date.now();
  const deadline = linksStart + LINKS_BUDGET_MS;
  const report = await checkLinks(
    order.map((i) => merged[i].data),
    {
      check: (url) => check(url, { fetch, resolve: resolveDns, now: Date.now, deadline }),
      cache: linkCache(db),
      now: Date.now,
      deadline,
    },
  );
  const found: FoundOffer[] = order.map((i, k) => {
    const outcome = report.outcomes[k];
    return { id: ids[i], data: { ...merged[i].data, url: outcome.dead ? '' : outcome.url || merged[i].data.url }, dead: outcome.dead };
  });

  // 7. La fusion.
  const nowIso = new Date().toISOString();
  const plan = planMerge(existing, found, nowIso, incomplete);
  const writeError = await writePlan(mine, userId, plan, nowIso);
  if (writeError) {
    console.error('jobbly-search: write_error', writeError);
    return fail(writeError);
  }

  return json(
    {
      ok: true,
      counts: {
        raw: raw.length,
        duplicates: raw.length - groups.length,
        dead_links: plan.counts.dead_links,
        kept: plan.counts.kept,
        new: plan.counts.new,
      },
      sources,
    },
    200,
    origin,
  );
});
