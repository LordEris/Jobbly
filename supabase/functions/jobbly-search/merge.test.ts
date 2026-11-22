// Épreuve de la fusion avec les offres déjà rangées (`planMerge`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ExistingOffer, type FoundOffer, type OfferData, parseExisting, planMerge } from './rules.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const id = (c: string) => c.repeat(32);

function data(url = 'https://example.fr/offre/1'): OfferData {
  return {
    title: 'Plombier',
    company: 'Dupont',
    location: 'Orléans',
    url,
    links: [{ url, source: 'France Travail' }],
    date: '2026-11-20',
    expires: '',
    source: 'France Travail',
    sources: ['France Travail'],
    summary: '',
    contract: '',
  };
}
const found = (c: string, dead = false): FoundOffer => ({ id: id(c), data: data(), dead });
const known = (c: string, f: Partial<ExistingOffer> = {}): ExistingOffer => ({ id: id(c), status: '', blocked: false, gone_at: null, sources: ['France Travail'], ...f });

test('une offre nouvelle est créée, avec first_seen ; une connue est mise à jour sans statut ni first_seen', () => {
  const plan = planMerge([known('a', { status: 'postule' })], [found('a'), found('b')], NOW);
  assert.deepEqual(plan.insert.map((r) => r.id), [id('b')]);
  assert.equal(plan.insert[0].first_seen, NOW);
  assert.equal(plan.insert[0].last_seen, NOW);
  assert.equal(plan.insert[0].gone_at, null);
  assert.deepEqual(plan.update.map((r) => r.id), [id('a')]);
  const u = plan.update[0] as Record<string, unknown>;
  for (const k of ['status', 'status_at', 'blocked', 'first_seen']) assert.equal(k in u, false, `${k} ne doit pas partir`);
  assert.deepEqual(Object.keys(u).sort(), ['data', 'gone_at', 'id', 'last_seen']);
  assert.equal(u.gone_at, null);
  assert.deepEqual(plan.counts, { dead_links: 0, kept: 2, new: 1 });
});

test('une offre connue qui n’est plus rendue reçoit gone_at, une seule fois', () => {
  const plan = planMerge([known('a'), known('b', { gone_at: '2026-11-01T00:00:00Z' }), known('c', { status: 'entretien' })], [], NOW);
  assert.deepEqual(plan.gone.sort(), [id('a'), id('c')].sort());
  assert.deepEqual(plan.remove, []);
});

test('une source muette n’est pas une source vide : ses offres ne disparaissent pas', () => {
  const plan = planMerge(
    [
      known('a', { sources: ['Jooble'] }),
      known('b', { sources: ['France Travail', 'Jooble'] }),
      known('c', { sources: ['France Travail'] }),
      known('d', { sources: [] }),
    ],
    [],
    NOW,
    ['Jooble'],
  );
  assert.deepEqual(plan.gone, [id('c')]);
});

test('une offre revenue perd son gone_at', () => {
  const plan = planMerge([known('a', { gone_at: '2026-11-01T00:00:00Z' })], [found('a')], NOW);
  assert.equal(plan.update[0].gone_at, null);
  assert.deepEqual(plan.gone, []);
});

test('offre morte sans statut ni signalement : supprimée ; nouvelle et morte : jamais créée', () => {
  const plan = planMerge([known('a')], [found('a', true), found('b', true)], NOW);
  assert.deepEqual(plan.remove, [id('a')]);
  assert.deepEqual(plan.insert, []);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.counts, { dead_links: 2, kept: 0, new: 0 });
});

test('offre morte avec un statut, ou signalée : gardée, marquée link_dead, sans lien', () => {
  const plan = planMerge([known('a', { status: 'attente' }), known('b', { blocked: true })], [found('a', true), found('b', true)], NOW);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.update.length, 2);
  for (const u of plan.update) {
    assert.equal(u.data.link_dead, true);
    assert.equal(u.data.url, '');
    assert.equal(u.data.links.length, 1, 'les liens restent pour mémoire');
  }
  assert.equal(plan.counts.kept, 2);
});

test('une offre revivante perd son marquage link_dead', () => {
  const live: FoundOffer = { id: id('a'), data: { ...data(), link_dead: true }, dead: false };
  const plan = planMerge([known('a', { status: 'postule' })], [live], NOW);
  assert.equal('link_dead' in plan.update[0].data, false);
});

test('un identifiant rendu deux fois ne compte qu’une fois', () => {
  const plan = planMerge([], [found('a'), found('a')], NOW);
  assert.equal(plan.insert.length, 1);
  assert.equal(plan.counts.new, 1);
});

test('lecture des lignes existantes : identifiant valide seulement, valeurs absentes ramenées', () => {
  assert.deepEqual(parseExisting({ id: id('a'), status: 'postule', blocked: true, gone_at: null, sources: ['Jooble', 'Inconnue', 3] }), {
    id: id('a'),
    status: 'postule',
    blocked: true,
    gone_at: null,
    sources: ['Jooble'],
  });
  assert.equal(parseExisting({ id: 'pas-un-id' }), null);
  assert.equal(parseExisting(null), null);
  assert.deepEqual(parseExisting({ id: id('b') }), { id: id('b'), status: '', blocked: false, gone_at: null, sources: [] });
});
