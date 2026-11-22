// tools/demo-data.mjs — le jeu de démonstration de tools/check-site.mjs.
//
// Des offres INVENTÉES, aux noms d'entreprise imaginaires : elles servent aux
// vérifications et aux captures de la présentation, et la page le dit
// (« données de démonstration »). Jamais celles d'une vraie personne.

const day = (n) => new Date(Date.UTC(2026, 10, 22, 9, 0) - n * 86400e3).toISOString()
const hex = (n) => n.toString(16).padStart(32, '0')

export const USER = { id: 'a1a1a1a1-0000-4000-8000-000000000001', email: 'camille.demo@exemple.fr' }

export const SETTINGS = {
  user_id: USER.id,
  keywords: ['plombier', 'apprenti plombier', 'plombier chauffagiste'],
  locations: [
    { city: 'Orléans', radius: 30, insee: '45234', lat: 47.9029, lon: 1.9097 },
    { city: 'Tours', radius: 30, insee: '37261', lat: 47.3941, lon: 0.6848 },
  ],
  contract_types: [],
  min_salary: null,
  updated_at: day(3),
}

const DESC = 'Au sein d\'une équipe de quatre techniciens, vous intervenez chez des particuliers et des copropriétés :\n\n· installation et remplacement de chauffe-eau, de radiateurs et de sanitaires ;\n· dépannage de fuites et d\'évacuations ;\n· mise en service de chaudières gaz à condensation.\n\nPermis B exigé, véhicule de service fourni. Débutant accepté, formation assurée.'

const offer = (n, data, extra = {}) => ({
  id: hex(n),
  data: { summary: DESC, ...data },
  first_seen: extra.first_seen || day(n),
  last_seen: day(0),
  gone_at: extra.gone_at || null,
  status: extra.status || '',
  status_at: extra.status ? day(1) : null,
  blocked: false,
})

