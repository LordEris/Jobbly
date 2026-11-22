// Épreuve de la vérification des liens, contre un réseau imité.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CacheRow, check, type CheckDeps, checkLinks, type DnsAnswer, readHead } from './links.ts';
import { bodyVerdict, canonicalUrl, isPublicIp, redirectVerdict, sha256Hex, visitableUrl } from './rules.ts';

type Route = { status: number; location?: string; body?: string; type?: string } | 'timeout' | 'refused';

function deps(routes: Record<string, Route>, dns: Record<string, DnsAnswer> = {}): CheckDeps & { visited: string[] } {
  const visited: string[] = [];
  return {
    visited,
    now: () => 1_000,
    deadline: 1_000_000,
    timeoutMs: 200,
    resolve: async (host) => dns[host] ?? { kind: 'ok', addresses: ['93.184.215.14'] },
    fetch: async (url, init) => {
      visited.push(url);
      assert.equal(init?.redirect, 'manual', 'les redirections se suivent à la main');
      const r = routes[url];
      if (!r) throw new Error('route inconnue ' + url);
      if (r === 'timeout') {
        // Le minuteur d'AbortSignal.timeout ne retient pas Node : on le retient le temps du test.
        const keep = setTimeout(() => {}, 5_000);
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(keep);
            reject(init.signal?.reason);
          });
        });
      }
      if (r === 'refused') throw new TypeError('connection refused');
      const headers = new Headers({ 'content-type': r.type ?? 'text/html; charset=utf-8' });
      if (r.location) headers.set('location', r.location);
      return new Response(r.status === 204 || r.status === 304 ? null : (r.body ?? '<html><body>Offre</body></html>'), { status: r.status, headers });
    },
  };
}

