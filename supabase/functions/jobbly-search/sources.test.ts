// Épreuve des sources : lecture des réponses (champs absents, types faux) et
// appels, contre des API imitées aux formes que rendent les vraies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanDate,
  parseAdzuna,
  parseCareerjet,
  parseFranceTravail,
  parseFtToken,
  parseJooble,
  parseLba,
  type Settings,
} from './rules.ts';
import { resetFtToken, searchAll, type SourceKeys } from './sources.ts';

// ── Lecture des réponses ─────────────────────────────────────────────────────

test('France Travail : champs lus, adresse d’origine sinon fiche, identifiant gardé', () => {
  const out = parseFranceTravail(
    {
      resultats: [
        {
          id: '190XQRM',
          intitule: 'Plombier H/F',
          entreprise: { nom: 'SARL DUPONT' },
          lieuTravail: { libelle: '45 - ORLEANS' },
          origineOffre: { urlOrigine: 'https://www.hellowork.com/fr-fr/emplois/1.html' },
          dateCreation: '2026-11-18T10:00:00.000Z',
          dateEcheance: '2027-01-18T00:00:00.000Z',
          description: 'Pose de <b>sanitaires</b>.',
          typeContratLibelle: 'Contrat à durée indéterminée',
        },
        { id: '190XQRN', intitule: 'Électricien', entreprise: null, lieuTravail: 42 },
        { id: 'X', intitule: '' }, // sans titre : écartée
        'pas un objet',
      ],
    },
    'Orléans',
  );
  assert.ok(out);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    source: 'France Travail',
    title: 'Plombier H/F',
    company: 'SARL DUPONT',
    location: '45 - ORLEANS',
    url: 'https://www.hellowork.com/fr-fr/emplois/1.html',
    date: '2026-11-18',
    expires: '2027-01-18',
    summary: 'Pose de sanitaires .',
    contract: 'Contrat à durée indéterminée',
    ftId: '190XQRM',
    salary: null,
  });
  assert.equal(out[1].url, 'https://candidat.francetravail.fr/offres/recherche/detail/190XQRN');
  assert.equal(out[1].company, '');
  assert.equal(out[1].location, 'Orléans', 'lieu absent : la ville cherchée');
});

test('France Travail : réponses illisibles et vides', () => {
  assert.equal(parseFranceTravail('texte', 'x'), null);
  assert.equal(parseFranceTravail({ resultats: 'nope' }, 'x'), null);
  assert.deepEqual(parseFranceTravail({}, 'x'), []);
  // Une adresse d'origine en javascript: n'est pas reprise ; l'identifiant louche non plus.
  const [o] = parseFranceTravail({ resultats: [{ id: '../../x', intitule: 'A', origineOffre: { urlOrigine: 'javascript:alert(1)' } }] }, 'x') ?? [];
  assert.equal(o.url, '');
  assert.equal(o.ftId, '');
});

test('jeton France Travail', () => {
  assert.deepEqual(parseFtToken({ access_token: 'abc', expires_in: 1499 }), { token: 'abc', expiresIn: 1499 });
  assert.deepEqual(parseFtToken({ access_token: 'abc' }), { token: 'abc', expiresIn: 1200 });
  assert.equal(parseFtToken({ access_token: 'a b' }), null);
  assert.equal(parseFtToken({ error: 'invalid_client' }), null);
  assert.equal(parseFtToken(null), null);
});

