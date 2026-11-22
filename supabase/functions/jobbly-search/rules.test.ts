// Épreuve des règles d'entrée de la fonction et de l'hygiène des fichiers déployés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanText,
  corsHeaders,
  failureCode,
  fitData,
  GLOBAL_DAILY_LIMIT,
  isStorageLimit,
  MAX_DATA_BYTES,
  type OfferData,
  parseSettings,
  STATUS,
  USER_DAILY_LIMIT,
  validateBody,
  WEB_ORIGIN,
} from './rules.ts';

const here = (f: string) => new URL(f, import.meta.url);
const DEPLOYED = ['index.ts', 'rules.ts', 'sources.ts', 'links.ts'];
/** Le code sans ses commentaires de ligne (qui peuvent nommer ce qu'ils interdisent). */
const withoutComments = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('CORS : le site, et lui seul', () => {
  assert.equal(WEB_ORIGIN, 'https://jobbly.lorderis.dev');
  const ok = corsHeaders('https://jobbly.lorderis.dev');
  assert.equal(ok['Access-Control-Allow-Origin'], 'https://jobbly.lorderis.dev');
  assert.match(ok['Access-Control-Allow-Headers'], /authorization/);
  assert.match(ok['Access-Control-Allow-Headers'], /apikey/);
  for (const o of ['https://evil.example', 'http://jobbly.lorderis.dev', 'null', null]) {
    assert.deepEqual(corsHeaders(o), { Vary: 'Origin' });
  }
});

test('corps : `{}` ou rien, et rien d’autre', () => {
  assert.equal(validateBody(''), true);
  assert.equal(validateBody('{}'), true);
  assert.equal(validateBody(' { } '), true);
  assert.equal(validateBody('{"keywords":["x"]}'), false);
  assert.equal(validateBody('[]'), false);
  assert.equal(validateBody('nope'), false);
});

test('quota et codes : 30 par compte et par jour, 2 000 en tout ; refus métier lisibles (200)', () => {
  assert.equal(USER_DAILY_LIMIT, 30);
  assert.equal(GLOBAL_DAILY_LIMIT, 2000);
  assert.equal(STATUS.quota, 200);
  assert.equal(STATUS.no_settings, 200);
  assert.equal(STATUS.storage_limit, 200);
  assert.equal(STATUS.not_authenticated, 401);
  assert.equal(isStorageLimit('offer_limit_exceeded'), true);
  assert.equal(isStorageLimit('storage_limit_exceeded'), true);
  assert.equal(isStorageLimit('duplicate key'), false);
  assert.equal(isStorageLimit(undefined), false);
});

test('codes d’échec d’une source', () => {
  assert.equal(failureCode({ httpStatus: 503 }), 'http_503');
  assert.equal(failureCode({ name: 'TimeoutError' }), 'timeout');
  assert.equal(failureCode(new DOMException('x', 'AbortError')), 'timeout');
  assert.equal(failureCode(new Error('plombier à Orléans')), 'error');
  assert.equal(failureCode({ httpStatus: 9999 }), 'error');
  assert.equal(failureCode(null), 'error');
});

test('réglages : relus et bornés comme la base ; rien d’utilisable → null', () => {
  const s = parseSettings({
    keywords: ['plombier', 'x', 'plombier', 'chauffagiste', 42],
    locations: [
      { city: 'Orléans', radius: 30, insee: '45234', lat: 47.9, lon: 1.9 },
      { city: 'Ajaccio', radius: 10, insee: '2A004', lat: null, lon: null },
      { city: 'Tours', radius: 0 },
      { city: 'Blois', radius: 20, insee: '../..' },
    ],
    contract_types: ['CDI', 'cdd', 'MIS', 'ABCDEFGHIJK', 'CDI'],
  });
  assert.deepEqual(s, {
    keywords: ['plombier', 'chauffagiste'],
    locations: [
      { city: 'Orléans', radius: 30, insee: '45234', lat: 47.9, lon: 1.9 },
      { city: 'Ajaccio', radius: 10, insee: '2A004', lat: null, lon: null },
      { city: 'Blois', radius: 20, insee: '', lat: null, lon: null },
    ],
    contractTypes: ['CDI', 'MIS'],
  });
  assert.equal(parseSettings(null), null);
  assert.equal(parseSettings({ keywords: [], locations: [{ city: 'A', radius: 5 }] }), null);
  assert.equal(parseSettings({ keywords: ['ab'], locations: [] }), null);
  assert.equal(parseSettings({ keywords: 'plombier', locations: [] }), null);
});

test('texte d’une source : invisibles et balises retirés, coupé', () => {
  // Caractères invisibles écrits par leur code : pas d'échappement dans le fichier.
  const zw = String.fromCodePoint(0x200b);
  const rlo = String.fromCodePoint(0x202e);
  assert.equal(cleanText(`Plom${zw}bier ${rlo}<script>x</script><b>H/F</b>`, 100), 'Plom bier H/F');
  assert.equal(cleanText('a'.repeat(300), 200).length, 200);
  assert.equal(cleanText({}, 10), '');
});

test('data reste sous la borne de la base', () => {
  const big: OfferData = {
    title: 't', company: '', location: '', url: '', links: [], date: '', expires: '',
    source: 'Jooble', sources: ['Jooble'], summary: 'é'.repeat(80_000), contract: '',
  };
  const fitted = fitData(big);
  assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).byteLength <= MAX_DATA_BYTES);
  assert.ok(fitted.summary.length > 10_000);
});

test('fichiers déployés : pas d’échappement \\u, pas de lookbehind, pas de \\p{…}', () => {
  for (const f of DEPLOYED) {
    const src = withoutComments(readFileSync(here(f), 'utf8'));
    assert.ok(!/\\u[0-9a-fA-F{]/.test(src), `${f} : échappement \\u`);
    assert.ok(!src.includes('(?<=') && !src.includes('(?<!'), `${f} : lookbehind`);
    assert.ok(!/\\[pP]\{/.test(src), `${f} : classe \\p`);
  }
});

test('journaux : des codes seulement, jamais une valeur', () => {
  for (const f of DEPLOYED) {
    const src = readFileSync(here(f), 'utf8');
    for (const m of src.matchAll(/console\.(log|info|warn|error|debug)\(([^;]*)\);/g)) {
      const args = m[2];
      assert.ok(f === 'index.ts', `${f} ne journalise rien`);
      // Premier argument littéral ; le second, un code : `x.code`, `writeError`, ou un littéral.
      assert.match(args, /^'jobbly-search: [a-z_]+'(, ('[a-z_]+'|[a-zA-Z]+Error\.code \?\? 'unknown'|writeError|!db \? '[a-z]+' : '[a-z]+'))?$/, args);
    }
  }
});

test('la fusion n’envoie jamais statut, status_at, blocked ni first_seen d’une offre connue', () => {
  const src = readFileSync(here('index.ts'), 'utf8');
  const write = withoutComments(src.slice(src.indexOf('async function writePlan'), src.indexOf('Deno.serve')));
  assert.ok(!/status_at|blocked:|status:/.test(write));
  assert.ok(!/first_seen/.test(write.slice(0, write.indexOf('plan.insert'))));
});

test('config.toml : verify_jwt = true pour jobbly-search', () => {
  const toml = readFileSync(here('../../config.toml'), 'utf8');
  assert.match(toml, /\[functions\.jobbly-search\]\s*\nverify_jwt = true/);
});