test('404 et 410 : mort', async () => {
  assert.deepEqual(await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': { status: 404 } })), { state: 'dead', reason: 'http_404' });
  assert.deepEqual(await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': { status: 410 } })), { state: 'dead', reason: 'http_410' });
});

test('page vivante : ok', async () => {
  assert.deepEqual(await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': { status: 200 } })), { state: 'ok', reason: 'ok' });
});

test('domaine introuvable : mort ; DNS en panne : inconnu', async () => {
  const d = deps({}, { 'disparu.fr': { kind: 'nxdomain' }, 'panne.fr': { kind: 'error' } });
  assert.deepEqual(await check('https://disparu.fr/offre/1', d), { state: 'dead', reason: 'dns' });
  assert.equal((await check('https://panne.fr/offre/1', d)).state, 'unknown');
  assert.deepEqual(d.visited, [], 'rien n’est visité sans réponse du DNS');
});

test('renvoi vers la page d’accueil : mort ; vers une page de même chemin : ok', async () => {
  const d = deps({
    'https://a.fr/offres/emploi-plombier-12345': { status: 301, location: '/' },
    'https://a.fr/': { status: 200 },
    'http://b.fr/offre/9': { status: 301, location: 'https://www.b.fr/offre/9/' },
    'https://www.b.fr/offre/9/': { status: 200 },
    'https://c.fr/job/777777': { status: 302, location: 'https://c.fr/fr/' },
    'https://c.fr/fr/': { status: 200 },
  });
  assert.deepEqual(await check('https://a.fr/offres/emploi-plombier-12345', d), { state: 'dead', reason: 'home' });
  assert.deepEqual(await check('http://b.fr/offre/9', d), { state: 'ok', reason: 'ok' });
  assert.deepEqual(await check('https://c.fr/job/777777', d), { state: 'dead', reason: 'home' });
});

test('renvoi vers une recherche qui a perdu l’offre : mort ; qui la garde : ok', async () => {
  const d = deps({
    'https://candidat.francetravail.fr/offres/recherche/detail/190XQRM': { status: 302, location: 'https://candidat.francetravail.fr/offres/recherche?motsCles=plombier' },
    'https://candidat.francetravail.fr/offres/recherche?motsCles=plombier': { status: 200 },
    'https://jobs.fr/annonce/987654': { status: 302, location: 'https://jobs.fr/emplois?q=plombier' },
    'https://jobs.fr/emplois?q=plombier': { status: 200 },
    'https://jobs.fr/annonce/111111': { status: 302, location: 'https://jobs.fr/offres/111111-plombier' },
    'https://jobs.fr/offres/111111-plombier': { status: 200 },
    'https://www.adzuna.fr/details/4512345678': { status: 302, location: 'https://employeur.fr/carrieres/plombier-orleans' },
    'https://employeur.fr/carrieres/plombier-orleans': { status: 200 },
  });
  assert.deepEqual(await check('https://candidat.francetravail.fr/offres/recherche/detail/190XQRM', d), { state: 'dead', reason: 'search' });
  assert.deepEqual(await check('https://jobs.fr/annonce/987654', d), { state: 'dead', reason: 'search' });
  assert.deepEqual(await check('https://jobs.fr/annonce/111111', d), { state: 'ok', reason: 'ok' });
  // Un agrégateur qui renvoie chez l'employeur perd son identifiant, mais pas vers une recherche : ok.
  assert.deepEqual(await check('https://www.adzuna.fr/details/4512345678', d), { state: 'ok', reason: 'ok' });
});

test('phrases d’offre expirée, en français et en anglais', async () => {
  const pages = [
    "<h1>Désolé, cette offre n'est plus disponible</h1>",
    '<h1>Cette annonce n&#39;est plus en ligne.</h1>',
    '<h2>L’offre a expiré le 12/10.</h2>',
    '<h3 class="msg">Offre expirée</h3>',
    '<h2>Ce poste a été pourvue.</h2>',
    "<h1>La page demandée n'existe plus</h1>",
    '<title>Page introuvable</title>',
    '<h2>This job is no longer available</h2>',
    '<h1>Sorry, this job has expired.</h1>',
    '<title>No longer accepting applications</title>',
    '<h2>This position has been filled</h2>',
    '<h1>OFFRE EXPIR&Eacute;E</h1>',
  ];
  for (const body of pages) {
    const d = deps({ 'https://a.fr/offre/12345': { status: 200, body } });
    assert.deepEqual(await check('https://a.fr/offre/12345', d), { state: 'dead', reason: 'expired' }, body);
  }
  // Une phrase dans du code, pas dans le texte : la page vit.
  assert.equal(bodyVerdict('<script>var msg = "page introuvable";</script><p>Plombier H/F</p>'), null);
  assert.equal(bodyVerdict('<p>Plombier H/F, poste disponible tout de suite</p>'), null);
  // Le formulaire « Signaler cette offre » de France Travail, sur chaque offre
  // vivante : ses motifs ne disent rien de l'offre affichée.
  assert.equal(
    bodyVerdict("<title>Offre d'emploi Plombier H/F</title><h1>Plombier H/F</h1><form><label><input type=radio> L'offre n'existe plus sur le site partenaire</label></form>"),
    null,
  );
  assert.equal(bodyVerdict("<title>Offre expirée - Indeed</title><p>Plombier</p>")?.state, 'dead');
  // Une page en latin-1 se lit dans son jeu de caractères.
  const latin1 = new Uint8Array([...new TextEncoder().encode('<h1>Offre expir'), 0xe9, 0x65, ...new TextEncoder().encode('</h1>')]);
  const text = await readHead(new Response(latin1, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } }));
  assert.equal(bodyVerdict(text)?.state, 'dead');
});

test('seuls les 128 premiers Ko du corps sont lus', async () => {
  const big = '<h1>' + 'x'.repeat(200 * 1024) + " cette offre n'est plus disponible</h1>";
  const d = deps({ 'https://a.fr/offre/12345': { status: 200, body: big } });
  assert.deepEqual(await check('https://a.fr/offre/12345', d), { state: 'ok', reason: 'ok' });
});

test('403, 401, 429, 5xx, délai, connexion refusée : inconnu, jamais mort', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const v = await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': { status } }));
    assert.deepEqual(v, { state: 'unknown', reason: `http_${status}` });
  }
  assert.deepEqual(await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': 'timeout' })), { state: 'unknown', reason: 'timeout' });
  assert.deepEqual(await check('https://a.fr/offre/12345', deps({ 'https://a.fr/offre/12345': 'refused' })), { state: 'unknown', reason: 'error' });
});