test('La Bonne Alternance : forme du script et forme publiée, contrat en liste', () => {
  const out = parseLba(
    {
      jobs: [
        {
          title: 'Apprenti(e) plombier chauffagiste',
          workplace: { name: 'THERMI SERVICES', location: { city: 'Tours' } },
          apply: { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/1' },
          publication: { creation: '2026-11-10T00:00:00Z', expiration: '2027-02-10T00:00:00Z' },
          description: 'CAP MIT',
          contract: { type: ['Apprentissage', 'Professionnalisation'] },
        },
        {
          offer: { title: 'Apprenti couvreur', description: 'Toitures', publication: { creation: '2026-11-11' } },
          workplace: { legal_name: 'Charpentes du Val' },
          apply: { url: 42 },
        },
      ],
    },
    'Orléans',
  );
  assert.ok(out);
  assert.equal(out[0].contract, 'Apprentissage, Professionnalisation');
  assert.equal(out[0].expires, '2027-02-10');
  assert.equal(out[1].title, 'Apprenti couvreur');
  assert.equal(out[1].company, 'Charpentes du Val');
  assert.equal(out[1].url, '');
  assert.equal(out[1].contract, 'Alternance');
  assert.equal(out[1].location, 'Orléans');
  assert.deepEqual(parseLba({ jobs: null }, 'x'), []);
  assert.equal(parseLba({ jobs: {} }, 'x'), null);
});

test('Jooble : balises du résumé retirées, offres hors sujet écartées', () => {
  const out = parseJooble(
    {
      totalCount: 2,
      jobs: [
        { title: 'Plombier (F/H)', company: 'Dupont', location: 'Orléans', link: 'https://fr.jooble.org/desc/1', updated: '2026-11-19T08:00:00.0000000', snippet: '&nbsp;...<b>Plombier</b> confirmé...', type: 'CDI' },
        { title: 'Vendeur', company: 'X', location: 'Orléans', link: 'https://fr.jooble.org/desc/2', snippet: 'magasin' },
        { title: 123, link: 'https://fr.jooble.org/desc/3' },
      ],
    },
    'Orléans',
    'plombier',
  );
  assert.ok(out);
  assert.equal(out.length, 1);
  assert.equal(out[0].summary, '... Plombier confirmé...');
  assert.equal(out[0].date, '2026-11-19');
  assert.equal(parseJooble([], 'x', 'k'), null);
});

test('Careerjet : date HTTP lue, `LOCATIONS` sans offre', () => {
  const out = parseCareerjet(
    { type: 'JOBS', jobs: [{ title: 'Plombier', company: 'Dupont', locations: 'Orléans', url: 'https://www.careerjet.fr/jobad/fr1', date: 'Tue, 17 Nov 2026 09:00:00 GMT', description: 'x', salary: '' }] },
    'Orléans',
  );
  assert.equal(out?.[0].date, '2026-11-17');
  assert.deepEqual(parseCareerjet({ type: 'LOCATIONS', locations: ['Orléans (45)', 'Orléans (Loiret)'] }, 'x'), []);
});

test('Adzuna : adresse de fiche, lieu composé, identifiant louche refusé', () => {
  const out = parseAdzuna(
    {
      count: 2,
      results: [
        { id: '4512345678', title: 'Plombier h/f', company: { display_name: 'Dupont SARL' }, location: { display_name: 'Orléans', area: ['France', 'Centre-Val de Loire', 'Loiret'] }, created: '2026-11-21T07:00:00Z', description: 'x', contract_time: 'full_time' },
        { id: '../x', title: 'Plombier', redirect_url: 'https://www.adzuna.fr/land/ad/1?se=x', location: { area: 'pas une liste' } },
      ],
    },
    'Orléans',
  );
  assert.ok(out);
  assert.equal(out[0].url, 'https://www.adzuna.fr/details/4512345678');
  assert.equal(out[0].location, 'Orléans, Loiret');
  assert.equal(out[0].contract, 'full_time');
  assert.equal(out[1].url, 'https://www.adzuna.fr/land/ad/1?se=x');
  assert.equal(out[1].location, 'Orléans');
});

test('dates', () => {
  assert.equal(cleanDate('2026-11-18T10:00:00Z'), '2026-11-18');
  assert.equal(cleanDate('2026-13-01'), '');
  assert.equal(cleanDate(20261118), '');
  assert.equal(cleanDate('hier'), '');
});

// ── Les appels ───────────────────────────────────────────────────────────────

const SETTINGS: Settings = {
  keywords: ['plombier'],
  locations: [
    { city: 'Orléans', radius: 30, insee: '45234', lat: 47.9029, lon: 1.9097 },
    { city: 'Blois', radius: 20, insee: '', lat: null, lon: null },
  ],
  contractTypes: ['CDI', 'CDD'],
};
const ALL_KEYS: SourceKeys = {
  ftClientId: 'id',
  ftClientSecret: 'secret',
  lbaApiKey: 'lba',
  joobleApiKey: 'jooble',
  careerjetAffid: 'cj',
  adzunaAppId: 'az',
  adzunaAppKey: 'azk',
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function standardApis(over: Partial<Record<string, Handler>> = {}): Handler {
  return (url, init) => {
    const h = over[url.hostname];
    if (h) return h(url, init);
    switch (url.hostname) {
      case 'entreprise.francetravail.fr':
        return jsonResponse({ access_token: 'tok', expires_in: 1499 });
      case 'api.francetravail.io':
        if (url.pathname.endsWith('/search')) {
          return jsonResponse({ resultats: [{ id: '190XQRM', intitule: 'Plombier H/F', description: 'court', dateEcheance: '2020-01-01' }, { id: '190XQRN', intitule: 'Plombier', description: 'court' }] }, 206);
        }
        return jsonResponse({ description: 'Description détaillée, bien plus longue que celle de la recherche.' });
      case 'api.apprentissage.beta.gouv.fr':
        return jsonResponse({ jobs: [{ title: 'Apprenti plombier', apply: { url: 'https://lba.fr/1' } }, { title: 'Apprenti boulanger', apply: { url: 'https://lba.fr/2' } }] });
      case 'jooble.org':
        return jsonResponse({ jobs: [{ title: 'Plombier', link: 'https://fr.jooble.org/desc/1' }] });
      case 'public.api.careerjet.net':
        return jsonResponse({ jobs: [{ title: 'Plombier', url: 'https://www.careerjet.fr/jobad/1' }] });
      case 'api.adzuna.com':
        return jsonResponse({ results: [{ id: '1', title: 'Plombier' }] });
    }
    return new Response('', { status: 404 });
  };
}

test('les cinq sources : adresses et paramètres du script, 206 accepté, offre échue retirée, descriptions détaillées', async () => {
  resetFtToken();
  const { fetch, calls } = fakeFetch(standardApis());
  const out = await searchAll(SETTINGS, ALL_KEYS, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  assert.deepEqual(out.sources, { 'France Travail': 1, 'La Bonne Alternance': 1, Jooble: 2, Careerjet: 2, Adzuna: 2 });
  assert.deepEqual(out.incomplete, []);
  // France Travail : un jeton pour toute la recherche, jamais de recherche sans commune.
  const token = calls.filter((c) => c.url.hostname === 'entreprise.francetravail.fr');
  assert.equal(token.length, 1);
  assert.equal(token[0].url.searchParams.get('realm'), '/partenaire');
  assert.equal(token[0].init.method, 'POST');
  assert.equal(new URLSearchParams(String(token[0].init.body)).get('scope'), 'api_offresdemploiv2 o2dsoffre');
  assert.equal((token[0].init.headers as Record<string, string>).Authorization, 'Basic ' + btoa('id:secret'));
  const ft = calls.filter((c) => c.url.pathname === '/partenaire/offresdemploi/v2/offres/search');
  assert.equal(ft.length, 1, 'Blois n’a pas de code INSEE : pas de recherche nationale');
  assert.deepEqual(Object.fromEntries(ft[0].url.searchParams), { motsCles: 'plombier', distance: '30', range: '0-19', commune: '45234', typeContrat: 'CDI,CDD' });
  assert.equal((ft[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
  // L'offre échue n'est pas gardée ; l'autre a reçu sa description détaillée.
  const ftOffers = out.offers.filter((o) => o.source === 'France Travail');
  assert.deepEqual(ftOffers.map((o) => o.ftId), ['190XQRN']);
  assert.match(ftOffers[0].summary, /détaillée/);
  // La Bonne Alternance : une ville avec coordonnées, les codes ROME du script, le hors-sujet écarté.
  const lba = calls.filter((c) => c.url.hostname === 'api.apprentissage.beta.gouv.fr');
  assert.equal(lba.length, 1);
  assert.equal(lba[0].url.searchParams.get('romes'), 'F1603,I1310,F1604,I1302');
  assert.equal(lba[0].url.searchParams.get('latitude'), '47.9029');
  assert.deepEqual(out.offers.filter((o) => o.source === 'La Bonne Alternance').map((o) => o.title), ['Apprenti plombier']);
  // Jooble : la clé dans le chemin, le corps du script.
  const jb = calls.find((c) => c.url.hostname === 'jooble.org');
  assert.equal(jb?.url.pathname, '/api/jooble');
  assert.deepEqual(JSON.parse(String(jb?.init.body)), { keywords: 'plombier', location: 'Orléans', radius: '30', resultonpage: 20 });
  // Careerjet et Adzuna : les paramètres du script.
  const cj = calls.find((c) => c.url.hostname === 'public.api.careerjet.net');
  assert.deepEqual(Object.fromEntries(cj!.url.searchParams), { keywords: 'plombier', location: 'Orléans', locale_code: 'fr_FR', affid: 'cj', pagesize: '20', sort: 'date' });
  const az = calls.find((c) => c.url.hostname === 'api.adzuna.com');
  assert.equal(az?.url.pathname, '/v1/api/jobs/fr/search/1');
  assert.deepEqual(Object.fromEntries(az!.url.searchParams), { app_id: 'az', app_key: 'azk', what: 'plombier', where: 'Orléans', distance: '30', results_per_page: '20', 'content-type': 'application/json', sort_by: 'date' });
  // L'ordre de priorité.
  assert.equal(out.offers[0].source, 'France Travail');
  assert.equal(out.offers.at(-1)?.source, 'Adzuna');
});

test('le jeton France Travail est gardé en mémoire d’une recherche à l’autre', async () => {
  resetFtToken();
  const { fetch, calls } = fakeFetch(standardApis());
  const keys = { ...ALL_KEYS, lbaApiKey: '', joobleApiKey: '', careerjetAffid: '', adzunaAppId: '' };
  await searchAll(SETTINGS, keys, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  await searchAll(SETTINGS, keys, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  assert.equal(calls.filter((c) => c.url.hostname === 'entreprise.francetravail.fr').length, 1);
});

test('une source sans secret est sautée et dite ; une source sans ville utilisable aussi', async () => {
  resetFtToken();
  const { fetch, calls } = fakeFetch(standardApis());
  const settings: Settings = { ...SETTINGS, locations: [SETTINGS.locations[1]] };
  const out = await searchAll(settings, { ...ALL_KEYS, ftClientSecret: '', adzunaAppKey: '' }, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  assert.equal(out.sources['France Travail'], 'not_configured');
  assert.equal(out.sources.Adzuna, 'not_configured');
  assert.equal(out.sources['La Bonne Alternance'], 'skipped');
  assert.ok(!calls.some((c) => c.url.hostname.includes('francetravail') || c.url.hostname === 'api.adzuna.com'));
});

test('une source qui échoue rend un code et n’arrête pas les autres', async () => {
  resetFtToken();
  const { fetch } = fakeFetch(
    standardApis({
      'entreprise.francetravail.fr': () => jsonResponse({ error: 'invalid_client' }, 401),
      'jooble.org': () => new Response('<html>', { status: 200 }),
      'public.api.careerjet.net': () => jsonResponse({ jobs: 'pas une liste' }),
      'api.adzuna.com': () => {
        throw new TypeError('network');
      },
    }),
  );
  const out = await searchAll(SETTINGS, ALL_KEYS, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  assert.deepEqual(out.sources, { 'France Travail': 'http_401', 'La Bonne Alternance': 1, Jooble: 'error', Careerjet: 'error', Adzuna: 'error' });
  assert.deepEqual(out.incomplete, ['France Travail', 'Jooble', 'Careerjet', 'Adzuna']);
});

test('délai par appel et budget commun : timeout, sans attendre', async () => {
  resetFtToken();
  const hang: Handler = (_url, init) =>
    new Promise((_, reject) => {
      const keep = setTimeout(() => {}, 5_000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(keep);
        reject(init.signal?.reason);
      });
    });
  const { fetch } = fakeFetch(standardApis({ 'jooble.org': hang, 'public.api.careerjet.net': () => jsonResponse({ error: 'quota' }, 429) }));
  const t = Date.now();
  const out = await searchAll(SETTINGS, { ...ALL_KEYS, ftClientId: '', lbaApiKey: '', adzunaAppId: '' }, { fetch, now: Date.now, deadline: Date.now() + 300, today: '2026-11-22' });
  assert.equal(out.sources.Jooble, 'timeout');
  assert.equal(out.sources.Careerjet, 'http_429');
  assert.ok(Date.now() - t < 2_000);
  // Budget déjà écoulé : rien ne part.
  const { fetch: f2, calls } = fakeFetch(standardApis());
  const late = await searchAll(SETTINGS, { ...ALL_KEYS, ftClientId: '' }, { fetch: f2, now: Date.now, deadline: Date.now() - 1, today: '2026-11-22' });
  assert.equal(calls.length, 0);
  assert.equal(late.sources.Jooble, 'timeout');
});

test('aucun mot-clé ni aucune ville dans les codes rendus', async () => {
  resetFtToken();
  const { fetch } = fakeFetch(() => {
    throw new Error('Échec pour plombier à Orléans');
  });
  const out = await searchAll(SETTINGS, ALL_KEYS, { fetch, now: Date.now, deadline: Date.now() + 60_000, today: '2026-11-22' });
  const text = JSON.stringify(out.sources);
  assert.ok(!/plombier|orl/i.test(text), text);
});
