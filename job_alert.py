#!/usr/bin/env python3
"""
Alerte Emploi - Surveillance automatique d'offres d'emploi
Génère un rapport HTML des nouvelles offres à chaque exécution.

Sources utilisées :
  1. France Travail      (API officielle, gratuite) — inscription requise
  2. La Bonne Alternance (API gouvernementale alternance, sans clé)
  3. Jooble              (agrégateur mondial, gratuit) — inscription requise
  4. Careerjet           (agrégateur FR, gratuit)    — inscription requise
  5. Adzuna              (agrégateur mondial, gratuit) — inscription requise

════════════════════════════════════════════════════════════════
CONFIGURATION INITIALE — à faire une seule fois
════════════════════════════════════════════════════════════════

── Source 1 : France Travail ──────────────────────────────────
  1. Allez sur https://francetravail.io/data/api
  2. Créez un compte (gratuit)
  3. Créez une nouvelle application → sélectionnez l'API "Offres d'emploi v2"
  4. Notez le "Client ID" et le "Client Secret"
  5. Renseignez-les dans le fichier .env : FT_CLIENT_ID et FT_CLIENT_SECRET

── Source 2 : La Bonne Alternance ─────────────────────────────
  1. Allez sur https://api.apprentissage.beta.gouv.fr
  2. Créez un compte gratuit → générez une clé API
  3. Renseignez-la dans le fichier .env : LBA_API_KEY

── Source 3 : Jooble ──────────────────────────────────────────
  1. Allez sur https://jooble.org/api/about
  2. Demandez une clé API gratuite (formulaire en ligne)
  3. Renseignez-la dans le fichier .env : JOOBLE_API_KEY

── Source 4 : Careerjet ───────────────────────────────────────
  1. Allez sur https://www.careerjet.fr/partenaires/api
  2. Inscrivez-vous gratuitement (affiliate ID)
  3. Renseignez-le dans le fichier .env : CAREERJET_AFFID

── Source 5 : Adzuna ──────────────────────────────────────────
  1. Allez sur https://developer.adzuna.com/signup
  2. Créez un compte (gratuit, 250 appels/mois offerts)
  3. Copiez votre "Application ID" et "Application Key"
  4. Renseignez-les dans le fichier .env : ADZUNA_APP_ID et ADZUNA_APP_KEY
════════════════════════════════════════════════════════════════
"""

import requests
import json
import hashlib
import html
import ipaddress
import functools
import os
import re
import time
import unicodedata
import argparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from urllib.parse import urlparse
from bs4 import BeautifulSoup

# ── Chemins ──────────────────────────────────────────────────────────────────────
BASE_DIR     = Path(__file__).parent
SEEN_FILE    = BASE_DIR / "seen_jobs.json"
REPORT_FILE  = BASE_DIR / "rapport_offres.html"
STATUS_FILE  = BASE_DIR / "status_jobs.json"
CACHE_FILE   = BASE_DIR / "jobs_cache.json"
CONFIG_FILE  = BASE_DIR / "config.json"
SERVER_PORT  = 8765

# ── Statuts candidature ──────────────────────────────────────────────────────────
STATUS_OPTIONS = {
    "":          ("— À traiter",   "#F0EDE8", "#6A7888"),
    "postule":   ("✉️ Postulé",    "#C8DCF5", "#1E4A8A"),
    "attente":   ("⏳ En attente", "#F5E5B8", "#7A5010"),
    "entretien": ("🗓️ Entretien",  "#DDD5F5", "#3E2898"),
    "refuse":    ("❌ Refusé",      "#F5C5CA", "#8A1828"),
    "accepte":   ("✅ Accepté",     "#C0E8D0", "#0E6035"),
    "ignore":    ("🚫 Ignoré",      "#DCDCDC", "#6A7480"),
}

def _atomic_write(path: Path, content: str) -> None:
    """Écrit dans un fichier temporaire puis renomme (atomique sur Windows/Linux)."""
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)

def load_statuses() -> dict:
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return {}
    return {}

def save_statuses(statuses: dict) -> None:
    _atomic_write(STATUS_FILE, json.dumps(statuses, indent=2, ensure_ascii=False))

def load_jobs_cache() -> dict:
    """Cache {id: job_data} des offres déjà vues — permet de réafficher les offres expirées suivies."""
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return {}
    return {}

def save_jobs_cache(jobs: list) -> None:
    cache = load_jobs_cache()
    for j in jobs:
        cache[j["id"]] = {k: v for k, v in j.items() if not k.startswith("_")}
    _atomic_write(CACHE_FILE, json.dumps(cache, indent=2, ensure_ascii=False))

# ── Configuration de recherche (config.json) ─────────────────────────────────────

_DEFAULT_CONFIG: dict = {
    "keywords": ["apprenti plombier", "alternance plomberie", "aide plombier", "plombier", "plombier chauffagiste"],
    "locations": [
        {"city": "Orléans", "radius": 30, "insee": "45234", "lat": 47.9029, "lon": 1.9097},
        {"city": "Tours",   "radius": 30, "insee": "37261", "lat": 47.3941, "lon": 0.6848},
    ],
    # Laisser vide = pas de filtre (les offres apprenti sont souvent enregistrées en CDD sur FT)
    # Exemples : ["CA","CC"] pour n'avoir que les contrats d'alternance officiels
    "ft_contract_types": [],
    "blocked_ids": [],
}

def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            for key, default in _DEFAULT_CONFIG.items():
                cfg.setdefault(key, default)
            return cfg
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            pass
    return dict(_DEFAULT_CONFIG)

def save_config(cfg: dict) -> None:
    _atomic_write(CONFIG_FILE, json.dumps(cfg, indent=2, ensure_ascii=False))

def _geocode_city(city_name: str) -> dict:
    """
    Retourne {"insee": ..., "lat": ..., "lon": ...} pour une ville française.
    Utilise l'API geo.api.gouv.fr (gratuite, sans clé API).
    """
    result: dict = {"insee": "", "lat": None, "lon": None}
    try:
        r = requests.get(
            "https://geo.api.gouv.fr/communes",
            params={"nom": city_name, "fields": "code,nom,centre",
                    "boost": "population", "limit": 1},
            headers={"User-Agent": "AlerteEmploi/1.0"},
            timeout=8,
        )
        data = r.json()
        if data:
            commune = data[0]
            coords  = commune.get("centre", {}).get("coordinates", [None, None])
            result["insee"] = commune.get("code", "")
            result["lon"]   = coords[0]   # GeoJSON = [lon, lat]
            result["lat"]   = coords[1]
    except Exception:
        pass
    return result

# ┌──────────────────────────────────────────────────────────────┐
# │  IDENTIFIANTS — fichier .env dans ce dossier                  │
# │    FT_CLIENT_ID=PAR_alertemploi_xxx                          │
# │    FT_CLIENT_SECRET=aBcDeFgHiJk...                           │
# │    JOOBLE_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx       │
# │    CAREERJET_AFFID=votre_affid                               │
# │    ADZUNA_APP_ID=a1b2c3d4                                    │
# │    ADZUNA_APP_KEY=a1b2c3d4e5f6...                            │
# └──────────────────────────────────────────────────────────────┘

def _load_env_file() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

_load_env_file()

FT_CLIENT_ID     = os.environ.get("FT_CLIENT_ID", "")
FT_CLIENT_SECRET = os.environ.get("FT_CLIENT_SECRET", "")
LBA_API_KEY      = os.environ.get("LBA_API_KEY", "")
JOOBLE_API_KEY   = os.environ.get("JOOBLE_API_KEY", "")
CAREERJET_AFFID  = os.environ.get("CAREERJET_AFFID", "")
ADZUNA_APP_ID    = os.environ.get("ADZUNA_APP_ID", "")
ADZUNA_APP_KEY   = os.environ.get("ADZUNA_APP_KEY", "")

HEADERS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9",
}

# ── Persistance seen ──────────────────────────────────────────────────────────────