export const OFFERS = [
  offer(1, { salary: { label: 'Mensuel de 2100.00 Euros à 2400.00 Euros sur 12 mois', min: 2100, max: 2400 }, title: 'Plombier chauffagiste H/F', company: 'Thermique du Loiret', location: '45 - Orléans', contract: 'CDI', date: '2026-11-21', expires: '2026-12-31', source: 'France Travail', sources: ['France Travail', 'Jooble', 'Adzuna'], url: 'https://candidat.francetravail.fr/offres/recherche/detail/123ABC', links: [{ url: 'https://candidat.francetravail.fr/offres/recherche/detail/123ABC', source: 'France Travail' }, { url: 'https://fr.jooble.org/desc/1234', source: 'Jooble' }, { url: 'https://www.adzuna.fr/details/5678', source: 'Adzuna' }] }, { first_seen: day(0) }),
  offer(2, { title: 'Apprenti plombier (F/H) — CAP Monteur en installations sanitaires', company: 'Les Artisans du Val', location: 'Tours (37)', contract: 'Apprentissage', date: '2026-11-20', source: 'La Bonne Alternance', sources: ['La Bonne Alternance'], url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/abc', links: [{ url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/abc', source: 'La Bonne Alternance' }] }, { first_seen: day(0) }),
  offer(3, { salary: { label: '1 750 € par mois', min: 1750, max: null }, title: 'Plombier dépanneur', company: 'Eau Service Centre', location: 'Saint-Jean-de-Braye (45)', contract: 'CDD 6 mois', date: '2026-11-18', source: 'Careerjet', sources: ['Careerjet', 'Jooble'], url: 'https://www.careerjet.fr/jobad/fr123', links: [{ url: 'https://www.careerjet.fr/jobad/fr123', source: 'Careerjet' }, { url: 'https://fr.jooble.org/desc/999', source: 'Jooble' }] }, { status: 'postule', first_seen: day(4) }),
  offer(4, { salary: { label: '', min: 2000, max: 2500 }, title: 'Chauffagiste — maintenance de chaudières', company: 'Confort Habitat 37', location: 'Joué-lès-Tours (37)', contract: 'CDI', date: '2026-11-15', source: 'Adzuna', sources: ['Adzuna'], url: 'https://www.adzuna.fr/details/4242', links: [{ url: 'https://www.adzuna.fr/details/4242', source: 'Adzuna' }] }, { status: 'entretien', first_seen: day(7) }),
  offer(5, { salary: { label: 'Selon profil', min: null, max: null }, title: 'Plombier sanitaire H/F', company: 'Bâti Loire Services', location: 'Olivet (45)', contract: 'Intérim', date: '2026-11-12', source: 'Jooble', sources: ['Jooble'], url: 'https://fr.jooble.org/desc/555', links: [{ url: 'https://fr.jooble.org/desc/555', source: 'Jooble' }] }, { first_seen: day(10) }),
  offer(6, { title: 'Alternance — technicien de maintenance CVC', company: 'Climatech Orléans', location: 'Fleury-les-Aubrais (45)', contract: 'Contrat de professionnalisation', date: '2026-11-10', source: 'France Travail', sources: ['France Travail', 'La Bonne Alternance'], url: 'https://candidat.francetravail.fr/offres/recherche/detail/777XYZ', links: [{ url: 'https://candidat.francetravail.fr/offres/recherche/detail/777XYZ', source: 'France Travail' }, { url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/xyz', source: 'La Bonne Alternance' }] }, { first_seen: day(12) }),
  offer(7, { title: 'Plombier en rénovation de salles de bain', company: 'Atelier Bain & Co', location: 'Tours (37)', contract: 'CDI', date: '2026-11-02', source: 'Careerjet', sources: ['Careerjet'], url: '', link_dead: true, links: [] }, { status: 'attente', gone_at: day(2), first_seen: day(20) }),
  offer(8, { title: 'Aide plombier', company: 'Rénov\'Express', location: 'Blois (41)', contract: 'CDD', date: '2026-10-28', source: 'Jooble', sources: ['Jooble'], url: 'https://fr.jooble.org/desc/888', links: [{ url: 'https://fr.jooble.org/desc/888', source: 'Jooble' }] }, { gone_at: day(5), first_seen: day(25) }),
  offer(9, { title: 'Monteur en installations thermiques', company: 'Sud Loire Énergie', location: 'Orléans (45)', contract: 'CDI', date: '2026-10-25', source: 'Adzuna', sources: ['Adzuna'], url: 'https://www.adzuna.fr/details/9999', links: [{ url: 'https://www.adzuna.fr/details/9999', source: 'Adzuna' }] }, { status: 'ignore', first_seen: day(26) }),
]

/** Ce qu'une recherche réussie ajoute : deux offres neuves. */
export const NEW_OFFERS = [
  offer(10, { title: 'Plombier H/F', company: 'Hydro Centre', location: 'Orléans (45)', contract: 'CDI', date: '2026-11-22', source: 'France Travail', sources: ['France Travail'], url: 'https://candidat.francetravail.fr/offres/recherche/detail/NEW1', links: [{ url: 'https://candidat.francetravail.fr/offres/recherche/detail/NEW1', source: 'France Travail' }] }, { first_seen: new Date().toISOString() }),
  offer(11, { title: 'Apprentie plombière — BP', company: 'Sanitaires Touraine', location: 'Tours (37)', contract: 'Apprentissage', date: '2026-11-22', source: 'La Bonne Alternance', sources: ['La Bonne Alternance'], url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/new2', links: [{ url: 'https://labonnealternance.apprentissage.beta.gouv.fr/emploi/new2', source: 'La Bonne Alternance' }] }, { first_seen: new Date().toISOString() }),
]

export const SEARCH_OK = {
  ok: true,
  counts: { raw: 63, duplicates: 18, dead_links: 4, kept: 11, new: 2 },
  sources: { 'France Travail': 21, 'La Bonne Alternance': 'skipped', Jooble: 'timeout', Careerjet: 14, Adzuna: 'not_configured' },
}

export const COMMUNES = [
  { nom: 'Orléans', code: '45234', codeDepartement: '45', centre: { type: 'Point', coordinates: [1.9097, 47.9029] } },
  { nom: 'Orléat', code: '63265', codeDepartement: '63', centre: { type: 'Point', coordinates: [3.4166, 45.8619] } },
]
