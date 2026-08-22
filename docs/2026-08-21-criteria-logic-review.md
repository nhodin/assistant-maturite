# Revue de la logique des critères — 2026-08-21

Revue du code des contrôles (`src/topics/*.ts`) **par rapport à ce que chaque critère est censé
mesurer** — cohérence interne de la détection, faux positifs/négatifs, incohérences entre
contrôles. Complète la revue du 2026-07-02 (dont la plupart des findings ont été corrigés).

Légende sévérité : 🔴 verdict probablement faussé sur des sites réels · 🟠 verdict faussé dans
des cas plausibles / incohérence de logique · 🟡 approximation assumée ou risque faible.

> **Mise à jour 2026-08-22 — les 5 findings majeurs (M1 à M5) sont corrigés** (531 tests
> verts, typecheck OK), avec deux précisions validées par l'utilisateur : le sujet 2 est
> **N/A quand le LCP n'est pas une image du slider** (slider secondaire / sous le viewport),
> et pour M5 les **hits CDN constatés priment sur `private`** (Akamai peut cacher en edge
> tout en renvoyant `private` au client). Détail des correctifs dans `../CLAUDE.md` (spec,
> sujets 2/5/9/12) et dans le bloc « Second detection-logic review » de `CLAUDE.md` (app).
> Les findings modérés (O1–O8) et mineurs restent ouverts.
>
> **Mise à jour 2026-08-22 (2) — findings modérés : O1 et O3 à O8 corrigés** (553 tests
> verts, typecheck OK) ; voir le bloc « Moderate-findings wave » de `CLAUDE.md` (app) et la
> spec (sujets 3/8/9/10). **O2 est validé** sous la forme d'un état « à confirmer »
> (unknown = échec par défaut tant qu'il n'est pas arbitré manuellement, score affiché
> provisoire) — chantier séparé en cours. Les findings mineurs restent ouverts.
>
> **Mise à jour 2026-08-22 (3) — O2 livré** : état « à confirmer » implémenté de bout en
> bout (contrat `ControlVerdict.unknown`, propagation moteur + agrégat site,
> `countPendingConfirmations`, badges UI « ? » et « provisoire », arbitrage via la
> correction manuelle existante). 6 contrôles émetteurs ; `ttfb.bfcache` exclu à dessein.
> 567 tests verts. **Tous les findings 🔴 et 🟠 de cette revue sont désormais traités** ;
> seuls les 🟡 mineurs restent ouverts.

---

## 🔴 Majeur

### M1 — Sujet 2 (Slider) : aucun contrôle n'est scopé au slider
`slider.firstimgnojs`, `slider.lazyloadrest`, `slider.preloadnext` scannent **tout le rawHtml**,
pas le markup du slider :
- `firstimgnojs` (30 pts) passe dès qu'UNE `<img>` de la page a un src réel — le logo du header
  suffit. Un slider 100 % rendu en JS valide quand même « First image loaded without JS ».
- `lazyloadrest` (20 pts) passe sur n'importe quelle image lazy de la page (footer, PLP…).
- `preloadnext` (10 pts) passe sur n'importe quel `<link rel=preload as=image>` — presque
  toujours le preload LCP, déjà crédité par `images.lcppreload`. Ce n'est jamais un preload de
  « prochaine slide ».
- `delaynext` (15 pts) compte toute image chargée en phase interaction, slider ou non.

Un site avec slider entièrement JS peut donc scorer 60+ /100 sans une seule bonne pratique
slider. À noter : `features.sliderHtml` existe dans le schéma (`core/schema.ts:161`) et est
déclaré dans le collector (`collector/index.ts:655`) mais **n'est jamais alimenté ni consommé**
— le scoping documenté dans `app/CLAUDE.md` (« slider controls scoped to the detected slider
markup (features.sliderHtml) ») n'est pas dans le code.

