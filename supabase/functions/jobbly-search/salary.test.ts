// Épreuve de la rémunération : les formes que rendent les cinq sources,
// ramenées à des euros par mois, et ce qui ne se lit pas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeGroup,
  parseAdzuna,
  parseCareerjet,
  parseFranceTravail,
  parseJooble,
  type RawOffer,
  salaryFromNumbers,
  salaryFromText,
  toMonthly,
} from './rules.ts';

test('France Travail : la phrase de `salaire.libelle`', () => {
  assert.deepEqual(salaryFromText('Mensuel de 1801.80 Euros à 2200.00 Euros sur 12 mois'), {
    label: 'Mensuel de 1801.80 Euros à 2200.00 Euros sur 12 mois',
    min: 1802,
    max: 2200,
  });
  assert.deepEqual(salaryFromText('Mensuel de 2000.00 Euros sur 13 mois'), { label: 'Mensuel de 2000.00 Euros sur 13 mois', min: 2000, max: null });
  // L'heure : la durée légale mensuelle, 151,67 h.
  assert.equal(salaryFromText('Horaire de 12.00 Euros sur 12 mois')?.min, 1820);
  assert.deepEqual(salaryFromText('Annuel de 30000.00 Euros à 36000.00 Euros sur 12 mois'), {
    label: 'Annuel de 30000.00 Euros à 36000.00 Euros sur 12 mois',
    min: 2500,
    max: 3000,
  });
});

test('texte libre : séparateurs de milliers, virgule, k, unité absente', () => {
  assert.deepEqual(salaryFromText('30 000 € - 35 000 € par an'), { label: '30 000 € - 35 000 € par an', min: 2500, max: 2917 });
  assert.equal(salaryFromText('30 000 € par an')?.min, 2500);
  assert.equal(salaryFromText('12,50 €/h')?.min, 1896);
  assert.equal(salaryFromText('28k€')?.min, 2333);
  assert.equal(salaryFromText('1 801,80 € brut mensuel')?.min, 1802);
  assert.equal(salaryFromText('De 2 100 à 2 400 €')?.max, 2400);
  // Sans unité : l'ordre de grandeur la donne.
  assert.equal(salaryFromText('2 000 €')?.min, 2000);
  assert.equal(salaryFromText('42 000 €')?.min, 3500);
  assert.equal(salaryFromText('13 €')?.min, 1972);
  // Une durée de travail n'est pas un montant.
  assert.deepEqual(salaryFromText('2 200 € par mois, 35h/semaine'), { label: '2 200 € par mois, 35h/semaine', min: 2200, max: null });
  // Bornes inversées, bornes égales.
  assert.deepEqual(salaryFromText('2 500 € - 2 000 € par mois'), { label: '2 500 € - 2 000 € par mois', min: 2000, max: 2500 });
  assert.equal(salaryFromText('2 000 € à 2 000 € par mois')?.max, null);
});

test('ce qui ne se lit pas reste non indiqué, jamais zéro', () => {
  // Un texte sans montant garde son texte, sans nombre.
  assert.deepEqual(salaryFromText('Selon profil'), { label: 'Selon profil', min: null, max: null });
  assert.deepEqual(salaryFromText('À négocier selon expérience'), { label: 'À négocier selon expérience', min: null, max: null });
  // Un nombre sans devise n'est pas un salaire.
  assert.deepEqual(salaryFromText('Prime de 13e mois'), { label: 'Prime de 13e mois', min: null, max: null });
  // Un montant invraisemblable n'est pas gardé.
  assert.equal(salaryFromText('5 € par mois')?.min, null);
  assert.equal(salaryFromText(''), null);
  assert.equal(salaryFromText(undefined), null);
  assert.equal(salaryFromText(1800), null);
  assert.equal(salaryFromText('<script>x</script>2 000 €')?.label, '2 000 €');
  assert.equal(toMonthly(0, 'month'), null);
  assert.equal(toMonthly(Number.NaN, 'month'), null);
  assert.equal(toMonthly(100_000, 'month'), null);
});