def load_seen() -> set:
    if SEEN_FILE.exists():
        try:
            return set(json.loads(SEEN_FILE.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, UnicodeDecodeError):
            return set()
    return set()

def save_seen(seen: set) -> None:
    _atomic_write(SEEN_FILE, json.dumps(sorted(seen), indent=2))

def make_id(url: str, title: str) -> str:
    return hashlib.md5(f"{url}|{title}".encode()).hexdigest()

# ── Source 1 : France Travail ─────────────────────────────────────────────────────

_ft_token_cache: dict = {}
_ft_token_lock = threading.Lock()   # protège le cache en contexte multi-thread

def _get_ft_token() -> str:
    now = time.time()
    with _ft_token_lock:
        if _ft_token_cache.get("expires_at", 0) > now + 60:
            return _ft_token_cache["token"]
        try:
            r = requests.post(
                "https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire",
                auth=(FT_CLIENT_ID, FT_CLIENT_SECRET),
                data={
                    "grant_type": "client_credentials",
                    "scope":      "api_offresdemploiv2 o2dsoffre",
                },
                timeout=10,
            )
            data  = r.json()
            token = data.get("access_token", "")
            if not token:
                raise ValueError(f"Pas de token (code {r.status_code})")
            _ft_token_cache["token"]      = token
            _ft_token_cache["expires_at"] = now + data.get("expires_in", 1200)
            return token
        except (requests.RequestException, ValueError, KeyError) as exc:
            print(f"    [France Travail] Token : {type(exc).__name__}")
            _ft_token_cache.clear()
            return ""

def fetch_france_travail(keyword: str, loc: dict, contract_types: list | None = None) -> list:
    """loc = {"city": ..., "radius": ..., "insee": ..., ...}"""
    if not FT_CLIENT_ID or not FT_CLIENT_SECRET:
        return []
    token = _get_ft_token()
    if not token:
        return []
    jobs = []
    city   = loc.get("city", "")
    radius = loc.get("radius", 30)
    insee  = loc.get("insee", "")
    try:
        params = {"motsCles": keyword, "distance": radius, "range": "0-19"}
        if insee:
            params["commune"] = insee
        if contract_types:
            params["typeContrat"] = ",".join(contract_types)
        r = requests.get(
            "https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search",
            headers={**HEADERS, "Authorization": f"Bearer {token}"},
            params=params,
            timeout=15,
        )
        if not r.content or r.status_code == 204:
            return jobs
        if r.status_code != 200:
            return jobs
        resultats = r.json().get("resultats", [])[:50]
        ft_ids = []
        for o in resultats:
            ft_id = o.get("id", "")
            ft_ids.append((ft_id, o))
            jobs.append({
                "_ft_id":   ft_id,
                "title":    o.get("intitule", "")[:200],
                "company":  o.get("entreprise", {}).get("nom", "")[:100],
                "location": o.get("lieuTravail", {}).get("libelle", city)[:100],
                "url":      (o.get("origineOffre", {}).get("urlOrigine")
                             or f"https://candidat.francetravail.fr/offres/recherche/detail/{ft_id}"),
                "date":       o.get("dateCreation", "")[:10],
                "expires":    o.get("dateEcheance", "")[:10],
                "source":     "France Travail",
                "summary":    o.get("description", ""),
                "contract":   o.get("typeContratLibelle", "")[:80],
                "last_seen":  datetime.now().strftime("%Y-%m-%d"),
            })
        # Récupérer les descriptions complètes via l'endpoint de détail
        def _fetch_ft_detail(ft_id):
            try:
                rd = requests.get(
                    f"https://api.francetravail.io/partenaire/offresdemploi/v2/offres/{ft_id}",
                    headers={**HEADERS, "Authorization": f"Bearer {token}"},
                    timeout=10,
                )
                if rd.status_code == 200:
                    return ft_id, rd.json().get("description", "")
            except Exception:
                pass
            return ft_id, ""
        with ThreadPoolExecutor(max_workers=5) as pool:
            detail_futures = {pool.submit(_fetch_ft_detail, fid): fid for fid, _ in ft_ids}
            details = {fid: desc for f in as_completed(detail_futures)
                       for fid, desc in [f.result()] if desc}
        for j in jobs:
            fid = j.pop("_ft_id", "")
            if fid and fid in details:
                j["summary"] = details[fid]
    except Exception as exc:
        print(f"    [France Travail] {keyword!r} / {city} : {exc}")
    return jobs

# ── Source 2 : Adzuna ─────────────────────────────────────────────────────────────

def fetch_adzuna(keyword: str, loc: dict) -> list:
    """loc = {"city": ..., "radius": ..., "lat": ..., "lon": ...}"""
    if not ADZUNA_APP_ID or not ADZUNA_APP_KEY:
        return []
    city   = loc.get("city", "")
    radius = loc.get("radius", 30)
    jobs   = []
    try:
        r = requests.get(
            "https://api.adzuna.com/v1/api/jobs/fr/search/1",
            params={
                "app_id":           ADZUNA_APP_ID,
                "app_key":          ADZUNA_APP_KEY,
                "what":             keyword,
                "where":            city,
                "distance":         radius,
                "results_per_page": 20,
                "content-type":     "application/json",
                "sort_by":          "date",
            },
            timeout=15,
        )
        r.raise_for_status()
        results = r.json().get("results", [])[:50]
        for o in results:
            loc_o   = o.get("location", {})
            loc_str = ", ".join(filter(None, [
                loc_o.get("display_name", ""),
                next(iter(reversed(loc_o.get("area", []))), ""),
            ])) or city
            jobs.append({
                "title":    o.get("title", "")[:200],
                "company":  o.get("company", {}).get("display_name", "")[:100],
                "location": loc_str[:100],
                "url":      o.get("redirect_url", ""),
                "date":     o.get("created", "")[:10],
                "source":    "Adzuna",
                "summary":   o.get("description", ""),
                "contract":  o.get("contract_type", o.get("contract_time", ""))[:80],
                "last_seen": datetime.now().strftime("%Y-%m-%d"),
            })
    except Exception as exc:
        print(f"    [Adzuna] {keyword!r} / {city} : {exc}")
    return jobs


# ── Source 3 : La Bonne Alternance ───────────────────────────────────────────────

# Codes ROME couvrant la plomberie / chauffage / sanitaire
_LBA_ROMES = "F1603,I1310,F1604,I1302"

def fetch_lba(loc: dict) -> list:
    """API gouvernementale spécialisée alternance — clé gratuite sur api.apprentissage.beta.gouv.fr."""
    if not LBA_API_KEY:
        return []
    lat = loc.get("lat")
    lon = loc.get("lon")
    if not lat or not lon:
        return []
    city   = loc.get("city", "")
    radius = loc.get("radius", 30)
    jobs   = []
    try:
        r = requests.get(
            "https://api.apprentissage.beta.gouv.fr/api/job/v1/search",
            params={
                "latitude":  lat,
                "longitude": lon,
                "radius":    radius,
                "romes":     _LBA_ROMES,
            },
            headers={**HEADERS, "Authorization": f"Bearer {LBA_API_KEY}"},
            timeout=20,
        )
        if r.status_code != 200:
            print(f"    [La Bonne Alternance] {city} : HTTP {r.status_code}")
            return jobs
        data = r.json()
        for o in (data.get("jobs", []) or []):
            title    = (o.get("title") or "").strip()[:200]
            company  = (o.get("workplace", {}).get("name") or o.get("apply", {}).get("company") or "")[:100]
            url      = (o.get("apply", {}).get("url") or "").strip()
            date     = (o.get("publication", {}).get("creation") or "")[:10]
            loc_lbl  = (o.get("workplace", {}).get("location", {}).get("city") or city)[:100]
            summary  = (o.get("description") or "")
            contract = (o.get("contract", {}).get("type") or "Alternance")[:80]
            if not title:
                continue
            jobs.append({
                "title":    title,
                "company":  company,
                "location": loc_lbl,
                "url":      url,
                "date":     date,
                "source":    "La Bonne Alternance",
                "summary":   summary,
                "contract":  contract,
                "last_seen": datetime.now().strftime("%Y-%m-%d"),
            })
    except Exception as exc:
        print(f"    [La Bonne Alternance] {city} : {exc}")
    return jobs

# ── Source 4 : Jooble ─────────────────────────────────────────────────────────────

_JOOBLE_STOPWORDS = {"de", "du", "le", "la", "les", "en", "et", "un", "une", "au", "aux"}

def _jooble_relevant(title: str, snippet: str, keyword: str) -> bool:
    """Vérifie qu'au moins un mot significatif du mot-clé apparaît dans le titre ou le résumé."""
    words = {w for w in keyword.lower().split() if w not in _JOOBLE_STOPWORDS and len(w) > 2}
    text  = (title + " " + snippet).lower()
    return any(w in text for w in words)

def fetch_jooble(keyword: str, loc: dict) -> list:
    """Agrégateur mondial — clé gratuite sur jooble.org/api/about."""
    if not JOOBLE_API_KEY:
        return []
    city   = loc.get("city", "")
    radius = loc.get("radius", 30)
    jobs   = []
    try:
        r = requests.post(
            f"https://jooble.org/api/{JOOBLE_API_KEY}",
            json={
                "keywords":     keyword,
                "location":     city,
                "radius":       str(radius),
                "resultonpage": 20,
            },
            headers={**HEADERS, "Content-Type": "application/json"},
            timeout=15,
        )
        r.raise_for_status()
        for o in r.json().get("jobs", [])[:30]:
            title   = o.get("title", "")[:200]
            snippet = o.get("snippet", "")
            if not _jooble_relevant(title, snippet, keyword):
                continue
            jobs.append({
                "title":    title,
                "company":  o.get("company", "")[:100],
                "location": o.get("location", city)[:100],
                "url":      o.get("link", ""),
                "date":     o.get("updated", "")[:10],
                "source":    "Jooble",
                "summary":   snippet,
                "contract":  o.get("type", "")[:80],
                "last_seen": datetime.now().strftime("%Y-%m-%d"),
            })
    except Exception as exc:
        print(f"    [Jooble] {keyword!r} / {city} : {exc}")
    return jobs

# ── Source 5 : Careerjet ──────────────────────────────────────────────────────────

def fetch_careerjet(keyword: str, loc: dict) -> list:
    """Agrégateur FR — affiliate ID gratuit sur careerjet.fr/partenaires/api."""
    if not CAREERJET_AFFID:
        return []
    city = loc.get("city", "")
    jobs = []
    try:
        r = requests.get(
            "http://public.api.careerjet.net/search",
            params={
                "keywords":    keyword,
                "location":    city,
                "locale_code": "fr_FR",
                "affid":       CAREERJET_AFFID,
                "pagesize":    20,
                "sort":        "date",
            },
            headers=HEADERS,
            timeout=15,
        )
        r.raise_for_status()
        for o in r.json().get("jobs", [])[:30]:
            jobs.append({
                "title":    o.get("title", "")[:200],
                "company":  o.get("company", "")[:100],
                "location": o.get("locations", city)[:100],
                "url":      o.get("url", ""),
                "date":     o.get("date", "")[:10],
                "source":    "Careerjet",
                "summary":   o.get("description", ""),
                "last_seen": datetime.now().strftime("%Y-%m-%d"),
                "contract": o.get("contract_type", "")[:80],
            })
    except Exception as exc:
        print(f"    [Careerjet] {keyword!r} / {city} : {exc}")
    return jobs


def _is_public_url(url: str) -> bool:
    """Rejette les URLs vers localhost, IPs privées ou schémas non-HTTP (anti-SSRF)."""
    try:
        p = urlparse(url)
        if p.scheme not in ("http", "https"):
            return False
        host = p.hostname or ""
        if not host:
            return False
        try:
            ip = ipaddress.ip_address(host)
            return ip.is_global and not ip.is_loopback
        except ValueError:
            pass  # nom de domaine, pas une IP — OK
        return host not in ("localhost",)
    except Exception:
        return False

def _resolve_url(url: str) -> str:
    """Suit les redirections HTTP vers l'URL finale (employeur), en bloquant les IPs privées."""
    if not _is_public_url(url):
        return url
    try:
        r = requests.head(url, allow_redirects=True, timeout=6, headers=HEADERS)
        final = r.url
        if not _is_public_url(final):
            return url
        if final == url and r.status_code in (405, 501):
            r2 = requests.get(url, allow_redirects=True, timeout=6,
                              headers=HEADERS, stream=True)
            final = r2.url if _is_public_url(r2.url) else url
            r2.close()
        return final
    except requests.RequestException:
        return url


def _resolve_adzuna_urls(jobs: list) -> list:
    """Résout en parallèle les URLs de redirection Adzuna → liens directs employeur."""
    to_resolve = [(i, j) for i, j in enumerate(jobs)
                  if j.get("source") == "Adzuna" and j.get("url")]
    if not to_resolve:
        return jobs

    print(f"    Résolution de {len(to_resolve)} lien(s) Adzuna...", end="", flush=True)

    def _worker(idx_job):
        idx, job = idx_job
        return idx, _resolve_url(job["url"])

    with ThreadPoolExecutor(max_workers=6) as pool:
        for idx, resolved in pool.map(_worker, to_resolve):
            jobs[idx]["url"] = resolved

    print(" OK")
    return jobs

# ── Normalisation & similarité cross-plateforme ──────────────────────────────────

_STOPWORDS = {
    "h/f", "f/h", "(h/f)", "(f/h)", "hf", "fh", "cdi", "cdd", "alternance",
    "apprentissage", "stage", "contrat", "poste", "offre", "emploi",
    "recherche", "urgent",
    "le", "la", "les", "de", "du", "des", "un", "une", "en", "et", "ou",
    "au", "aux", "ce", "se", "sa", "son", "ses", "nous", "vous", "ils",
    "elles", "que", "qui", "sur", "par", "pour", "dans", "avec", "est",
    "sont", "avoir", "faire", "plus", "tout", "tous", "bien", "votre",
    "notre", "vos", "nos", "leur", "leurs", "pas", "ne", "si", "très",
}

SIMILARITY_THRESHOLD        = 0.55
MIN_WORDS_FOR_CONTENT_MATCH = 12

_RE_NON_WORD = re.compile(r"[^\w\s]")   # pré-compilé une seule fois

def _normalize(text: str) -> str:
    nfd        = unicodedata.normalize("NFD", text)
    ascii_text = nfd.encode("ascii", "ignore").decode("ascii")
    cleaned    = _RE_NON_WORD.sub(" ", ascii_text.lower())
    return " ".join(w for w in cleaned.split() if w not in _STOPWORDS and len(w) > 2)

@functools.lru_cache(maxsize=512)        # évite de re-normaliser le même texte
def _word_set(text: str) -> frozenset:
    return frozenset(_normalize(text).split())


def _similarity(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    inter       = len(a & b)
    jaccard     = inter / len(a | b)
    containment = inter / min(len(a), len(b))
    return max(jaccard, containment)


def _title_key(job: dict) -> str:
    t = _normalize(job.get("title", "")).split()[:6]
    c = _normalize(job.get("company", "")).split()[:3]
    return "|".join(t) + "§" + "|".join(c)


def _merge_into(target: dict, source: dict) -> None:
    if source["source"] not in target["sources"]:
        target["sources"].append(source["source"])
    # Résumé : garder le plus long
    if len(source.get("summary", "")) > len(target.get("summary", "")):
        target["summary"] = source["summary"]
    # Date : garder la plus récente
    if source.get("date") and source["date"] > target.get("date", ""):
        target["date"] = source["date"]
    # URL : FT est prioritaire — on ne remplace que si la cible n'en a pas
    if not target.get("url") and source.get("url"):
        target["url"] = source["url"]
    # Si la cible est FT et la source est Adzuna, on garde aussi l'URL Adzuna
    # pour afficher le lien direct employeur si disponible dans le futur,
    # mais le champ principal "url" reste celui de FT.
    if "France Travail" in target["sources"] and source.get("source") == "Adzuna":
        target.setdefault("url_adzuna", source.get("url", ""))

# ── Collecte & déduplication en 3 passes ─────────────────────────────────────────

def collect_all() -> list:
    cfg = load_config()
    keywords    = cfg.get("keywords", _DEFAULT_CONFIG["keywords"])
    locations   = cfg.get("locations", _DEFAULT_CONFIG["locations"])
    blocked_ids = set(cfg.get("blocked_ids", []))

    raw = []
    sources_configured = []
    if FT_CLIENT_ID and FT_CLIENT_SECRET:
        sources_configured.append("France Travail")
    if LBA_API_KEY:
        sources_configured.append("La Bonne Alternance")
    if JOOBLE_API_KEY:
        sources_configured.append("Jooble")
    if CAREERJET_AFFID:
        sources_configured.append("Careerjet")
    if ADZUNA_APP_ID and ADZUNA_APP_KEY:
        sources_configured.append("Adzuna")

    if not sources_configured:
        print("\n  ATTENTION : aucune source configurée !")
        print("  Renseignez vos identifiants dans le fichier .env")
        print("  Voir les instructions de configuration dans les commentaires.\n")
        return []

    print(f"  Sources actives : {', '.join(sources_configured)}\n")

    ft_contract_types = cfg.get("ft_contract_types", ["CA", "CC"])
    pairs = [(kw, loc) for kw in keywords for loc in locations]

    def _fetch_pair(kw_loc):
        kw, loc = kw_loc
        ft = fetch_france_travail(kw, loc, ft_contract_types)
        az = fetch_adzuna(kw, loc)
        jb = fetch_jooble(kw, loc)
        cj = fetch_careerjet(kw, loc)
        return ft, az, jb, cj

    ft_raw: list = []
    az_raw: list = []
    jb_raw: list = []
    cj_raw: list = []
    n_workers = min(len(pairs), 6)
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futures = {pool.submit(_fetch_pair, p): p for p in pairs}
        for future in as_completed(futures):
            kw, loc = futures[future]
            print(f"  • {kw!r} @ {loc['city']} (rayon {loc.get('radius', 30)} km)")
            try:
                ft, az, jb, cj = future.result()
                ft_raw += ft
                az_raw += az
                jb_raw += jb
                cj_raw += cj
            except Exception as exc:
                print(f"    Erreur : {type(exc).__name__}")

    # La Bonne Alternance : par ville uniquement (ROME, pas mots-clés)
    lba_raw: list = []
    for loc in locations:
        print(f"  • La Bonne Alternance @ {loc['city']}")
        lba_raw += fetch_lba(loc)

    # Ordre de priorité dans la déduplication : FT > LBA > Jooble > Careerjet > Adzuna
    raw = ft_raw + lba_raw + jb_raw + cj_raw + az_raw

    raw = _resolve_adzuna_urls(raw)

    # ── Passe 1 : déduplication par URL exacte ────────────────────────────────────
    seen_urls: set = set()
    after_url: list = []
    for j in raw:
        key = j["url"] or f"{j['title']}|{j['source']}"
        if key and key not in seen_urls:
            seen_urls.add(key)
            j = j.copy()
            j["sources"] = [j["source"]]
            j["id"]      = make_id(j["url"], j["title"])
            j["_words"]  = _word_set(j.get("summary", ""))
            j["_tkey"]   = _title_key(j)
            after_url.append(j)

    # ── Passe 2 : titre + entreprise normalisés ───────────────────────────────────
    by_tkey: dict = {}
    after_title: list = []
    for j in after_url:
        tkey = j["_tkey"]
        if not tkey.strip("|§"):
            after_title.append(j)
            continue
        if tkey not in by_tkey:
            by_tkey[tkey] = j
            after_title.append(j)
        else:
            _merge_into(by_tkey[tkey], j)

    # ── Passe 3 : similarité de contenu (max Jaccard / confinement) ───────────────
    final: list = []
    for j in after_title:
        words_j = j["_words"]
        if len(words_j) < MIN_WORDS_FOR_CONTENT_MATCH:
            final.append(j)
            continue
        matched = False
        for existing in final:
            words_e = existing["_words"]
            if len(words_e) < MIN_WORDS_FOR_CONTENT_MATCH:
                continue
            if _similarity(words_j, words_e) >= SIMILARITY_THRESHOLD:
                _merge_into(existing, j)
                existing["_words"] = words_e | words_j
                matched = True
                break
        if not matched:
            final.append(j)

    for j in final:
        j.pop("_words", None)
        j.pop("_tkey", None)

    # Filtrer les offres signalées comme fausses
    if blocked_ids:
        before = len(final)
        final  = [j for j in final if j["id"] not in blocked_ids]
        filtered = before - len(final)
        if filtered:
            print(f"\n  - offres bloquées (spam)   : {filtered}")

    n1 = len(raw) - len(after_url)
    n2 = len(after_url) - len(after_title)
    n3 = len(after_title) - len(final) - (len(blocked_ids) and 0)

    print(f"\n  Brut collecté            : {len(raw)}")
    if n1: print(f"  - doublons URL           : {n1}")
    if n2: print(f"  - doublons titre/entrep. : {n2}")
    if n3: print(f"  - doublons contenu       : {n3}")
    print(f"  = Offres uniques         : {len(final)}")
    return final

# ── Serveur HTTP local ────────────────────────────────────────────────────────────

class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

_MAX_POST_BODY = 65_536   # 64 Ko — protection contre les gros payloads

class _StatusHandler(BaseHTTPRequestHandler):

    def _read_json_body(self) -> dict | None:
        """Lit et parse le corps JSON d'une requête POST avec limite de taille."""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0 or length > _MAX_POST_BODY:
            self._send_json(413, b'{"error":"Payload too large or missing"}')
            return None
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, b'{"error":"Invalid JSON"}')
            return None

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self._serve_report()
        elif self.path == "/api/status":
            data = json.dumps(load_statuses()).encode("utf-8")
            self._send_json(200, data)
        elif self.path == "/api/config":
            data = json.dumps(load_config()).encode("utf-8")
            self._send_json(200, data)
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        allowed = {f"http://localhost:{SERVER_PORT}", f"http://127.0.0.1:{SERVER_PORT}", ""}
        if origin and origin not in allowed:
            self._send_json(403, b'{"error":"Origin non autorisee"}')
            return
        if self.path == "/api/status":
            body = self._read_json_body()
            if body is None:
                return
            try:
                job_id = str(body.get("id", ""))[:64]
                status = str(body.get("status", ""))
                if job_id and status in STATUS_OPTIONS:
                    statuses = load_statuses()
                    if status:
                        statuses[job_id] = status
                    else:
                        statuses.pop(job_id, None)
                    save_statuses(statuses)
                self._send_json(200, b'{"ok":true}')
            except (OSError, ValueError) as exc:
                self._send_json(500, json.dumps({"error": type(exc).__name__}).encode())

        elif self.path == "/api/config":
            body = self._read_json_body()
            if body is None:
                return
            try:
                cfg = load_config()
                if "keywords" in body:
                    kws = [
                        re.sub(r"[\r\n\0]", "", str(k)).strip()[:200]
                        for k in body["keywords"]
                        if str(k).strip()
                    ]
                    cfg["keywords"] = kws[:30]
                if "locations" in body:
                    locs = []
                    for raw_loc in body["locations"][:15]:
                        city   = re.sub(r"[\r\n\0]", "", str(raw_loc.get("city", ""))).strip()[:100]
                        radius = max(1, min(200, int(raw_loc.get("radius", 30))))
                        if not city:
                            continue
                        loc_entry: dict = {"city": city, "radius": radius}
                        if raw_loc.get("insee"):
                            loc_entry["insee"] = str(raw_loc["insee"])[:10]
                            try:
                                lat = float(raw_loc.get("lat") or 0)
                                lon = float(raw_loc.get("lon") or 0)
                                if -90 <= lat <= 90 and -180 <= lon <= 180:
                                    loc_entry["lat"] = lat
                                    loc_entry["lon"] = lon
                            except (TypeError, ValueError):
                                pass
                        else:
                            print(f"  Géocodage de {city!r}...", end="", flush=True)
                            geo = _geocode_city(city)
                            loc_entry.update(geo)
                            print(f" INSEE={geo['insee'] or '?'}")
                        locs.append(loc_entry)
                    cfg["locations"] = locs
                save_config(cfg)
                self._send_json(200, b'{"ok":true}')
            except (OSError, ValueError, TypeError) as exc:
                self._send_json(500, json.dumps({"error": type(exc).__name__}).encode())

        elif self.path == "/api/block":
            body = self._read_json_body()
            if body is None:
                return
            try:
                job_id = re.sub(r"[^a-f0-9]", "", str(body.get("id", "")))[:64]
                if job_id:
                    cfg = load_config()
                    blocked = cfg.get("blocked_ids", [])
                    if job_id not in blocked:
                        blocked.append(job_id)
                    cfg["blocked_ids"] = blocked
                    save_config(cfg)
                self._send_json(200, b'{"ok":true}')
            except (OSError, ValueError) as exc:
                self._send_json(500, json.dumps({"error": type(exc).__name__}).encode())

        else:
            self.send_response(404); self.end_headers()

    def _security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")

    def _serve_report(self):
        try:
            content = REPORT_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self._security_headers()
            self.end_headers()
            self.wfile.write(content)
        except FileNotFoundError:
            err = b'{"error":"Rapport introuvable, relancez le script."}'
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def _send_json(self, code: int, data: bytes):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def start_server() -> bool:
    try:
        srv = _ThreadedHTTPServer(("localhost", SERVER_PORT), _StatusHandler)
    except OSError:
        return False
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return True

# ── Génération du rapport HTML ────────────────────────────────────────────────────

_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #E8E3DC; color: #232E3C; padding: 20px;
}
header {
  background: linear-gradient(135deg, #6B8CD4, #5270C0);
  color: white; padding: 22px 28px; border-radius: 16px; margin-bottom: 24px;
  box-shadow: 0 6px 24px rgba(82,112,192,.35);
}
header h1 { font-size: 1.6rem; margin-bottom: 6px; font-weight: 700; }
header p  { opacity: .9; font-size: .88rem; }
.header-actions { display: flex; gap: 10px; align-items: center; margin-top: 14px; }
.settings-btn {
  padding: 6px 16px; border-radius: 8px; background: rgba(255,255,255,.20);
  border: 1.5px solid rgba(255,255,255,.50); color: white; font-size: .82rem;
  font-weight: 600; cursor: pointer; transition: background .15s;
}
.settings-btn:hover { background: rgba(255,255,255,.32); }
.stats { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 28px; }
.stat {
  background: white; border-radius: 14px; padding: 16px 22px;
  flex: 1; min-width: 130px;
  box-shadow: 0 2px 8px rgba(0,0,0,.10);
  border: 1px solid #D0C8C0;
}
.stat .n { font-size: 2.2rem; font-weight: 700; color: #5270C0; }
.stat .l { font-size: .78rem; color: #6A7888; margin-top: 2px;
           text-transform: uppercase; letter-spacing: .06em; }
section { margin-bottom: 32px; }
section h2 {
  font-size: 1.02rem; font-weight: 700; color: #232E3C;
  border-left: 4px solid #6B8CD4; padding-left: 12px; margin-bottom: 14px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}
/* Alignement bas : chaque carte est une colonne flex — le status-row colle au bas */
.card {
  display: flex; flex-direction: column;
  background: #FFFFFF; border-radius: 14px; padding: 18px;
  box-shadow: 0 2px 10px rgba(0,0,0,.09);
  border: 1px solid #C8C0B8;
  border-left: 4px solid transparent;
  transition: transform .15s, box-shadow .15s;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.14); }
.card.new   { border-left-color: #3BAA72; background: #F0FAF4; }
.card[data-status="postule"]   { border-left-color: #4878C8; }
.card[data-status="attente"]   { border-left-color: #C89020; }
.card[data-status="entretien"] { border-left-color: #8060C8; }
.card[data-status="refuse"]    { border-left-color: #C84040; opacity: .68; }
.card[data-status="accepte"]   { border-left-color: #28A060; }
.card[data-status="ignore"]    { display: none !important; }
.card.blocked { display: none !important; }
.badges     { margin-bottom: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.badge {
  display: inline-block; font-size: .68rem; font-weight: 700;
  padding: 2px 9px; border-radius: 99px; letter-spacing: .03em;
}
.badge-new        { background: #B8EDD4; color: #0A5E35; }
.badge-multi      { background: #F0C8E0; color: #7A1850; }
.badge-alternance { background: #FFE0A0; color: #7A4A00; }
.badge-archived   { background: #E0E0E0; color: #555; }
.card.alternance  { border-left-color: #E8960A; background: #FFFBF0; }
.card.archived    { opacity: .75; border-left-color: #AAA; border-style: dashed; }
.card h3 { font-size: .95rem; font-weight: 600; margin-bottom: 6px; }
.card h3 a { color: #3A5EA8; text-decoration: none; }
.card h3 a:hover { text-decoration: underline; color: #5270C0; }
.meta { font-size: .78rem; color: #6A7888; display: flex; gap: 10px;
        flex-wrap: wrap; margin-top: 4px; align-items: center; }
.domain-link { font-size: .78rem; color: #5270C0; text-decoration: none; font-weight: 500; }
.domain-link:hover { text-decoration: underline; }
.summary { font-size: .8rem; color: #4A5868; margin-top: 10px; line-height: 1.6; }
/* margin-top:auto pousse le status-row en bas de chaque carte */
.status-row {
  margin-top: auto; padding-top: 12px;
  border-top: 1px solid #D8D0C8;
  display: flex; gap: 8px; align-items: center;
}
.status-select {
  flex: 1; padding: 6px 10px; border-radius: 8px; font-size: .8rem;
  border: 1px solid #C8C0B8; cursor: pointer; font-weight: 600;
  transition: background .2s, color .2s;
}
.status-select:focus { outline: none; box-shadow: 0 0 0 2px #A8BCEC; }
.block-btn {
  padding: 5px 9px; border-radius: 7px; border: 1px solid #F0A8B0;
  background: #FFF0F2; color: #A01828; font-size: .72rem; cursor: pointer;
  white-space: nowrap; flex-shrink: 0; font-weight: 600;
}
.block-btn:hover { background: #FFE0E4; border-color: #C84040; }
.filter-bar {
  display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 22px; align-items: center;
}
.filter-btn {
  padding: 6px 14px; border-radius: 99px; border: 1.5px solid #C8C0B8;
  font-size: .78rem; font-weight: 600; cursor: pointer; background: white;
  color: #4A5868; transition: all .15s; display: flex; align-items: center; gap: 5px;
}
.filter-btn:hover  { border-color: #5270C0; color: #5270C0; }
.filter-btn.active { background: #5270C0; color: white; border-color: #5270C0; }
.filter-btn.alt-toggle        { background: #E8960A; color: #fff; border-color: #C07800; font-weight: 700; }
.filter-btn.alt-toggle.off    { background: #fff; color: #9AA4B0; border-color: #C8C0B8; font-weight: 400; }
.filter-sep { color: #C8C0B8; padding: 0 4px; align-self: center; }
.filter-count { background: rgba(0,0,0,.12); border-radius: 99px;
                padding: 1px 7px; font-size: .7rem; }
.export-btn {
  margin-left: auto; padding: 6px 14px; border-radius: 8px; border: 1.5px solid #C8C0B8;
  font-size: .78rem; cursor: pointer; background: white; color: #4A5868;
}
.export-btn:hover { border-color: #5270C0; color: #5270C0; }
.setup-warn {
  background: #FFF8E8; border: 1px solid #D8B050; border-radius: 14px;
  padding: 20px 24px; margin-bottom: 28px;
}
.setup-warn h2 { color: #7A5000; margin-bottom: 10px; }
.setup-warn code { background: #FEEEC8; padding: 1px 6px; border-radius: 4px; font-size:.85rem; }
.setup-warn ol { margin-left: 20px; line-height: 2; }
.empty     { text-align: center; padding: 48px; color: #9AA4B0; font-size: .95rem; }
.empty-src { padding: 18px 24px; color: #9AA4B0; font-style: italic; font-size: .88rem; }
.meta-list { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; }
.meta-row  { font-size: .82rem; color: #4A5868; }
/* ── Page de détail d'une offre ───────────────────────────────── */
.offer-page {
  display: none; max-width: 820px; margin: 0 auto;
  padding: 28px 20px 60px;
}
.op-header {
  display: flex; align-items: center; gap: 14px;
  margin-bottom: 20px; flex-wrap: wrap;
}
.op-back {
  background: #fff; border: 1px solid #C8C0B8; border-radius: 8px;
  padding: 7px 16px; font-size: .88rem; cursor: pointer; color: #4A5868;
}
.op-back:hover { background: #F0EDE8; }
.op-title { font-size: 1.5rem; font-weight: 700; color: #2A3848; margin-bottom: 18px; line-height: 1.3; }
.op-meta  { display: flex; flex-direction: column; gap: 7px; margin-bottom: 20px; }
.op-row         { font-size: .92rem; color: #3A4858; display: flex; gap: 8px; }
.op-row span    { font-weight: 500; }
.op-expired     { color: #8A3020; background: #FFF0EC; border-radius: 6px; padding: 4px 10px; }
.op-link  {
  display: inline-block; margin-bottom: 24px;
  background: #5270C0; color: #fff; text-decoration: none;
  padding: 10px 22px; border-radius: 8px; font-weight: 600; font-size: .9rem;
}
.op-link:hover { background: #3A5AAA; }
.op-desc  {
  background: #fff; border: 1px solid #D8D0C8; border-radius: 10px;
  padding: 20px 24px; margin-bottom: 24px; font-size: .9rem;
  color: #3A4858; line-height: 1.7; white-space: pre-wrap;
}
.op-actions {
  display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap;
  padding-top: 16px; border-top: 1px solid #D8D0C8;
}
.op-actions .status-select,
.op-actions .block-btn,
.op-actions .ignore-del-btn {
  height: 40px; box-sizing: border-box;
  padding: 0 16px; font-size: .86rem;
  border-radius: 8px; font-weight: 600;
  display: flex; align-items: center; cursor: pointer;
}
.op-actions .status-select { flex: 0 0 auto; min-width: 160px; }
.op-actions .block-btn {
  background: #FFF0F2; color: #A01828;
  border: 1px solid #F0A8B0; white-space: nowrap;
}
.op-actions .block-btn:hover { background: #FFE0E4; border-color: #C84040; }
.ignore-del-btn {
  background: #F5C5CA; color: #8A1828;
  border: 1px solid #E8A0A8; white-space: nowrap;
}
.ignore-del-btn:hover { background: #F0A0A8; }
/* ── Modal Paramètres ─────────────────────────────────────────── */
.modal-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(20,30,45,.50); z-index: 100;
  align-items: flex-start; justify-content: center;
  padding: 40px 16px; overflow-y: auto;
}
.modal-overlay.open { display: flex; }
.modal-box {
  background: #FFFFFF; border-radius: 18px; padding: 28px 30px;
  width: 100%; max-width: 560px;
  box-shadow: 0 20px 60px rgba(0,0,0,.25);
  border: 1px solid #C8C0B8;
}
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.modal-header h2 { font-size: 1.15rem; font-weight: 700; color: #232E3C; }
.modal-close { font-size: 1.4rem; cursor: pointer; color: #9AA4B0;
               border: none; background: none; line-height: 1; }
.modal-close:hover { color: #4A5868; }
.settings-section { margin-bottom: 22px; }
.settings-section h3 {
  font-size: .78rem; font-weight: 700; color: #6A7888;
  text-transform: uppercase; letter-spacing: .07em; margin-bottom: 12px;
}
.chip-list { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; min-height: 34px; }
.chip {
  display: flex; align-items: center; gap: 4px; padding: 4px 11px; border-radius: 99px;
  background: #D8E4F8; color: #2A4888; font-size: .8rem; font-weight: 600;
}
.chip-del { background: none; border: none; cursor: pointer; color: #88A4D8; font-size: 1rem;
            line-height: 1; padding: 0 1px; }
.chip-del:hover { color: #C84040; }
.add-row { display: flex; gap: 8px; }
.add-row input, .settings-input {
  flex: 1; padding: 7px 12px; border: 1.5px solid #C8C0B8; border-radius: 8px;
  font-size: .85rem; outline: none; font-family: inherit; background: white; color: #232E3C;
}
.add-row input:focus, .settings-input:focus { border-color: #5270C0; box-shadow: 0 0 0 2px #A8BCEC; }
.add-row button, .btn-primary {
  padding: 7px 14px; border-radius: 8px; border: none; background: #5270C0; color: white;
  font-size: .82rem; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.add-row button:hover, .btn-primary:hover { background: #3A58A8; }
.loc-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border: 1.5px solid #D0C8C0; border-radius: 10px; margin-bottom: 8px;
  background: #F5F2EE;
}
.loc-city { flex: 1; font-weight: 600; font-size: .88rem; color: #232E3C; }
.loc-radius-val { font-size: .78rem; color: #6A7888; width: 48px; text-align: right;
                  font-weight: 700; }
.loc-radius { width: 100px; accent-color: #5270C0; }
.loc-del { background: none; border: none; cursor: pointer; color: #B0B8C0; font-size: 1.1rem; }
.loc-del:hover { color: #C84040; }
.settings-footer { display: flex; gap: 10px; justify-content: flex-end; padding-top: 18px;
                   border-top: 1px solid #D8D0C8; margin-top: 4px; }
.btn-secondary { padding: 7px 16px; border-radius: 8px; border: 1.5px solid #C8C0B8;
                 background: white; color: #4A5868; font-size: .82rem; cursor: pointer;
                 font-family: inherit; }
.btn-secondary:hover { border-color: #5270C0; color: #5270C0; }
.settings-note { font-size: .74rem; color: #9AA4B0; margin-top: 14px; text-align: center; line-height: 1.5; }
.save-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: #232E3C; color: white; padding: 10px 22px; border-radius: 99px;
  font-size: .85rem; font-weight: 600; z-index: 200; opacity: 0;
  transition: opacity .3s;
}
.save-toast.show { opacity: 1; }
"""

_SOURCE_COLORS = {
    "France Travail":      ("#DDD5F5", "#3E2898"),   # lavande
    "La Bonne Alternance": ("#FFE4B0", "#7A4A00"),   # abricot
    "Jooble":              ("#C8E8F8", "#0A3A6A"),   # bleu ciel
    "Careerjet":           ("#F5D8C0", "#6A2800"),   # terracotta
    "Adzuna":              ("#C0E8D0", "#0E6035"),   # menthe
}

def _safe_url(url: str) -> str:
    stripped = url.strip()
    if stripped.lower().startswith(("http://", "https://")):
        return html.escape(stripped, quote=True)
    return "#"

def _domain(url: str) -> str:
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc.lower()
        return host.removeprefix("www.")
    except Exception:
        return ""

_SOURCE_SEARCH_URLS = {
    "France Travail": "https://candidat.francetravail.fr/offres/recherche",
    "Adzuna":         "https://www.adzuna.fr/emploi",
}

def _source_badges(sources: list) -> str:
    badges = []
    for src in sources:
        bg, fg = _SOURCE_COLORS.get(src, ("#f1f5f9", "#334155"))
        href   = _SOURCE_SEARCH_URLS.get(src, "#")
        badges.append(
            f'<a class="badge" href="{href}" target="_blank" rel="noopener noreferrer" '
            f'style="background:{bg};color:{fg};text-decoration:none">{src}</a>'
        )
    return " ".join(badges)

def _status_select(job_id: str) -> str:
    options = "".join(
        f'<option value="{v}">{label}</option>'
        for v, (label, _, _) in STATUS_OPTIONS.items()
    )
    return (
        f'<select class="status-select" data-id="{html.escape(job_id)}" onchange="setStatus(this)">'
        f'{options}</select>'
    )

def _block_btn(job_id: str) -> str:
    return (
        f'<button class="block-btn" data-id="{html.escape(job_id)}" onclick="blockJob(this.dataset.id)" '
        f'title="Signaler comme fausse offre ou spam">🚫 Fausse offre</button>'
    )

def _fmt_date(date_str: str) -> str:
    """Formate YYYY-MM-DD en DD/MM/YYYY."""
    if not date_str or len(date_str) < 10:
        return date_str
    try:
        y, m, d = date_str[:10].split("-")
        return f"{d}/{m}/{y}"
    except ValueError:
        return date_str

def _is_alternance(j: dict) -> bool:
    """Détecte alternance/apprentissage uniquement dans l'intitulé du poste."""
    title = j.get("title", "").lower()
    return "apprenti" in title or "alternance" in title


def _card(j: dict, is_new: bool) -> str:
    title    = html.escape(j.get("title", ""))
    company  = html.escape(j.get("company", ""))
    location = html.escape(j.get("location", ""))
    date_val = _fmt_date(j.get("date", "")[:10])
    contract = html.escape(j.get("contract", ""))
    job_id   = html.escape(j.get("id", ""))

    is_alt         = _is_alternance(j)
    archived_badge = '<span class="badge badge-archived">📦 Expirée</span>' if j.get("_archived") else ""
    new_badge      = '<span class="badge badge-new">NOUVEAU</span>' if is_new else ""
    alt_badge      = '<span class="badge badge-alternance">⭐ Alternance</span>' if is_alt else ""
    multi_badge    = '<span class="badge badge-multi">Multi-sites</span>' if len(j.get("sources", [])) > 1 else ""
    src_badges     = _source_badges(j.get("sources", [j["source"]]))

    sources  = j.get("sources", [j.get("source", "")])
    has_ft   = "France Travail" in sources
    block_el = "" if has_ft else _block_btn(job_id)

    meta_rows = []
    if company:  meta_rows.append(f'<div class="meta-row">🏢 {company}</div>')
    meta_rows.append(f'<div class="meta-row">📍 {location}</div>')
    if contract: meta_rows.append(f'<div class="meta-row">📄 {contract}</div>')
    if date_val: meta_rows.append(f'<div class="meta-row">📅 {date_val}</div>')

    css_cls = " ".join(filter(None, [
        "card",
        "new"       if is_new             else "",
        "alternance" if is_alt            else "",
        "archived"  if j.get("_archived") else "",
    ]))

    return f"""
      <div class="{css_cls}" data-job-id="{job_id}" onclick="showOffer('{job_id}')" style="cursor:pointer">
        <div class="badges">{alt_badge}{archived_badge}{new_badge}{multi_badge}{src_badges}</div>
        <h3>{title}</h3>
        <div class="meta-list">{''.join(meta_rows)}</div>
        <div class="status-row" onclick="event.stopPropagation()">{_status_select(job_id)}{block_el}</div>
      </div>"""


def _offer_page(j: dict) -> str:
    """Page de détail d'une offre (div cachée, affichée via showOffer())."""
    title    = html.escape(j.get("title", ""))
    company  = html.escape(j.get("company", ""))
    location = html.escape(j.get("location", ""))
    date_val = _fmt_date(j.get("date", "")[:10])
    contract = html.escape(j.get("contract", ""))
    summary  = html.escape(j.get("summary", "")).replace("\n", "<br>")
    raw_url  = j.get("url", "")
    safe_url = _safe_url(raw_url)
    job_id   = html.escape(j.get("id", ""))

    is_alt     = _is_alternance(j)
    sources    = j.get("sources", [j.get("source", "")])
    has_ft     = "France Travail" in sources
    src_badges = _source_badges(sources)
    alt_badge  = '<span class="badge badge-alternance">⭐ Alternance</span>' if is_alt else ""
    arc_badge    = '<span class="badge badge-archived">📦 Expirée</span>' if j.get("_archived") else ""
    expire_reason = html.escape(j.get("_expire_reason", ""))
    expires_val   = _fmt_date(j.get("expires", "")[:10])

    meta_rows = []
    if company:       meta_rows.append(f'<div class="op-row">🏢 <span>{company}</span></div>')
    meta_rows.append(f'<div class="op-row">📍 <span>{location}</span></div>')
    if contract:      meta_rows.append(f'<div class="op-row">📄 <span>{contract}</span></div>')
    if date_val:      meta_rows.append(f'<div class="op-row">📅 <span>Publiée le {date_val}</span></div>')
    if expires_val:   meta_rows.append(f'<div class="op-row">⏳ <span>Expire le {expires_val}</span></div>')
    if expire_reason: meta_rows.append(f'<div class="op-row op-expired">⚠️ <span>{expire_reason}</span></div>')

    link_el  = (f'<a class="op-link" href="{safe_url}" target="_blank" rel="noopener noreferrer">'
                f'🔗 Voir l\'offre complète</a>') if safe_url != "#" else ""
    block_el = (f'<button class="block-btn" data-id="{job_id}" '
                f'onclick="blockJob(this.dataset.id)">🚫 Fausse offre</button>') if not has_ft else ""
    desc_el  = f'<div class="op-desc"><p>{summary}</p></div>' if summary else ""

    return f"""
<div id="offer-{job_id}" class="offer-page" data-job-id="{job_id}">
  <div class="op-header">
    <button class="op-back" onclick="backToList()">← Retour aux offres</button>
    <div class="badges">{alt_badge}{arc_badge}{src_badges}</div>
  </div>
  <h1 class="op-title">{title}</h1>
  <div class="op-meta">{''.join(meta_rows)}</div>
  {link_el}
  {desc_el}
  <div class="op-actions">
    <div onclick="event.stopPropagation()">{_status_select(job_id)}</div>
    {block_el}
    <button class="ignore-del-btn" data-id="{job_id}"
            onclick="ignoreAndDelete(this.dataset.id)">🗑️ Ignorer et supprimer</button>
  </div>
</div>"""

def _setup_warning() -> str:
    parts = []
    if not FT_CLIENT_ID:
        parts.append("""
    <li><b>France Travail</b> — inscription gratuite sur
      <a href="https://francetravail.io/data/api" target="_blank">francetravail.io/data/api</a> →
      créez une application → copiez <code>FT_CLIENT_ID</code> et <code>FT_CLIENT_SECRET</code>
      dans le fichier <code>.env</code></li>""")
    if not LBA_API_KEY:
        parts.append("""
    <li><b>La Bonne Alternance</b> — clé gratuite sur
      <a href="https://api.apprentissage.beta.gouv.fr" target="_blank">api.apprentissage.beta.gouv.fr</a> →
      créez un compte → copiez <code>LBA_API_KEY</code> dans le fichier <code>.env</code></li>""")
    if not JOOBLE_API_KEY:
        parts.append("""
    <li><b>Jooble</b> — clé gratuite sur
      <a href="https://jooble.org/api/about" target="_blank">jooble.org/api/about</a> →
      copiez <code>JOOBLE_API_KEY</code> dans le fichier <code>.env</code></li>""")
    if not CAREERJET_AFFID:
        parts.append("""
    <li><b>Careerjet</b> — affiliate ID gratuit sur
      <a href="https://www.careerjet.fr/partenaires/api" target="_blank">careerjet.fr/partenaires/api</a> →
      copiez <code>CAREERJET_AFFID</code> dans le fichier <code>.env</code></li>""")
    if not ADZUNA_APP_ID:
        parts.append("""
    <li><b>Adzuna</b> — inscription gratuite sur
      <a href="https://developer.adzuna.com/signup" target="_blank">developer.adzuna.com/signup</a> →
      copiez <code>ADZUNA_APP_ID</code> et <code>ADZUNA_APP_KEY</code>
      dans le fichier <code>.env</code></li>""")
    if not parts:
        return ""
    return f"""
  <div class="setup-warn">
    <h2>⚙️ Configuration requise</h2>
    <p>Renseignez les identifiants manquants dans le fichier <code>.env</code> :</p>
    <ol>{"".join(parts)}
    </ol>
  </div>"""

def _filter_bar() -> str:
    filters = [("", "Toutes")] + [
        (v, label) for v, (label, _, _) in STATUS_OPTIONS.items() if v
    ]
    btns = "".join(
        f'<button class="filter-btn{"  active" if v == "" else ""}" '
        f'data-filter="{v}" onclick="filterBy(\'{v}\')">'
        f'{label} <span class="filter-count">0</span></button>'
        for v, label in filters
    )
    return (
        f'<div class="filter-bar">'
        f'<button class="filter-btn alt-toggle" id="alt-toggle-btn" onclick="toggleAltOnly()">'
        f'⭐ Alternance uniquement <span id="alt-toggle-state">ON</span></button>'
        f'<span class="filter-sep">|</span>'
        f'{btns}'
        f'<button class="export-btn" onclick="exportStatuses()" '
        f'title="Télécharge status_jobs.json — placez-le dans le dossier alerte_emploi">'
        f'💾 Statuts</button>'
        f'</div>'
    )

def _settings_modal(config: dict, server_mode: bool) -> str:
    # Anti-injection : remplacer < > & par leurs séquences d'échappement Unicode JSON
    # (ex: <) — JavaScript les parse correctement mais </script> ne peut pas
    # fermer le bloc <script> prématurément.
    _raw = json.dumps(config, ensure_ascii=True)
    config_json = (
        _raw
        .replace("<",  "\\u003c")
        .replace(">",  "\\u003e")
        .replace("&",  "\\u0026")
    )
    if server_mode:
        mode_note = (
            "Les paramètres sont sauvegardés sur le serveur.<br>"
            "Ils seront pris en compte au prochain lancement du script."
        )
    else:
        mode_note = (
            "Mode fichier : téléchargez config.json et placez-le dans le dossier alerte_emploi,<br>"
            "puis relancez le script pour appliquer les changements."
        )
    return f"""
<div class="modal-overlay" id="settings-modal">
  <div class="modal-box">
    <div class="modal-header">
      <h2>⚙️ Paramètres de recherche</h2>
      <button class="modal-close" onclick="closeSettings()" title="Fermer">✕</button>
    </div>

    <div class="settings-section">
      <h3>Mots-clés / Métiers recherchés</h3>
      <div class="chip-list" id="kw-chips"></div>
      <div class="add-row">
        <input id="kw-input" class="settings-input" placeholder="ex: apprenti électricien"
               onkeydown="if(event.key==='Enter')addKeyword()" />
        <button onclick="addKeyword()">+ Ajouter</button>
      </div>
    </div>

    <div class="settings-section">
      <h3>Zones de recherche</h3>
      <div id="loc-list"></div>
      <div class="add-row" style="margin-top:8px;flex-wrap:wrap;gap:6px">
        <input id="loc-city" class="settings-input" placeholder="Ville (ex: Blois)"
               style="flex:2;min-width:140px"
               onkeydown="if(event.key==='Enter')addLocation()" />
        <input id="loc-radius" type="number" value="30" min="5" max="150"
               style="width:70px;flex:none;padding:7px 8px;border:1.5px solid #e2e8f0;border-radius:8px;font-family:inherit" />
        <span style="font-size:.8rem;color:#64748b;align-self:center">km</span>
        <button onclick="addLocation()">+ Ajouter</button>
      </div>
    </div>

    <div class="settings-footer">
      <button class="btn-secondary" onclick="closeSettings()">Annuler</button>
      <button class="btn-primary" onclick="saveConfig()">💾 Enregistrer</button>
    </div>
    <p class="settings-note">{mode_note}</p>
  </div>
</div>
<div class="save-toast" id="save-toast"></div>
<script>
var _cfg = {config_json};
</script>"""

def _javascript(statuses: dict, server_mode: bool) -> str:
    status_opts_js = json.dumps({
        v: {"label": label, "bg": bg, "text": text}
        for v, (label, bg, text) in STATUS_OPTIONS.items()
    })
    initial_js = json.dumps(statuses)
    return f"""<script>
const STATUS_OPTIONS = {status_opts_js};
const INITIAL_STATUSES = {initial_js};
const IS_SERVER = {'true' if server_mode else 'window.location.protocol === "http:"'};

// ── Statuts ───────────────────────────────────────────────────
function _localStatuses() {{
  try {{ return JSON.parse(localStorage.getItem("job_statuses") || "{{}}"); }}
  catch(e) {{ return {{}}; }}
}}
function _allStatuses() {{
  return Object.assign({{}}, INITIAL_STATUSES, _localStatuses());
}}
function _localBlocked() {{
  try {{ return JSON.parse(localStorage.getItem("blocked_ids") || "[]"); }}
  catch(e) {{ return []; }}
}}

function applyStatuses() {{
  const s = _allStatuses();
  const blocked = _localBlocked();
  document.querySelectorAll(".card[data-job-id]").forEach(card => {{
    const id = card.dataset.jobId;
    if (blocked.includes(id)) {{ card.classList.add("blocked"); return; }}
    const status = s[id] || "";
    card.dataset.status = status;
    const sel = card.querySelector(".status-select");
    if (sel) {{ sel.value = status; _styleSelect(sel, status); }}
  }});
  updateCounts();
}}

function _styleSelect(sel, status) {{
  const opt = STATUS_OPTIONS[status] || STATUS_OPTIONS[""];
  sel.style.background = opt.bg;
  sel.style.color = opt.text;
}}

function setStatus(sel) {{
  const card = sel.closest(".card");
  const id   = card.dataset.jobId;
  const status = sel.value;
  card.dataset.status = status;
  _styleSelect(sel, status);
  const local = _localStatuses();
  if (status) local[id] = status; else delete local[id];
  localStorage.setItem("job_statuses", JSON.stringify(local));
  if (IS_SERVER) {{
    fetch("/api/status", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify({{id, status}})
    }}).catch(() => {{}});
  }}
  updateCounts();
}}

function filterBy(status) {{
  document.querySelectorAll(".card").forEach(c => {{
    if (c.classList.contains("blocked")) return;
    const s = c.dataset.status || "";
    if (!status) {{
      // vue "Tous" : masquer les ignorés sauf si on filtre explicitement sur "ignore"
      c.style.display = (s === "ignore") ? "none" : "";
    }} else {{
      c.style.display = (s === status) ? "" : "none";
    }}
  }});
  document.querySelectorAll(".filter-btn").forEach(b => {{
    b.classList.toggle("active", b.dataset.filter === status);
  }});
}}

function updateCounts() {{
  const counts = {{}};
  let total = 0;
  document.querySelectorAll(".card[data-job-id]").forEach(c => {{
    if (c.classList.contains("blocked")) return;
    const s = c.dataset.status || "";
    counts[s] = (counts[s] || 0) + 1;
    total++;
  }});
  document.querySelectorAll(".filter-btn").forEach(btn => {{
    const f = btn.dataset.filter;
    const n = f === "" ? total : (counts[f] || 0);
    const badge = btn.querySelector(".filter-count");
    if (badge) badge.textContent = n;
  }});
}}

function exportStatuses() {{
  const merged = Object.assign({{}}, INITIAL_STATUSES, _localStatuses());
  const blob = new Blob([JSON.stringify(merged, null, 2)], {{type:"application/json"}});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "status_jobs.json";
  a.click();
}}

// ── Fausse offre / Spam ───────────────────────────────────────
function blockJob(jobId) {{
  if (!confirm("Signaler cette offre comme fausse ou spam ?\\nElle sera masquée définitivement.")) return;
  const card = document.querySelector('.card[data-job-id="' + jobId + '"]');
  if (card) {{ card.classList.add("blocked"); }}
  const blocked = _localBlocked();
  if (!blocked.includes(jobId)) {{
    blocked.push(jobId);
    localStorage.setItem("blocked_ids", JSON.stringify(blocked));
  }}
  if (IS_SERVER) {{
    fetch("/api/block", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify({{id: jobId}})
    }}).catch(() => {{}});
  }}
  updateCounts();
  _toast("Offre masquée. Elle sera supprimée au prochain lancement.");
}}

// ── Filtre Alternance uniquement ─────────────────────────────
function _getAltOnly() {{
  var v = localStorage.getItem("alt_only");
  return v === null ? true : v === "1";  // ON par défaut
}}

function _applyAltOnly(on) {{
  document.querySelectorAll("section").forEach(function(sec) {{
    var cards = sec.querySelectorAll(".card");
    var hasVisible = false;
    cards.forEach(function(c) {{
      if (c.classList.contains("blocked")) return;
      var isAlt = c.classList.contains("alternance");
      if (on && !isAlt) {{
        c.dataset._altHidden = "1";
        c.style.display = "none";
      }} else {{
        if (c.dataset._altHidden) {{
          delete c.dataset._altHidden;
          var status = c.dataset.status || "";
          c.style.display = (status === "ignore") ? "none" : "";
        }}
        if ((c.dataset.status || "") !== "ignore") hasVisible = true;
      }}
      if (isAlt && (c.dataset.status || "") !== "ignore") hasVisible = true;
    }});
    sec.style.display = (on && !hasVisible) ? "none" : "";
  }});
  var btn = document.getElementById("alt-toggle-btn");
  var lbl = document.getElementById("alt-toggle-state");
  if (btn) {{ btn.classList.toggle("off", !on); }}
  if (lbl) {{ lbl.textContent = on ? "ON" : "OFF"; }}
}}

function toggleAltOnly() {{
  var on = !_getAltOnly();
  localStorage.setItem("alt_only", on ? "1" : "0");
  _applyAltOnly(on);
}}

// ── Navigation liste ↔ détail ────────────────────────────────
function showOffer(id) {{
  document.getElementById("main-view").style.display = "none";
  document.querySelectorAll(".offer-page").forEach(function(p) {{ p.style.display = "none"; }});
  var page = document.getElementById("offer-" + id);
  if (page) {{
    page.style.display = "block";
    // Synchroniser le statut sur la page de détail
    var status = (document.querySelector('.card[data-job-id="' + id + '"]') || {{}}).dataset?.status || "";
    var sel = page.querySelector(".status-select");
    if (sel) {{ sel.value = status; _styleSelect(sel, status); }}
  }}
  history.pushState({{offer: id}}, "", "#offer-" + id);
}}

function backToList() {{
  document.querySelectorAll(".offer-page").forEach(function(p) {{ p.style.display = "none"; }});
  document.getElementById("main-view").style.display = "";
  history.pushState(null, "", window.location.pathname);
}}

function ignoreAndDelete(id) {{
  if (!confirm("Ignorer cette offre et supprimer sa page de détail ?\\nElle n'apparaîtra plus dans le rapport.")) return;
  // Ignorer via setStatus
  var card = document.querySelector('.card[data-job-id="' + id + '"]');
  if (card) {{
    card.dataset.status = "ignore";
    var sel = card.querySelector(".status-select");
    if (sel) {{ sel.value = "ignore"; _styleSelect(sel, "ignore"); }}
  }}
  var local = _localStatuses();
  local[id] = "ignore";
  localStorage.setItem("job_statuses", JSON.stringify(local));
  if (IS_SERVER) {{
    fetch("/api/status", {{
      method: "POST", headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify({{id: id, status: "ignore"}})
    }}).catch(function() {{}});
  }}
  // Supprimer la page de détail du DOM
  var page = document.getElementById("offer-" + id);
  if (page) page.remove();
  updateCounts();
  backToList();
}}

window.addEventListener("popstate", function(e) {{
  if (e.state && e.state.offer) {{
    showOffer(e.state.offer);
  }} else {{
    backToList();
  }}
}});

// Restaurer la vue au chargement si hash présent
(function() {{
  var h = window.location.hash;
  if (h && h.startsWith("#offer-")) {{
    showOffer(h.slice(7));
  }}
}})();

// ── Paramètres ────────────────────────────────────────────────
function openSettings() {{
  _renderSettings();
  document.getElementById("settings-modal").classList.add("open");
}}
function closeSettings() {{
  document.getElementById("settings-modal").classList.remove("open");
}}
document.addEventListener("DOMContentLoaded", function() {{
  const overlay = document.getElementById("settings-modal");
  if (overlay) overlay.addEventListener("click", function(e) {{
    if (e.target === overlay) closeSettings();
  }});
  applyStatuses();
  _applyAltOnly(_getAltOnly());
}});

function _esc(s) {{
  return String(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}}

function _renderSettings() {{
  // Mots-clés
  document.getElementById("kw-chips").innerHTML =
    (_cfg.keywords || []).map(function(kw, i) {{
      return '<span class="chip">' + _esc(kw) +
             '<button class="chip-del" onclick="_removeKw(' + i + ')" title="Supprimer">×</button></span>';
    }}).join("") || '<span style="color:#94a3b8;font-size:.8rem">Aucun mot-clé</span>';

  // Zones
  document.getElementById("loc-list").innerHTML =
    (_cfg.locations || []).map(function(l, i) {{
      var r = l.radius || 30;
      return '<div class="loc-item">' +
             '<span class="loc-city">📍 ' + _esc(l.city) + '</span>' +
             '<input type="range" class="loc-radius" min="5" max="150" value="' + r + '"' +
             ' oninput="_updateRadius(' + i + ',this.value)" />' +
             '<span class="loc-radius-val" id="rlbl' + i + '">' + r + ' km</span>' +
             '<button class="loc-del" onclick="_removeLoc(' + i + ')" title="Supprimer">🗑</button>' +
             '</div>';
    }}).join("") || '<p style="color:#94a3b8;font-size:.82rem">Aucune zone configurée</p>';
}}

function _removeKw(idx) {{
  _cfg.keywords.splice(idx, 1);
  _renderSettings();
}}
function _removeLoc(idx) {{
  _cfg.locations.splice(idx, 1);
  _renderSettings();
}}
function _updateRadius(idx, val) {{
  _cfg.locations[idx].radius = parseInt(val);
  var lbl = document.getElementById("rlbl" + idx);
  if (lbl) lbl.textContent = val + " km";
}}
function addKeyword() {{
  var inp = document.getElementById("kw-input");
  var val = inp.value.trim();
  if (!val) return;
  _cfg.keywords = _cfg.keywords || [];
  if (!_cfg.keywords.includes(val)) {{
    _cfg.keywords.push(val);
    inp.value = "";
    _renderSettings();
  }}
}}
function addLocation() {{
  var city   = document.getElementById("loc-city").value.trim();
  var radius = parseInt(document.getElementById("loc-radius").value) || 30;
  if (!city) return;
  _cfg.locations = _cfg.locations || [];
  var exists = _cfg.locations.some(function(l) {{
    return l.city.toLowerCase() === city.toLowerCase();
  }});
  if (!exists) {{
    _cfg.locations.push({{city: city, radius: radius}});
    document.getElementById("loc-city").value = "";
    _renderSettings();
  }}
}}
function saveConfig() {{
  var payload = {{keywords: _cfg.keywords, locations: _cfg.locations}};
  if (IS_SERVER) {{
    fetch("/api/config", {{
      method: "POST",
      headers: {{"Content-Type": "application/json"}},
      body: JSON.stringify(payload)
    }}).then(function(r) {{ return r.json(); }}).then(function(d) {{
      if (d.ok) {{
        closeSettings();
        _toast("Paramètres enregistrés ! Pris en compte au prochain lancement.");
      }}
    }}).catch(function() {{ alert("Erreur lors de la sauvegarde."); }});
  }} else {{
    var blob = new Blob([JSON.stringify(Object.assign({{}}, _cfg, payload), null, 2)],
                       {{type: "application/json"}});
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "config.json";
    a.click();
    closeSettings();
    _toast("Placez config.json dans le dossier alerte_emploi puis relancez le script.");
  }}
}}

function _toast(msg) {{
  var t = document.getElementById("save-toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() {{ t.classList.remove("show"); }}, 3500);
}}
</script>"""

def generate_html(jobs: list, new_ids: set, server_mode: bool = False) -> str:
    cfg     = load_config()
    multi   = [j for j in jobs if len(j.get("sources", [])) > 1 and not j.get("_archived")]
    single  = [j for j in jobs if len(j.get("sources", [])) <= 1 and not j.get("_archived")]

    sections = []
    def _sort_alt(lst):
        return sorted(lst, key=lambda j: (0 if _is_alternance(j) else 1, j.get("date", "")), reverse=False)

    # ── Offres expirées suivies (candidature en cours) ───────────────────────────────
    archived = [j for j in jobs if j.get("_archived")]
    active   = [j for j in jobs if not j.get("_archived")]
    if archived:
        cards = "".join(_card(j, False) for j in archived)
        sections.append(f"""
  <section>
    <h2>📦 Offres expirées — candidatures en cours ({len(archived)})</h2>
    <div class="grid">{cards}</div>
  </section>""")

    # ── Bloc alternance en tête (toutes sources confondues) ──────────────────────────
    alt_jobs = [j for j in active if _is_alternance(j)]
    alt_ids  = {j["id"] for j in alt_jobs}
    if alt_jobs:
        cards = "".join(_card(j, j["id"] in new_ids) for j in alt_jobs)
        sections.append(f"""
  <section>
    <h2>⭐ Offres en alternance — {len(alt_jobs)} offre{'s' if len(alt_jobs)>1 else ''}</h2>
    <div class="grid">{cards}</div>
  </section>""")

    # ── Multi-sources (hors alternance déjà affichée) ────────────────────────────────
    if multi:
        multi_rest = [j for j in multi if j["id"] not in alt_ids]
        if multi_rest:
            cards = "".join(_card(j, j["id"] in new_ids) for j in multi_rest)
            sections.append(f"""
  <section>
    <h2>🔁 Publiées sur plusieurs sources — {len(multi_rest)} offre{'s' if len(multi_rest)>1 else ''}</h2>
    <div class="grid">{cards}</div>
  </section>""")

    by_src: dict = {}
    for j in single:
        if j["id"] in alt_ids:
            continue  # déjà dans le bloc alternance
        src = j.get("sources", [j["source"]])[0]
        by_src.setdefault(src, []).append(j)

    # Sources configurées (même ordre que collect_all)
    active_sources = []
    if FT_CLIENT_ID and FT_CLIENT_SECRET:
        active_sources.append("France Travail")
    if LBA_API_KEY:
        active_sources.append("La Bonne Alternance")
    if JOOBLE_API_KEY:
        active_sources.append("Jooble")
    if CAREERJET_AFFID:
        active_sources.append("Careerjet")
    if ADZUNA_APP_ID and ADZUNA_APP_KEY:
        active_sources.append("Adzuna")

    # Afficher toutes les sources actives, même celles sans résultat
    for src in active_sources:
        items = by_src.get(src, [])
        if items:
            cards   = "".join(_card(j, j["id"] in new_ids) for j in _sort_alt(items))
            count   = f"{len(items)} offre{'s' if len(items)>1 else ''}"
            content_block = f'<div class="grid">{cards}</div>'
        else:
            count         = "0 offre"
            content_block = '<p class="empty-src">Aucune offre correspondante pour cette source.</p>'
        sections.append(f"""
  <section>
    <h2>{src} — {count}</h2>
    {content_block}
  </section>""")

    main_content = "".join(sections) if sections else '<p class="empty">Aucune offre pour le moment.</p>'
    offer_pages  = "".join(_offer_page(j) for j in jobs)
    now          = datetime.now().strftime("%d/%m/%Y à %H:%M")
    kw_str    = " · ".join(cfg.get("keywords", []))
    loc_str   = " · ".join(
        f"{l['city']} ({l.get('radius', 30)} km)"
        for l in cfg.get("locations", [])
    )
    all_srcs  = len({s for j in jobs for s in j.get("sources", [j["source"]])})
    statuses  = load_statuses()

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Alerte Emploi — {now}</title>
  <style>{_CSS}</style>
</head>
<body>
  <header>
    <h1>🔧 Alerte Emploi</h1>
    <p>Mise à jour : <strong>{now}</strong> &nbsp;|&nbsp; {html.escape(kw_str)} &nbsp;|&nbsp; {html.escape(loc_str)}</p>
    <div class="header-actions">
      <button class="settings-btn" onclick="openSettings()">⚙️ Paramètres</button>
    </div>
  </header>
  {_setup_warning()}
  <div class="stats">
    <div class="stat"><div class="n">{len(jobs)}</div><div class="l">Offres uniques</div></div>
    <div class="stat"><div class="n">{len(new_ids)}</div><div class="l">Nouvelles</div></div>
    <div class="stat"><div class="n">{len(multi)}</div><div class="l">Multi-sources</div></div>
    <div class="stat"><div class="n">{all_srcs}</div><div class="l">Sources actives</div></div>
  </div>
  <div id="main-view">
    {_filter_bar()}
    {main_content}
  </div>
  {offer_pages}
  {_settings_modal(cfg, server_mode)}
  {_javascript(statuses, server_mode)}
</body>
</html>"""

# ── Point d'entrée ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Alerte Emploi — Surveillance d'offres")
    parser.add_argument(
        "--serve", action="store_true",
        help=f"Lance un serveur local sur http://localhost:{SERVER_PORT} "
             f"pour sauvegarder les statuts et paramètres sans quitter le navigateur."
    )
    args = parser.parse_args()

    sep = "=" * 52
    print(f"\n{sep}")
    print(f"  Alerte Emploi — {datetime.now().strftime('%d/%m/%Y %H:%M')}")
    if args.serve:
        print(f"  Mode : serveur local (http://localhost:{SERVER_PORT})")
    print(f"{sep}\n")

    cfg = load_config()
    print(f"  Mots-clés : {', '.join(cfg.get('keywords', []))}")
    print(f"  Zones     : {', '.join(l['city'] + ' (' + str(l.get('radius',30)) + 'km)' for l in cfg.get('locations', []))}")
    print(f"  Bloquées  : {len(cfg.get('blocked_ids', []))} offres signalées\n")

    seen = load_seen()
    print(f"Offres déjà vues : {len(seen)}")
    print("\nCollecte en cours...\n")

    jobs    = collect_all()

    # Réintégrer les offres suivies qui ont expiré des API
    statuses    = load_statuses()
    cache       = load_jobs_cache()
    current_ids = {j["id"] for j in jobs}
    today       = datetime.now().strftime("%Y-%m-%d")

    # Statuts "en cours" : l'offre doit rester visible même si l'API ne la retourne plus
    ACTIVE_STATUSES = {"postule", "attente", "entretien", "accepte"}

    for job_id, status in statuses.items():
        if not status or status == "ignore":
            continue
        if job_id in current_ids:
            continue
        if job_id not in cache:
            continue

        cached  = cache[job_id]
        expires = cached.get("expires", "")

        if status in ACTIVE_STATUSES:
            # Offre suivie activement : réinjecter sans badge "Expirée"
            # (l'annonce a probablement été clôturée après candidature)
            ghost = cached.copy()
            ghost["_archived"]      = False
            ghost["_expire_reason"] = ""
            jobs.append(ghost)
        else:
            # Statut "refusé" ou autre : n'afficher que si date d'échéance dépassée
            if expires and expires < today:
                archived = cached.copy()
                archived["_archived"]      = True
                archived["_expire_reason"] = f"Date d'échéance dépassée ({_fmt_date(expires)})"
                jobs.append(archived)

    save_jobs_cache(jobs)

    new_ids = {j["id"] for j in jobs if j["id"] not in seen and not j.get("_archived")}

    print(f"\n  Nouvelles offres  : {len(new_ids)}")

    seen.update(j["id"] for j in jobs if not j.get("_archived"))
    save_seen(seen)

    report_html = generate_html(jobs, new_ids, server_mode=args.serve)
    REPORT_FILE.write_text(report_html, encoding="utf-8")
    print(f"\n  Rapport : {REPORT_FILE}")

    if args.serve:
        started = start_server()
        url = f"http://localhost:{SERVER_PORT}"
        if started:
            print(f"\n  Serveur démarré → {url}")
            print("  Statuts et paramètres sauvegardés automatiquement.")
            print("  Bouton ⚙️ dans le rapport pour modifier la recherche.")
            print("  (Ctrl+C pour quitter)\n")
        else:
            print(f"\n  Serveur déjà actif → {url}\n")
        import webbrowser
        webbrowser.open(url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print("\n  Serveur arrêté.")
    else:
        if new_ids:
            print(f"\n  *** {len(new_ids)} nouvelle(s) offre(s) ! Ouverture du rapport... ***")
            print("  Astuce : lancez avec --serve pour sauvegarder statuts et paramètres automatiquement.")
            os.startfile(str(REPORT_FILE))
        elif jobs:
            print("\n  Aucune nouvelle offre depuis la dernière vérification.")
        else:
            print("\n  Aucune offre trouvée. Vérifiez la configuration des sources.")

    print(f"\n{sep}\n")


if __name__ == "__main__":
    main()
