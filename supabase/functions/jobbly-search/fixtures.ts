// ────────────────────────────────────────────────────────────────────────────
// Jeu d'épreuve du regroupement : 32 offres écrites à la main, recopiées des
// formes que rendent les cinq sources (titres en capitales de France Travail,
// « (F/H) » de Jooble, lieux « Orléans, Loiret » d'Adzuna, adresses avec
// pistage…). Chaque offre porte `truth` : le poste réel. Deux offres de même
// `truth` sont la même annonce ; deux `truth` différents sont deux postes.
//
// Sert aussi de référence : `scriptDedupe` rejoue les 3 passes de
// `job_alert.py` (`collect_all`), pour mesurer ce que le nouveau regroupement
// fusionne de plus — et ce que l'ancien fusionnait à tort.
// Fichier de test : la fonction ne l'importe pas.
// ────────────────────────────────────────────────────────────────────────────
import type { RawOffer, SourceName } from './rules.ts';

export type Fixture = RawOffer & { truth: string };

const DUPONT_INTRO =
  "Entreprise familiale implantée dans le Loiret depuis 1987, Dupont intervient chez les particuliers et les collectivités pour l'installation, l'entretien et le dépannage. Nous recherchons pour renforcer notre équipe d'Orléans un collaborateur motivé.";
const PLOMBIER_A =
  DUPONT_INTRO +
  " Vos missions : installation de réseaux d'eau chaude et d'eau froide, pose d'appareils sanitaires, raccordement des évacuations, remplacement de chauffe-eau et de ballons thermodynamiques, recherche de fuites et dépannage. Vous travaillez en binôme sur nos chantiers de rénovation. Permis B exigé, véhicule de service fourni. CAP plomberie souhaité.";
const ELEC_B =
  DUPONT_INTRO +
  " Vos missions : mise en conformité de tableaux électriques, tirage de câbles, pose de prises et d'éclairages, installation de bornes de recharge, dépannage chez les particuliers. Habilitation électrique BR souhaitée. Permis B exigé, véhicule de service fourni.";
const THERMI =
  "Thermi Services, entreprise de chauffage et sanitaire à Tours, accueille un apprenti en alternance pour préparer un CAP Monteur en installations thermiques. Vous accompagnerez nos techniciens sur la pose de chaudières, de pompes à chaleur, de radiateurs et sur les travaux de plomberie. Rythme école entreprise selon le CFA. Débutant accepté, motivation et sérieux attendus.";
const ADECCO_1 =
  "Adecco recherche pour son client, entreprise du bâtiment, un plombier pour une mission de longue durée. Vous réalisez les installations sanitaires et le raccordement des réseaux sur chantier neuf. Expérience de deux ans exigée. Taux horaire selon profil, panier repas et indemnités de déplacement.";
const ADECCO_2 =
  "Adecco recherche pour son client, entreprise du bâtiment, un plombier pour une mission de longue durée. Vous réalisez la rénovation de salles de bains et le remplacement d'équipements sanitaires en logement occupé. Expérience de deux ans exigée. Taux horaire selon profil, panier repas et indemnités de déplacement.";
const ENGIE =
  "Engie Home Services recrute un chauffagiste pour l'entretien et le dépannage de chaudières gaz chez nos clients particuliers. Vous assurez les visites d'entretien annuelles, le diagnostic des pannes et le remplacement des pièces. Formation interne assurée, véhicule et outillage fournis, primes sur objectifs.";
const DALKIA =
  "Rattaché au responsable d'exploitation, vous assurez la maintenance préventive et corrective des installations de chauffage, ventilation et climatisation de sites tertiaires. Vous réalisez les relevés, les réglages et les interventions de dépannage, et vous rédigez les comptes rendus d'intervention. Astreintes ponctuelles, véhicule de service.";
const HELLOWORK =
  "Plomberie Martin recherche un plombier sanitaire pour ses chantiers de rénovation à Tours et alentours. Pose de sanitaires, de réseaux multicouche et cuivre, création de salles de bains clés en main.";
const COUVREUR =
  "Toitures Lemoine recherche un couvreur zingueur confirmé pour des chantiers de rénovation de toitures en ardoise et en tuile, la pose de gouttières et d'habillages en zinc. Travail en hauteur, port des équipements de sécurité obligatoire. Permis B souhaité.";

