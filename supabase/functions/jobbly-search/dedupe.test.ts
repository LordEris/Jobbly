// Épreuve du regroupement des doublons (Node 22.18+ : `node --test`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUrl,
  companyWords,
  dedupe,
  makeId,
  mergeGroup,
  placeOf,
  type RawOffer,
  type SourceName,
  sourcePriority,
  titleWords,
} from './rules.ts';
import { FIXTURES, scriptDedupe } from './fixtures.ts';

function raw(source: SourceName, title: string, f: Partial<RawOffer> = {}): RawOffer {
  return {
    source,
    title,
    company: f.company ?? '',
    location: f.location ?? '',
    url: f.url ?? '',
    date: f.date ?? '',
    expires: f.expires ?? '',
    summary: f.summary ?? '',
    contract: f.contract ?? '',
    ftId: f.ftId ?? '',
  };
}

test('URL canonique : hôte, www, ancre, barre finale, pistage, ordre des paramètres', () => {
  assert.equal(
    canonicalUrl('http://WWW.Example.COM/offres/123/?utm_source=x&b=2&gclid=z&a=1&xtor=AD-1&at_medium=m#apply'),
    'https://example.com/offres/123?a=1&b=2',
  );
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com');
  assert.equal(canonicalUrl('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com:8443/a'), 'https://example.com:8443/a');
  for (const p of ['ref', 'from', 'source', 'src', 'origin', 'trk', 'tracking', 'cmp', 'campaign', 'fbclid']) {
    assert.equal(canonicalUrl(`https://a.fr/x?${p}=jooble&id=9`), 'https://a.fr/x?id=9', p);
  }
  // `ref=123456` est l'identifiant de l'offre sur bien des sites : il reste.
  assert.equal(canonicalUrl('https://a.fr/offre.php?ref=123456'), 'https://a.fr/offre.php?ref=123456');
  assert.notEqual(canonicalUrl('https://a.fr/offre.php?ref=123456'), canonicalUrl('https://a.fr/offre.php?ref=123457'));
  assert.equal(canonicalUrl('javascript:alert(1)'), '');
  assert.equal(canonicalUrl('https://user:pw@a.fr/x'), '');
  assert.equal(canonicalUrl(42), '');
});

test('titre normalisé : genre, contrat, ville, code postal, mots vides', () => {
  assert.deepEqual(titleWords('Plombier H/F - Orléans (45)', '45 - ORLEANS'), ['plombier']);
  assert.deepEqual(titleWords('PLOMBIER (F/H)', 'Orléans'), ['plombier']);
  assert.deepEqual(titleWords('Technicien(ne) de maintenance H/F/X - CDI', ''), ['technicien', 'maintenance']);
  assert.deepEqual(titleWords('Plombier·e chauffagiste', ''), ['plombier', 'chauffagiste']);
  assert.deepEqual(titleWords('Électricien homme/femme en alternance', ''), ['electricien']);
  assert.deepEqual(titleWords('Plombier 45000 Orléans', '', ['Orléans']), ['plombier']);
  assert.deepEqual(titleWords('Apprenti(e) plombier chauffagiste - Apprentissage', 'Tours'), ['apprenti', 'plombier', 'chauffagiste']);
  assert.deepEqual(titleWords('Chauffagiste en intérim', ''), ['chauffagiste']);
});

test('entreprise normalisée : formes juridiques, groupe, sigles pointés, « confidentiel »', () => {
  assert.deepEqual(companyWords('SARL Dupont'), ['dupont']);
  assert.deepEqual(companyWords('Dupont'), ['dupont']);
  assert.deepEqual(companyWords('S.A.R.L. DUPONT'), ['dupont']);
  assert.deepEqual(companyWords('Groupe Dupont France'), ['dupont']);
  assert.deepEqual(companyWords('Ets Martin & Cie'), ['martin']);
  assert.deepEqual(companyWords('Confidentiel'), []);
  assert.deepEqual(companyWords('Entreprise confidentielle'), []);
});