test('nombres : devise, unité, estimation', () => {
  assert.deepEqual(salaryFromNumbers(30000, 36000, 'year', 'EUR', ''), { label: '', min: 2500, max: 3000 });
  assert.equal(salaryFromNumbers(30000, 36000, 'year', 'GBP', ''), null);
  assert.equal(salaryFromNumbers(null, undefined, 'year', 'EUR', ''), null);
  assert.deepEqual(salaryFromNumbers('2000', '', null, '', '2 000 € par mois'), { label: '2 000 € par mois', min: 2000, max: null });
});

test('sources : chacune lit son champ', () => {
  const ft = parseFranceTravail({ resultats: [{ id: '190AAAA', intitule: 'Plombier', salaire: { libelle: 'Mensuel de 2000.00 Euros sur 12 mois' } }] }, 'Orléans');
  assert.equal(ft?.[0].salary?.min, 2000);
  const ftNone = parseFranceTravail({ resultats: [{ id: '190AAAB', intitule: 'Plombier' }] }, 'Orléans');
  assert.equal(ftNone?.[0].salary, null);
  const jo = parseJooble({ jobs: [{ title: 'Plombier', link: 'https://fr.jooble.org/desc/1', salary: '2 300 € par mois', snippet: 'plombier' }] }, 'Orléans', 'plombier');
  assert.equal(jo?.[0].salary?.min, 2300);
  const cj = parseCareerjet({ jobs: [{ title: 'Plombier', url: 'https://www.careerjet.fr/jobad/fr1', salary: '25 000 € par an', salary_min: 25000, salary_max: 28000, salary_type: 'Y', salary_currency_code: 'EUR' }] }, 'Orléans');
  assert.deepEqual(cj?.[0].salary, { label: '25 000 € par an', min: 2083, max: 2333 });
  const cjText = parseCareerjet({ jobs: [{ title: 'Plombier', url: 'https://www.careerjet.fr/jobad/fr2', salary: '12 € de l\'heure' }] }, 'Orléans');
  assert.equal(cjText?.[0].salary?.min, 1820);
  const ad = parseAdzuna({ results: [{ id: '1', title: 'Plombier', salary_min: 24000, salary_max: 30000, salary_is_predicted: '0' }] }, 'Orléans');
  assert.deepEqual(ad?.[0].salary, { label: '', min: 2000, max: 2500 });
  // Une estimation d'Adzuna n'est pas une annonce.
  const adPredicted = parseAdzuna({ results: [{ id: '2', title: 'Plombier', salary_min: 24000, salary_max: 30000, salary_is_predicted: '1' }] }, 'Orléans');
  assert.equal(adPredicted?.[0].salary, null);
});

test('fusion : le premier montant lisible, sinon le premier texte, sinon rien', () => {
  const raw = (source: RawOffer['source'], salary: RawOffer['salary'], url: string): RawOffer => ({
    source, title: 'Plombier', company: 'Dupont', location: 'Orléans', url, date: '2026-11-20', expires: '', summary: '', contract: '', ftId: '', salary,
  });
  const a = mergeGroup([
    raw('France Travail', { label: 'Selon profil', min: null, max: null }, 'https://a.example/1'),
    raw('Jooble', { label: '2 300 € par mois', min: 2300, max: null }, 'https://b.example/1'),
  ]);
  assert.deepEqual(a.data.salary, { label: '2 300 € par mois', min: 2300, max: null });
  const b = mergeGroup([raw('France Travail', { label: 'Selon profil', min: null, max: null }, 'https://a.example/2')]);
  assert.deepEqual(b.data.salary, { label: 'Selon profil', min: null, max: null });
  const c = mergeGroup([raw('France Travail', null, 'https://a.example/3')]);
  assert.equal('salary' in c.data, false);
});