function o(source: SourceName, truth: string, f: Partial<RawOffer> & { title: string }): Fixture {
  return {
    source,
    truth,
    title: f.title,
    company: f.company ?? '',
    location: f.location ?? '',
    url: f.url ?? '',
    date: f.date ?? '2026-11-20',
    expires: f.expires ?? '',
    summary: f.summary ?? '',
    contract: f.contract ?? '',
    ftId: f.ftId ?? '',
  };
}

const words = (s: string, n: number) => s.split(' ').slice(0, n).join(' ') + '…';

export const FIXTURES: Fixture[] = [
  // A — Plombier chez Dupont, Orléans : cinq sources, cinq formes.
  o('France Travail', 'A', { title: 'Plombier H/F - Orléans (45)', company: 'SARL DUPONT', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/190XQRM', summary: PLOMBIER_A, contract: 'Contrat à durée indéterminée', ftId: '190XQRM', date: '2026-11-18' }),
  o('Jooble', 'A', { title: 'PLOMBIER (F/H)', company: 'Dupont', location: 'Orléans', url: 'https://fr.jooble.org/desc/-8123456789012345678', summary: words(PLOMBIER_A.slice(DUPONT_INTRO.length), 22), date: '2026-11-19' }),
  o('Careerjet', 'A', { title: 'Plombier (H/F)', company: 'DUPONT', location: 'Orléans, Centre-Val de Loire', url: 'https://www.careerjet.fr/jobad/fr8a1b2c3d4e5f60718293a4b5c6d7e8f9?utm_source=api&utm_medium=feed', summary: words(PLOMBIER_A, 30) }),
  o('Adzuna', 'A', { title: 'Plombier h/f', company: 'Dupont SARL', location: 'Orléans, Loiret', url: 'https://www.adzuna.fr/details/4512345678', summary: words(PLOMBIER_A.slice(DUPONT_INTRO.length), 40), contract: 'permanent' }),
  o('Jooble', 'A', { title: 'Plombier H/F', company: 'Groupe Dupont', location: 'Orléans (45)', url: 'https://fr.jooble.org/desc/-5512345678901234567?ckey=plombier', summary: '' }),

  // B — Électricien chez le même Dupont : même présentation d'entreprise, autre poste.
  o('France Travail', 'B', { title: 'Electricien H/F', company: 'SARL DUPONT', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/190XQRN', summary: ELEC_B, ftId: '190XQRN' }),
  o('Careerjet', 'B', { title: 'Électricien du bâtiment (H/F)', company: 'Dupont', location: 'Orléans', url: 'https://www.careerjet.fr/jobad/fr11223344556677889900aabbccddeeff', summary: words(ELEC_B, 45) }),

  // C — Apprenti plombier chauffagiste chez Thermi Services, Tours (alternance).
  o('France Travail', 'C', { title: 'Apprenti plombier chauffagiste H/F', company: 'THERMI SERVICES SAS', location: '37 - TOURS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/191ABCD', summary: THERMI, ftId: '191ABCD', contract: 'Contrat apprentissage' }),
  o('La Bonne Alternance', 'C', { title: 'Apprenti(e) plombier chauffagiste', company: 'THERMI SERVICES', location: 'Tours', url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/partner/6789abcdef0123456789abcd', summary: THERMI, contract: 'Apprentissage' }),
  o('Jooble', 'C', { title: 'Apprenti Plombier-Chauffagiste (H/F) - Alternance', company: 'Thermi Services', location: 'Tours (37)', url: 'https://fr.jooble.org/desc/1234509876543210987', summary: words(THERMI, 25) }),
  o('Careerjet', 'C', { title: 'Alternance - Apprenti plombier chauffagiste', company: 'Thermi', location: 'Tours, Centre-Val de Loire', url: 'https://www.careerjet.fr/jobad/fr99887766554433221100ffeeddccbbaa?from=api', summary: words(THERMI, 18) }),

  // D1, D2 — deux missions Adecco, même intitulé, même ville : deux identifiants France Travail.
  o('France Travail', 'D1', { title: 'Plombier (H/F)', company: 'ADECCO', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/192QQQA', summary: ADECCO_1, ftId: '192QQQA', contract: 'Mission intérimaire' }),
  o('France Travail', 'D2', { title: 'Plombier (H/F)', company: 'ADECCO', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/192QQQB', summary: ADECCO_2, ftId: '192QQQB', contract: 'Mission intérimaire' }),

  // E1, E2 — même enseigne, même intitulé, deux villes : deux postes.
  o('France Travail', 'E1', { title: 'Chauffagiste H/F', company: 'ENGIE HOME SERVICES', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/193EEEA', summary: ENGIE, ftId: '193EEEA' }),
  o('France Travail', 'E2', { title: 'Chauffagiste H/F', company: 'ENGIE HOME SERVICES', location: '37 - TOURS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/193EEEB', summary: ENGIE, ftId: '193EEEB' }),
  o('Adzuna', 'E1', { title: 'Chauffagiste (H/F)', company: 'Engie Home Services', location: 'Orléans, Loiret', url: 'https://www.adzuna.fr/details/4599990001', summary: words(ENGIE, 30) }),
  o('Adzuna', 'E2', { title: 'Chauffagiste (H/F)', company: 'Engie Home Services', location: 'Tours, Indre-et-Loire', url: 'https://www.adzuna.fr/details/4599990002', summary: words(ENGIE, 30) }),

  // F — Technicien de maintenance CVC chez Dalkia.
  o('France Travail', 'F', { title: 'Technicien de maintenance CVC H/F', company: 'DALKIA FRANCE', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/194FFFF', summary: DALKIA, ftId: '194FFFF' }),
  o('Adzuna', 'F', { title: 'Technicien maintenance CVC (H/F/X)', company: 'DALKIA', location: 'Orléans, Loiret', url: 'https://www.adzuna.fr/details/4511112222', summary: words(DALKIA, 35) }),
  o('Careerjet', 'F', { title: 'Technicien de Maintenance CVC - CDI', company: 'Dalkia', location: 'Orléans', url: 'https://www.careerjet.fr/jobad/fr0102030405060708090a0b0c0d0e0f10', summary: words(DALKIA, 20) }),

  // G — la même page HelloWork, citée par France Travail et Careerjet, avec et sans pistage.
  o('France Travail', 'G', { title: 'Plombier sanitaire H/F', company: 'PLOMBERIE MARTIN', location: '37 - TOURS', url: 'https://www.hellowork.com/fr-fr/emplois/56781234.html?utm_source=francetravail&utm_medium=partner', summary: HELLOWORK, ftId: '195GGGG' }),
  o('Careerjet', 'G', { title: 'Plombier Sanitaire - CDI - Tours', company: '', location: 'Tours', url: 'https://hellowork.com/fr-fr/emplois/56781234.html', summary: words(HELLOWORK, 14) }),

  // J — Aide plombier, Manpower.
  o('France Travail', 'J', { title: 'AIDE PLOMBIER (H/F)', company: 'MANPOWER', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/196JJJJ', ftId: '196JJJJ', summary: 'Mission de 3 mois.' }),
  o('Jooble', 'J', { title: 'Aide-plombier (h/f)', company: 'Manpower France', location: 'Orléans', url: 'https://fr.jooble.org/desc/7777777777777777777' }),

  // K — Plombier chauffagiste Cofely, écritures inclusives.
  o('Jooble', 'K', { title: 'Plombier·e chauffagiste', company: 'Cofely', location: 'Tours', url: 'https://fr.jooble.org/desc/8888888888888888881' }),
  o('Careerjet', 'K', { title: 'Plombier chauffagiste H/F', company: 'COFELY SAS', location: 'Tours, Centre-Val de Loire', url: 'https://www.careerjet.fr/jobad/fr5555555555555555555555555555555a' }),
  o('Adzuna', 'K', { title: 'Plombier/Plombière chauffagiste', company: 'Cofely', location: 'Tours, Indre-et-Loire', url: 'https://www.adzuna.fr/details/4588880000' }),

  // L — sans entreprise des deux côtés, même titre, même ville.
  o('Jooble', 'L', { title: 'Plombier chauffagiste confirmé', company: '', location: 'Blois', url: 'https://fr.jooble.org/desc/9999999999999999991' }),
  o('Careerjet', 'L', { title: 'Plombier Chauffagiste Confirmé (H/F)', company: 'Confidentiel', location: 'Blois, Centre-Val de Loire', url: 'https://www.careerjet.fr/jobad/fr6666666666666666666666666666666b' }),

  // M — Couvreur zingueur, Lemoine : formes du nom d'entreprise.
  o('France Travail', 'M', { title: 'Couvreur zingueur H/F', company: 'TOITURES LEMOINE', location: '45 - ORLEANS', url: 'https://candidat.francetravail.fr/offres/recherche/detail/197MMMM', summary: COUVREUR, ftId: '197MMMM' }),
  o('Careerjet', 'M', { title: 'Couvreur Zingueur Confirmé (H/F)', company: 'Lemoine Toitures', location: 'Orléans', url: 'https://www.careerjet.fr/jobad/fr7777777777777777777777777777777c', summary: words(COUVREUR, 20) }),

  // N — offre seule.
  o('La Bonne Alternance', 'N', { title: 'Apprenti couvreur', company: 'Charpentes du Val', location: 'Olivet', url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/partner/aaaabbbbccccdddd11112222' }),
];

// ── Les 3 passes du script, rejouées à l'identique ───────────────────────────

const SCRIPT_STOPWORDS = new Set([
  'h/f', 'f/h', '(h/f)', '(f/h)', 'hf', 'fh', 'cdi', 'cdd', 'alternance',
  'apprentissage', 'stage', 'contrat', 'poste', 'offre', 'emploi',
  'recherche', 'urgent',
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'en', 'et', 'ou',
  'au', 'aux', 'ce', 'se', 'sa', 'son', 'ses', 'nous', 'vous', 'ils',
  'elles', 'que', 'qui', 'sur', 'par', 'pour', 'dans', 'avec', 'est',
  'sont', 'avoir', 'faire', 'plus', 'tout', 'tous', 'bien', 'votre',
  'notre', 'vos', 'nos', 'leur', 'leurs', 'pas', 'ne', 'si', 'très',
]);

function scriptNormalize(text: string): string {
  let ascii = '';
  for (const ch of text.normalize('NFD')) if ((ch.codePointAt(0) ?? 0) < 128) ascii += ch;
  const cleaned = ascii.toLowerCase().replace(/[^A-Za-z0-9_\s]/g, ' ');
  return cleaned.split(/\s+/).filter((w) => w && !SCRIPT_STOPWORDS.has(w) && w.length > 2).join(' ');
}
const wordSet = (t: string) => new Set(scriptNormalize(t).split(' ').filter(Boolean));
function scriptSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return Math.max(inter / (a.size + b.size - inter), inter / Math.min(a.size, b.size));
}

/** `collect_all` du script, passes 1 à 3 : rend les groupes (indices dans l'entrée). */
export function scriptDedupe(raw: RawOffer[]): number[][] {
  type J = { idx: number[]; url: string; title: string; company: string; words: Set<string>; tkey: string };
  const seen = new Set<string>();
  const afterUrl: J[] = [];
  raw.forEach((r, i) => {
    const key = r.url || `${r.title}|${r.source}`;
    if (seen.has(key)) {
      afterUrl.find((j) => (j.url || '') === r.url)?.idx.push(i);
      return;
    }
    seen.add(key);
    const t = scriptNormalize(r.title).split(' ').filter(Boolean).slice(0, 6);
    const c = scriptNormalize(r.company).split(' ').filter(Boolean).slice(0, 3);
    afterUrl.push({ idx: [i], url: r.url, title: r.title, company: r.company, words: wordSet(r.summary), tkey: t.join('|') + '§' + c.join('|') });
  });
  const byKey = new Map<string, J>();
  const afterTitle: J[] = [];
  for (const j of afterUrl) {
    if (!j.tkey.replace(/[|§]/g, '')) {
      afterTitle.push(j);
      continue;
    }
    const first = byKey.get(j.tkey);
    if (!first) {
      byKey.set(j.tkey, j);
      afterTitle.push(j);
    } else first.idx.push(...j.idx);
  }
  const final: J[] = [];
  for (const j of afterTitle) {
    if (j.words.size < 12) {
      final.push(j);
      continue;
    }
    let matched = false;
    for (const e of final) {
      if (e.words.size < 12) continue;
      const min = Math.min(j.words.size, e.words.size);
      const max = Math.max(j.words.size, e.words.size);
      if (max > 0 && min / max < 0.55) continue;
      if (scriptSimilarity(j.words, e.words) >= 0.55) {
        e.idx.push(...j.idx);
        e.words = new Set([...e.words, ...j.words]);
        matched = true;
        break;
      }
    }
    if (!matched) final.push(j);
  }
  return final.map((j) => j.idx);
}