test('lieu : département du code postal, de « 45 - ORLEANS », de « (45) » ; sinon la ville', () => {
  assert.deepEqual(placeOf('45 - ORLEANS'), { dept: '45', city: 'orleans' });
  assert.deepEqual(placeOf('45000 Orléans'), { dept: '45', city: 'orleans' });
  assert.deepEqual(placeOf('Orléans (45)'), { dept: '45', city: 'orleans' });
  assert.deepEqual(placeOf('Orléans, Loiret'), { dept: '', city: 'orleans' });
  assert.deepEqual(placeOf('St-Jean-de-Braye'), { dept: '', city: 'saint jean de braye' });
  assert.deepEqual(placeOf('97400 Saint-Denis'), { dept: '974', city: 'saint denis' });
  assert.deepEqual(placeOf('2A - AJACCIO'), { dept: '20', city: 'ajaccio' });
  assert.deepEqual(placeOf(''), { dept: '', city: '' });
});

test('cas réel : « Plombier H/F - Orléans (45) » ≡ « PLOMBIER (F/H) », « SARL Dupont » ≡ « Dupont »', () => {
  const { groups } = dedupe([
    raw('France Travail', 'Plombier H/F - Orléans (45)', { company: 'SARL Dupont', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/1', ftId: '1AAAA' }),
    raw('Jooble', 'PLOMBIER (F/H)', { company: 'Dupont', location: 'Orléans', url: 'https://fr.jooble.org/desc/1' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].source, 'France Travail');
});

test('cas réel : deux postes de la même entreprise ne fusionnent pas (plombier ≠ électricien)', () => {
  const intro = 'Entreprise familiale du Loiret, nous intervenons chez les particuliers pour installation, entretien et dépannage, avec une équipe de quinze personnes. Permis B exigé, véhicule fourni, mutuelle et tickets restaurant.';
  const { groups } = dedupe([
    raw('France Travail', 'Plombier H/F', { company: 'SARL Dupont', location: '45 - ORLEANS', summary: intro + ' Pose de sanitaires.', ftId: 'X1' }),
    raw('Careerjet', 'Électricien H/F', { company: 'Dupont', location: 'Orléans', summary: intro + ' Tableaux électriques.' }),
  ]);
  assert.equal(groups.length, 2);
});

test('fusion transitive : A~B et B~C donnent un seul groupe, sans que A~C se voie', () => {
  const desc = 'Nous recherchons un couvreur zingueur confirmé pour des chantiers de rénovation de toitures en ardoise et en tuile, gouttières et habillages en zinc, travail en hauteur, permis souhaité.';
  const a = raw('France Travail', 'Couvreur zingueur H/F', { company: 'Toitures Lemoine', location: '45 - ORLEANS', ftId: 'M1', url: 'https://candidat.francetravail.fr/offres/recherche/detail/M1' });
  // B : même titre que A (règle 2) ; même description que C (règle 3).
  const b = raw('Jooble', 'Couvreur-zingueur', { company: 'Lemoine', location: 'Orléans', summary: desc });
  // C : titre trop différent de A pour la règle 2, sans entreprise ; seule sa description la relie à B.
  const c = raw('Adzuna', 'Couvreur expérimenté toitures ardoise', { location: 'Orléans, Loiret', summary: desc + ' Salaire selon profil.' });
  const { groups, merges } = dedupe([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(merges[2], 1);
  assert.equal(merges[3], 1);
});

test('la transitivité ne relie pas deux entreprises par une offre sans entreprise', () => {
  const { groups } = dedupe([
    raw('Jooble', 'Plombier chauffagiste', { company: 'Cofely', location: 'Tours' }),
    raw('Careerjet', 'Plombier chauffagiste', { company: '', location: 'Tours' }),
    raw('Adzuna', 'Plombier chauffagiste', { company: 'Idex', location: 'Tours, Indre-et-Loire' }),
  ]);
  assert.equal(groups.length, 2);
  for (const g of groups) {
    const companies = new Set(g.map((o) => o.company).filter(Boolean));
    assert.ok(companies.size <= 1, 'deux entreprises dans un groupe');
  }
});

test('deux identifiants France Travail ne fusionnent jamais, même par un tiers', () => {
  const { groups } = dedupe([
    raw('France Travail', 'Plombier (H/F)', { company: 'ADECCO', location: '45 - ORLEANS', ftId: 'D1' }),
    raw('France Travail', 'Plombier (H/F)', { company: 'ADECCO', location: '45 - ORLEANS', ftId: 'D2' }),
    raw('Jooble', 'Plombier H/F', { company: 'Adecco', location: 'Orléans' }),
  ]);
  assert.equal(groups.length, 2);
});

test('même intitulé, même enseigne, deux départements : deux postes', () => {
  const desc = 'Engie Home Services recrute un chauffagiste pour l’entretien et le dépannage de chaudières gaz chez nos clients particuliers, visites annuelles, diagnostic des pannes, remplacement des pièces, véhicule fourni.';
  const { groups } = dedupe([
    raw('France Travail', 'Chauffagiste H/F', { company: 'ENGIE HOME SERVICES', location: '45 - ORLEANS', summary: desc, ftId: 'E1' }),
    raw('France Travail', 'Chauffagiste H/F', { company: 'ENGIE HOME SERVICES', location: '37 - TOURS', summary: desc, ftId: 'E2' }),
    raw('Adzuna', 'Chauffagiste (H/F)', { company: 'Engie Home Services', location: 'Tours, Indre-et-Loire', summary: desc }),
  ]);
  assert.equal(groups.length, 2);
});

test('sans entreprise des deux côtés : titre égal ET même lieu connu, sinon rien', () => {
  assert.equal(dedupe([raw('Jooble', 'Plombier', { location: 'Blois' }), raw('Careerjet', 'Plombier (H/F)', { location: 'Blois' })]).groups.length, 1);
  assert.equal(dedupe([raw('Jooble', 'Plombier', { location: 'Blois' }), raw('Careerjet', 'Plombier', { location: '' })]).groups.length, 2);
  assert.equal(dedupe([raw('Jooble', 'Plombier sanitaire', { location: 'Blois' }), raw('Careerjet', 'Plombier sanitaire confirmé', { location: 'Blois' })]).groups.length, 2);
});

test('même adresse canonique : une seule offre, malgré le pistage', () => {
  const { groups, merges } = dedupe([
    raw('France Travail', 'Plombier sanitaire H/F', { company: 'Martin', url: 'https://www.hellowork.com/fr-fr/emplois/56781234.html?utm_source=ft', ftId: 'G1' }),
    raw('Careerjet', 'Plombier Sanitaire - CDI - Tours', { url: 'https://hellowork.com/fr-fr/emplois/56781234.html' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(merges[1], 1);
});

test('une page commune à deux postes (page « carrières ») ne les fusionne pas', () => {
  const { groups } = dedupe([
    raw('Jooble', 'Plombier', { company: 'Martin', url: 'https://martin.fr/recrutement' }),
    raw('Careerjet', 'Comptable', { company: 'Martin', url: 'https://martin.fr/recrutement/' }),
  ]);
  assert.equal(groups.length, 2);
});

test('la représentante et la fusion : priorité, résumé, date, liens sans doublon, sources', async () => {
  const group = dedupe([
    raw('Adzuna', 'Plombier h/f', { company: 'Dupont SARL', location: 'Orléans, Loiret', url: 'https://www.adzuna.fr/details/1', summary: 'court', date: '2026-11-21', contract: 'permanent' }),
    raw('France Travail', 'Plombier H/F', { company: '', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/1A', summary: 'une description bien plus longue que les autres', date: '2026-11-18', ftId: '1A', expires: '2026-12-31' }),
    raw('Jooble', 'PLOMBIER (F/H)', { company: 'Dupont', location: 'Orléans', url: 'https://fr.jooble.org/desc/1', date: '2026-11-20' }),
    raw('Careerjet', 'Plombier', { company: 'Dupont', location: 'Orléans', url: 'https://fr.jooble.org/desc/1?utm_source=cj' }),
  ]).groups;
  assert.equal(group.length, 1);
  const m = mergeGroup(group[0]);
  assert.equal(m.data.source, 'France Travail');
  assert.equal(m.data.title, 'Plombier H/F');
  assert.equal(m.data.company, 'Dupont');
  assert.equal(m.data.location, '45 - ORLEANS');
  assert.equal(m.data.summary, 'une description bien plus longue que les autres');
  assert.equal(m.data.date, '2026-11-21');
  assert.equal(m.data.contract, 'permanent');
  assert.equal(m.data.expires, '2026-12-31');
  assert.deepEqual(m.data.sources, ['France Travail', 'Jooble', 'Careerjet', 'Adzuna']);
  assert.deepEqual(m.data.links.map((l) => l.source), ['France Travail', 'Jooble', 'Adzuna']);
  assert.equal(m.data.url, 'https://candidat.francetravail.fr/offres/recherche/detail/1A');
  // L'identifiant : sha256(url d'origine | titre), 32 caractères, stable.
  const id = await makeId(m.idUrl, m.data.title);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, await makeId('https://candidat.francetravail.fr/offres/recherche/detail/1A', 'Plombier H/F'));
});

test('jeu réaliste : bien plus de doublons trouvés que les 3 passes du script, et aucun poste confondu', () => {
  const ordered = [...FIXTURES].sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source));
  const truth = new Set(ordered.map((f) => f.truth));
  const { groups } = dedupe(ordered, ['Orléans', 'Tours']);
  const byOffer = new Map(ordered.map((f) => [f as RawOffer, f.truth]));

  // Nouveau regroupement : chaque groupe ne porte qu'un poste, et chaque poste tient en un groupe.
  for (const g of groups) assert.equal(new Set(g.map((o) => byOffer.get(o))).size, 1, 'deux postes fusionnés');
  assert.equal(groups.length, truth.size);

  // Le script : moins de doublons retirés, et des postes différents fusionnés.
  const script = scriptDedupe(ordered);
  const scriptFalse = script.filter((g) => new Set(g.map((i) => ordered[i].truth)).size > 1).length;
  const newDup = ordered.length - groups.length;
  const scriptDup = ordered.length - script.length;
  console.log(`  ${ordered.length} offres brutes, ${truth.size} postes réels`);
  console.log(`  script : ${script.length} offres, ${scriptDup} doublons retirés, ${scriptFalse} groupes mêlant deux postes`);
  console.log(`  nouveau : ${groups.length} offres, ${newDup} doublons retirés, 0 groupe mêlant deux postes`);
  assert.ok(newDup >= scriptDup + 6, `${newDup} contre ${scriptDup}`);
  assert.ok(scriptFalse > 0);
});

test('le regroupement tient sur un gros lot (borne de temps CPU)', () => {
  const lot: RawOffer[] = [];
  for (let i = 0; i < 1500; i++) {
    lot.push(raw(i % 2 ? 'Jooble' : 'Careerjet', `Plombier chauffagiste ${['confirmé', 'junior', 'sanitaire', 'dépannage'][i % 4]}`, {
      company: `Entreprise ${i % 300}`,
      location: ['Orléans', 'Tours', 'Blois'][i % 3],
      url: `https://example.org/job/${i}`,
      summary: `Annonce numéro ${i} pour un poste de plombier chauffagiste, installation et dépannage de chaudières, pose de sanitaires, déplacements fréquents dans le département, véhicule fourni.`,
    }));
  }
  const t = performance.now();
  dedupe(lot);
  const ms = performance.now() - t;
  console.log(`  1 500 offres regroupées en ${ms.toFixed(0)} ms`);
  assert.ok(ms < 3000);
});
