# POC — résultats & apprentissages

POC de l'évaluateur de maturité **sans LLM**. Chaîne validée de bout en bout :
`collecteur (Playwright + CDP + sondes Node) → moteur de règles → score → rapport MD/CSV`.

## Périmètre livré
- **Contrat partagé** `src/core` : `EvidenceBundle` (Zod) + interfaces `Control`/`TopicModule` + helper de fixture. Typecheck strict OK.
- **Collecteur** `src/collector` : HTML brut (fetch pré-JS), DOM rendu, capture réseau CDP (tailles transférées), PerformanceObservers (LCP/CLS/TTFB/long tasks), auto-scroll lazy-load, sondes Node (TLS/IPv6/HTTP3/ALPN), CrUX optionnel.
- **Thèmes pilotes** `src/topics` : **Images** (8 contrôles) + **CDN** (7 contrôles), fonctions pures.
- **Moteur** `src/engine` : config activable/repointable, agrégation HP/PLP/PDP, score global = moyenne thèmes 1–10, GEO/China à part, export MD + CSV (format de colonnes fixe de `../CLAUDE.md`).
- **CLI** `src/cli/index.ts` : lit `data/WEBSITES.csv`, audite, écrit `out/<date>-maturity.{md,csv}`, archive les bundles dans `evidence/`.
- **Tests** : 85 tests verts (vitest).

## Résultats (run 2026-06-29, voir `out/`)
| Site | Images | CDN | Overall | Capture |
|---|---|---|---|---|
| BULY1803 | 65 | 85 | **75** | complète (Shopify/Cloudflare) |
| MAKEUPFOREVER | 45 | 70 | 53 | **bloquée** (Akamai) — fetch pré-JS seul |
| Givenchy Beauty | 60 | 70 | 60 | **bloquée** (Akamai) |
| Kenzo | 15 | 70 | 38 | **bloquée** (Akamai) |

Référence audit manuel (2026-03-30) pour BULY : Images 70 / CDN 90 → **écart faible** sur le site bien capturé, ce qui valide la cohérence du scoring déterministe.

## Apprentissage clé : anti-bot Akamai
3 des 4 sites LVMH renvoient **Akamai « Access Denied »** à la navigation headless (WAF bot). Conséquence : DOM rendu vide + 0 sous-ressource → les contrôles dépendant du réseau/rendu chutent. Le `fetch` pré-JS passe (HTML brut, en-têtes, polices, sonde réseau restent exploitables).

Prouvé que la capture complète fonctionne sur tout site qui rend réellement (bbc.com : 237 requêtes dont 71 images, LCP = vrai `<img>`).

### Pistes de contournement (évaluées)
1. **Chrome réel/persistant non-headless** (profil utilisateur réel) — souvent suffisant contre Akamai.
2. **Proxy résidentiel** + stealth pour des runs serveur.
3. **IP d'origine autorisée** (allowlist côté CDN/WAF) si accès interne LVMH possible.
4. **CloakBrowser** (vrai Chromium patché, compatible Playwright) — ✅ **retenu et intégré**.

### ✅ Résolu — CloakBrowser
`Obscura` écarté (moteur Rust réécrit → échouerait au capteur Akamai ; la randomisation de fingerprint aggrave). `CloakBrowser` retenu : binaire Chromium patché signé (Ed25519 + SHA-256), API 100% compatible Playwright (`newContext`/`addInitScript`/`newCDPSession` OK).

Intégré comme **fournisseur navigateur commutable** dans `src/collector/browser.ts`, sélectionnable par `--browser cloak` (Playwright reste le défaut). L'UA stealth de CloakBrowser est préservée (pas d'override d'émulation pour ne pas re-exposer l'automation).

**Résultat (run cloak, IP locale résidentielle, sans proxy) :** les 3 sites Akamai entièrement capturés —
MUFE 68 images / Givenchy 76 images (LCP `fetchpriority=high` détecté) / Kenzo 52 images. Scores désormais adossés à de vraies données.

**Limites :** binaire tiers ~535 Mo (gratuit en v146, v148+ « Pro » payant) ; sans proxy résidentiel, un run depuis une IP datacenter (VPS) pourrait être re-bloqué par réputation IP → prévoir option `--proxy` (déjà câblée) pour la prod.

## Prochaines étapes
- Pour la prod sur VPS : valider CloakBrowser + proxy résidentiel (ou allowlist IP côté LVMH).
- Étendre aux 10 thèmes restants (mêmes patterns).
- Ajouter Lighthouse pour `coverage` CSS/JS (actuellement `null`).
- API + UI (config des contrôles, runs, dashboard) — couche suivante du plan.
- Persistance MySQL (Prisma) — schéma défini dans `../docs/FAISABILITE-evaluateur-maturite.md`.