test('une redirection vers une adresse privée n’est jamais suivie', async () => {
  const d = deps(
    {
      'https://a.fr/o/1': { status: 302, location: 'http://127.0.0.1/admin' },
      'https://a.fr/o/2': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      'https://a.fr/o/3': { status: 302, location: 'http://[::1]/' },
      'https://a.fr/o/4': { status: 302, location: 'http://localhost/' },
      'https://a.fr/o/5': { status: 302, location: 'https://interne.exemple.fr/x' },
      'https://a.fr/o/6': { status: 302, location: 'http://2130706433/' },
      'https://a.fr/o/7': { status: 302, location: 'http://a.fr:22/' },
      'https://a.fr/o/8': { status: 302, location: 'file:///etc/passwd' },
      'https://a.fr/o/9': { status: 302, location: 'http://[::ffff:10.0.0.1]/' },
    },
    { 'interne.exemple.fr': { kind: 'ok', addresses: ['10.1.2.3'] } },
  );
  for (let i = 1; i <= 9; i++) {
    assert.deepEqual(await check(`https://a.fr/o/${i}`, d), { state: 'unknown', reason: 'blocked' }, `o/${i}`);
  }
  assert.ok(d.visited.every((u) => u.startsWith('https://a.fr/o/')), 'aucune adresse privée visitée');
});

test('sans DNS possible, les IP littérales privées et localhost restent refusés', async () => {
  const d = { ...deps({ 'https://a.fr/o/1': { status: 302, location: 'http://192.168.1.1/' } }), resolve: null };
  assert.deepEqual(await check('https://a.fr/o/1', d), { state: 'unknown', reason: 'blocked' });
  assert.equal(visitableUrl('http://localhost/'), null);
  assert.equal(visitableUrl('http://intranet/'), null);
  assert.equal(visitableUrl('http://box.home.arpa/'), null);
  assert.ok(visitableUrl('https://8.8.8.8/'));
});

test('six redirections au plus', async () => {
  const routes: Record<string, Route> = {};
  for (let i = 0; i < 8; i++) routes[`https://a.fr/r/${i}`] = { status: 302, location: `https://a.fr/r/${i + 1}` };
  routes['https://a.fr/r/8'] = { status: 200 };
  const d = deps(routes);
  assert.deepEqual(await check('https://a.fr/r/0', d), { state: 'unknown', reason: 'redirects' });
  assert.equal(d.visited.length, 7);
});