**Reco** : alimenter `features.sliderHtml` dans le collector et scoper les 4 contrôles HTML
dessus (fallback page entière si absent, avec mention « unscoped » dans l'evidence).

### M2 — `china.nogfwcritical` compte les scripts defer/async comme render-blocking
`china.ts:127` prend **tout** `<script src>` du `<head>` sans exclure `defer`/`async`/
`type=module`, alors que le critère est « no **render-blocking** resource (sync JS, CSS,
preload) » et que `tp.selfhost` fait correctement cette exclusion. Un GA/GTM chargé en `async`
dans le head — le cas ultra-majoritaire — fait échouer les 30 pts à tort. (Le fait que le
domaine soit GFW-bloqué reste un problème de *délai* pour l'utilisateur chinois, mais pas un
blocage du rendu ; c'est le critère tel qu'énoncé qui n'est pas implémenté.)

**Reco** : réutiliser la même règle que `tp.selfhost` (`hasDefer` → hors périmètre), ou
renommer le critère si l'intention est bien « tout script GFW dans le head ».

### M3 — `video.selfhosted` : un src root-relatif échoue le test same-site
`video.ts:343` utilise `sameSite(src, e.finalUrl)` : pour `src="/videos/x.mp4"`,
`host(src) === ""` → `sameSite` retourne **false** (il exige deux hosts non vides). Or un
chemin root-relatif est premier-partie par construction — `util.ts` a d'ailleurs
`isFirstParty` exactement pour ça. Le rattrapage par « first-party media request » ne joue pas
pour un `<video preload="none">` jamais téléchargé pendant la capture → faux échec du cas le
plus vertueux (self-hosted + pas de préchargement).

**Reco** : remplacer `sameSite` par `isFirstParty` pour les src issus du markup.

### M4 — `fonts.noiconfonts` : « feather » testé sur tout le rawHtml
`ICON_FONT_RE` contient `feather` (pour Feather Icons) et `htmlHit` teste la **page entière**
(`fonts.ts:246`). « feather » est un mot anglais courant — sur des sites mode/luxe,
« feather-light », « feather detail », « ostrich feather » sont réalistes → icon font détectée
à tort, 10 pts perdus. Même risque, moindre, pour « Material Icons » cité dans du texte.

**Reco** : restreindre le test rawHtml aux contextes techniques (valeurs de `class`, URLs
de `<link>`) ou retirer `feather` du pattern appliqué au HTML libre (le garder pour les
requêtes font et les familles `@font-face`, non ambiguës).

### M5 — `ttfb.cdncache` : `private, s-maxage=N` passe
L'étape 5 (`s-maxage > 0`, `ttfbcache.ts:66`) ne vérifie pas `private`/`no-store`, alors que
l'étape 6 (fallback max-age) le fait. `Cache-Control: private, s-maxage=600` interdit tout
cache partagé (le `private` prime ; le `s-maxage` est sans objet pour un cache privé) — le
contrôle conclut pourtant « CDN cache » validé, 35 pts.

**Reco** : appliquer le même garde-fou private/no-store/no-cache aux étapes 5 et 6.

---

## 🟠 Modéré

### O1 — `cdn.region` : scan de sous-chaîne sur toutes les valeurs de headers
`cdn.ts:168` passe si « cloudflare »/« akamai »/« fastly » apparaît dans **n'importe quelle**
valeur de header du document. Un `Content-Security-Policy` listant `cdnjs.cloudflare.com`, ou
un `report-uri`, suffit → CDN « inféré » à tort. Limiter le scan aux headers d'infrastructure
(`server`, `via`, `x-served-by`, `server-timing`) éliminerait le faux positif CSP.

### O2 — Traitement incohérent du « non mesuré », y compris au sein d'un même sujet
La politique « unmeasured ≠ failed » est notée comme décision différée depuis 2026-07, mais le
code contient des paires contradictoires pour la même situation épistémique :

| Donnée absente | Contrôle | Verdict |
|---|---|---|
| LCP non identifié | `images.lcppreload` | **pass** (weak match sur tout preload) |
| LCP non identifié | `images.lcpnotlazy` | **fail** |
| CLS null | `slider/video.reservedspace` | fail |
| Coverage CSS null | `css.unused` | fail |
| Tailles images inconnues (cache) | `images.compressed` | pass (low confidence) |
| Handlers unload non scannables (JS externe) | `ttfb.bfcache` | pass (low confidence) |
| @font-face non capturées mais fonts téléchargées | `fonts.fontdisplay` | fail |

Les deux premiers cas sont dans le **même sujet** : le même LCP inconnu rapporte 15 pts d'un
côté et en retire 10 de l'autre. Une convention unique (ou un troisième état) serait plus
défendable en audit.

### O3 — `video.preloadposter` passe quand il n'y a pas de poster du tout
Quand `resolvePosterEvidence` ne trouve rien, `posternojs` échoue (logique) mais
`preloadposter` **passe** en « weak match » sur n'importe quel preload d'image
(`video.ts:317`). Un site sans poster gagne donc les 20 pts d'un critère qui présuppose le
critère à 30 pts. Le weak match se justifiait quand le poster était introuvable *par l'outil* ;
depuis le resolver overlay/noscript, « aucun poster résolvable » signifie surtout « pas de
poster sans JS » → le fallback devrait échouer (ou au minimum être neutre).

### O4 — `video.playerjs` : le cas idéal (aucun player JS) échoue
Une vidéo native self-hosted sans aucun player tiers → aucun host player détecté → fail
(`video.ts:415`). Le meilleur comportement possible échoue « Fine-tune loading of JS scripts
video player ». À l'image de `tp.deferasync` (0 script tiers → pass), zéro requête vers un
host player devrait passer le critère. Idem, en plus discutable, pour `video.preconnect`
(5 pts) : rien à préconnecter → fail.

### O5 — `fonts.woff2` : seuils incohérents entre les deux chemins
Chemin requêtes : ratio **> 50 %** suffit. Chemin fallback `@font-face` : il faut **100 %**
(`woff2.length === e.fonts.length`) — et une `@font-face` `local()`-only (sans format) suffit
à faire échouer alors qu'elle ne télécharge rien. Harmoniser (majorité dans les deux cas,
`local()`-only exclues comme dans `fontdisplay`/`max2`).

### O6 — `fonts.fallback` : le `local()` idiomatique compte comme « adjusted fallback »
`src: local("Foo"), url(foo.woff2)` — l'idiome standard « utilise la police installée si
présente » — passe les 20 pts (`fonts.ts:312` : n'importe quel `local(` dans n'importe quel
src). Une vraie stratégie de fallback ajusté est soit une métrique (size-adjust & co, déjà
testée), soit une `@font-face` **dédiée** `local()`-only (`isLocalOnlySrc`, helper déjà
présent). Le signal actuel est trop généreux pour le 2ᵉ critère le mieux doté du sujet.

### O7 — Deux `cacheControlMaxAge` exportés, sémantiques différentes
`ttfbcache.ts` (s-maxage prioritaire, retourne `null`) vs `cdn.ts` (max-age seul, retourne
`-1`). Même nom, contrats différents, et `topics/index.ts:33` réexporte celui de cdn. Pas de
bug de verdict aujourd'hui, mais un piège à drift certain — renommer ou fusionner.

### O8 — `cp.limitresources` : « critique » = tout script+stylesheet
Tous les scripts/stylesheets hors phase interaction sont sommés, y compris defer/async/lazy
qui ne sont pas sur le chemin critique. Le seuil 600 KB compense, mais l'étiquette « critical
resources » ne correspond pas à la mesure : un site vertueux (tout en defer, gros bundle
différé) peut échouer, un site avec 500 KB de CSS bloquant peut passer. À défaut de refonte,
pondérer par render-blocking (sync head scripts + stylesheets screen) serait plus fidèle.

---

## 🟡 Mineur

- **`images.lazyload` / `slider.lazyloadrest`** : une seule image lazy suffit — aucun ratio.
  Un site à 60 images eager + 1 lazy valide « Basic lazyloading » (30 pts).
- **`looseUrlMatch` (images.ts + video.ts)** : le match par dernier segment fait matcher deux
  fichiers distincts nommés `hero.jpg` ; et la fonction est dupliquée dans deux modules
  (risque de drift — la doc du sujet 3 revendique « ONE poster resolver » mais le matcher,
  lui, existe en double).
- **`images.fixedheight`** : `style="width:100%;height:auto"` compte comme dimensionné alors
  qu'il ne réserve aucune hauteur sans aspect-ratio. Rattrapé le plus souvent par le
  raccourci CLS < 0.01.
- **`js.splittasks`** : `scheduler.yield` est cherché dans le rawHtml seulement — il vit
  quasi toujours dans les bundles externes, donc la branche est morte en pratique ; le
  contrôle se réduit à « zéro long task », très dépendant de la machine de capture quand le
  throttling CPU est off (défaut actuel).
- **`js.defer` vs `js.endofbody`** : fort recouvrement — une page tout-defer dans le head
  crédite 50 pts pour le même fait. Assumé (les critères de la spec se recouvrent aussi),
  mais à garder en tête en lecture de score.
- **`tp.eventbased`** : les tags consent lents peuvent déborder du settle post-cookie
  (1 500 ms + networkidle 5 s) dans la fenêtre interaction → « event-based loading » crédité
  à tort. Ordre du collector correct, risque résiduel purement temporel.
- **`slider.delaynext`** : la sonde interaction émet wheel/scroll → une image lazy juste sous
  le fold chargée pendant la fenêtre passe pour une « next slide » différée.
- **`fonts.selfhost`** : une URL relative dans une `@font-face` d'un stylesheet **tiers** est
  traitée first-party (`isFirstParty` résout contre la page, pas contre le stylesheet).
- **`geo.weight1mb`** : fallback `rawHtml` sur un bundle slimmé (2 000 chars) → passe
  trivialement si `htmlBytes` manque. Documenté dans le code, mais silencieux dans l'evidence.
- **`ttfb.specrules`** : `/speculationrules/i` sur le Link header entier peut matcher une URL
  contenant le mot ; théorique.
- **`cdn.longttl`** : `max-age` impair + `age ≥ 3600` ⇒ « countdown d'un long TTL » — un TTL
  authored non-rond de quelques heures avec un objet resté 1 h en cache passe pour long.
  Heuristique voulue par la spec, à la marge près.

---

## Ce qui est solide (vu en passant)

- Gate vidéo (critical path) partagé par les 6 contrôles, avec l'exception LCP ; resolver de
  poster unique pour `posternojs`/`preloadposter`.
- Fenêtre interaction du collector correctement placée (après settle cookies, avant
  autoScroll) — la base des 4 contrôles « event-based » est saine.
- `fonts.fontdisplay` : périmètre (local()-only, icon fonts, « aucune webfont » vs
  « non capturable ») finement traité, offenders nommés.
- Délégation GEO (mêmes verdicts que les sujets sources) et composite AND avec évidence des
  deux moitiés.
- `browserCacheControl` : `private` correctement non-bloquant pour le cache navigateur.
- Split des directives Link header sur `,(?=\s*<)` (URLs à virgule) partout où c'est parsé.