test('adresses IP publiques et privées', () => {
  for (const ip of ['8.8.8.8', '93.184.215.14', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
  for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.0.1', '127.0.0.1', '0.0.0.0', '100.64.0.1', '169.254.169.254', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '[::ffff:7f00:1]', '64:ff9b::a00:1', 'not-an-ip']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
});

test('redirectVerdict sans réseau', () => {
  assert.equal(redirectVerdict('https://a.fr/x/12345', 'https://a.fr/x/12345/'), null);
  assert.equal(redirectVerdict('https://a.fr/', 'https://a.fr/'), null);
  assert.deepEqual(redirectVerdict('https://a.fr/job/abcde1', 'https://a.fr/'), { state: 'dead', reason: 'home' });
});

// ── Le cache et le budget ────────────────────────────────────────────────────

function memoryCache(initial: { url_hash: string; state: string; checked_at: string }[] = []) {
  const rows = new Map(initial.map((r) => [r.url_hash, r]));
  const puts: CacheRow[] = [];
  return {
    puts,
    async get(hashes: string[]) {
      return hashes.map((h) => rows.get(h)).filter((r): r is { url_hash: string; state: string; checked_at: string } => !!r);
    },
    async put(r: CacheRow[]) {
      puts.push(...r);
      for (const x of r) rows.set(x.url_hash, x);
    },
  };
}
const NOW = Date.parse('2026-11-22T10:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const link = (url: string) => ({ url, source: 'Jooble' as const });

test('cache : ok valable 24 h, mort 30 jours, inconnu jamais rangé ; l’empreinte, jamais l’adresse', async () => {
  const fresh = await sha256Hex(canonicalUrl('https://a.fr/ok'));
  const stale = await sha256Hex(canonicalUrl('https://a.fr/vieux'));
  const dead = await sha256Hex(canonicalUrl('https://a.fr/mort'));
  const cache = memoryCache([
    { url_hash: fresh, state: 'ok', checked_at: ago(23) },
    { url_hash: stale, state: 'ok', checked_at: ago(25) },
    { url_hash: dead, state: 'dead', checked_at: ago(24 * 29) },
  ]);
  const checked: string[] = [];
  const verdicts: Record<string, 'ok' | 'dead' | 'unknown'> = { 'https://a.fr/vieux': 'ok', 'https://a.fr/neuf': 'unknown' };
  const report = await checkLinks(
    [{ links: [link('https://a.fr/ok')] }, { links: [link('https://a.fr/vieux')] }, { links: [link('https://www.a.fr/mort/?utm_source=x')] }, { links: [link('https://a.fr/neuf')] }],
    {
      check: async (url) => {
        checked.push(url);
        return { state: verdicts[url], reason: verdicts[url] };
      },
      cache,
      now: () => NOW,
      deadline: NOW + 60_000,
    },
  );
  assert.deepEqual(checked.sort(), ['https://a.fr/neuf', 'https://a.fr/vieux']);
  assert.deepEqual(report.outcomes.map((o) => o.dead), [false, false, true, false]);
  assert.equal(cache.puts.length, 1, 'inconnu n’est pas rangé');
  assert.equal(cache.puts[0].url_hash, stale);
  assert.match(cache.puts[0].url_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(cache.puts).includes('a.fr'), 'aucune adresse dans le cache');
});

test('le premier lien vivant devient le lien de l’offre ; morte seulement si tous sont morts', async () => {
  const verdict: Record<string, 'ok' | 'dead' | 'unknown'> = {
    'https://a.fr/1': 'dead',
    'https://b.fr/1': 'ok',
    'https://c.fr/1': 'ok',
    'https://a.fr/2': 'dead',
    'https://b.fr/2': 'dead',
    'https://a.fr/3': 'unknown',
  };
  const checked: string[] = [];
  const report = await checkLinks(
    [{ links: [link('https://a.fr/1'), link('https://b.fr/1'), link('https://c.fr/1')] }, { links: [link('https://a.fr/2'), link('https://b.fr/2')] }, { links: [link('https://a.fr/3')] }, { links: [] }],
    {
      check: async (url) => {
        checked.push(url);
        return { state: verdict[url], reason: 'x' };
      },
      cache: memoryCache(),
      now: () => NOW,
      deadline: NOW + 60_000,
    },
  );
  assert.deepEqual(report.outcomes, [
    { url: 'https://b.fr/1', dead: false },
    { url: '', dead: true },
    { url: 'https://a.fr/3', dead: false },
    { url: '', dead: false },
  ]);
  assert.ok(!checked.includes('https://c.fr/1'), 'on ne visite pas plus loin que le premier lien vivant');
});

test('budget : au-delà de N liens, inconnu (l’offre est gardée), et rien n’est rangé', async () => {
  let calls = 0;
  const cache = memoryCache();
  const offers = Array.from({ length: 20 }, (_, i) => ({ links: [link(`https://a.fr/o/${i}`)] }));
  const report = await checkLinks(offers, {
    check: async () => {
      calls++;
      return { state: 'dead', reason: 'http_404' };
    },
    cache,
    now: () => NOW,
    deadline: NOW + 60_000,
    budget: 5,
    concurrency: 3,
  });
  assert.equal(calls, 5);
  assert.equal(report.fetched, 5);
  assert.equal(report.skipped, 15);
  assert.equal(report.outcomes.filter((o) => o.dead).length, 5);
  assert.equal(cache.puts.length, 5);
});

test('un cache en panne n’arrête pas la vérification', async () => {
  const report = await checkLinks([{ links: [link('https://a.fr/1')] }], {
    check: async () => ({ state: 'ok', reason: 'ok' }),
    cache: {
      get: async () => {
        throw new Error('down');
      },
      put: async () => {
        throw new Error('down');
      },
    },
    now: () => NOW,
    deadline: NOW + 60_000,
  });
  assert.deepEqual(report.outcomes, [{ url: 'https://a.fr/1', dead: false }]);
});
