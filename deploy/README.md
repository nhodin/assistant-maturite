# Déploiement — Home Assistant OS (module complémentaire local)

Cible : Intel NUC D34010WYKH2 (i3-4010U, 2 cœurs / 4 threads, 8 Go), HA OS.
L'image est une image Docker ordinaire : le même `Dockerfile` sert au module HA,
à une VM dédiée (`docker-compose.yml`) et au test local.

```
PC Windows ──package-addon.ps1──► \\homeassistant\addons\maturity_analyzer
                                         │  (build par le Supervisor)
HA OS ─┬─ module MariaDB (core-mariadb:3306)  ◄── DATABASE_URL
       └─ module Maturity Analyzer :5173
             ├─ CloakBrowser (binaire stealth dans /data/cloakbrowser)
             ├─ Xvfb :99 (2e tentative « headed »)
             └─ /data/cloak-profiles (profils chauds par origine)
```

## 1. Prérequis dans Home Assistant

1. **MariaDB** (module officiel) → onglet *Configuration* :
   ```yaml
   databases:
     - maturite
   logins:
     - username: maturite
       password: <mot de passe fort>
   rights:
     - username: maturite
       database: maturite
   ```
2. **Samba share** (module officiel, utilisateur `homeassistant`) pour accéder à
   `\\192.168.1.200\local_apps` (modules locaux) et `\\192.168.1.200\share`.
   Côté PC, une fois par partage :
   `net use \\192.168.1.200\share /user:homeassistant * /persistent:yes`

## 2. Polices Windows (important pour l'anti-bot)

Sous Linux, CloakBrowser se présente comme un Chrome **Windows**. Sans les polices
Windows (Segoe UI, Calibri, Consolas, Courier New, Marlett, MS UI Gothic,
Franklin Gothic…), le fingerprint de polices contredit cette identité et les WAF
le repèrent.

Copier les polices de votre PC dans le partage HA (usage personnel, sous votre
licence Windows — elles ne sont **pas** intégrées à l'image) :

```powershell
New-Item -ItemType Directory -Force \\192.168.1.200\share\fonts-windows
Copy-Item C:\Windows\Fonts\*.tt[fc] \\192.168.1.200\share\fonts-windows
```

Au démarrage, le journal du module affiche `Windows fonts: /share/fonts-windows`,
sinon un `WARNING`.

## 3. Installer le module

```powershell
.\deploy\package-addon.ps1 -Destination \\192.168.1.200\local_apps
```

HA → *Paramètres → Applications → Installer une application* → ⋮ → *Rechercher
des mises à jour* → **Maturity Analyzer** (section *Local apps*) → Installer
(≈ 1 min 30 sur le NUC). HA 2026.9 ignore `build.yaml` et impose son image
Alpine via `BUILD_FROM` : l'image de base est donc fixée en dur dans le `Dockerfile`.

Options du module :

| Option | Rôle |
|---|---|
| `database_url` | `mysql://maturite:<mdp>@core-mariadb:3306/maturite` |
| `crux_api_key` | clé CrUX |
| `crux_bq_credentials` | clé JSON du compte de service GCP (rang CrUX de la colonne Audience) — contenu du fichier, brut ou en base64 ; le projet facturé est son `project_id` |
| `cloakbrowser_license_key` | clé Pro (`cb_…`) — le binaire Pro est téléchargé au 1er démarrage |
| `capture_concurrency` | **2 max** sur l'i3-4010U (au-delà, TTFB/LCP lab se dégradent) |
| `cloak_session_limit` | sessions de votre plan CloakBrowser |
| `cloak_proxy` | proxy résidentiel optionnel (l'IP de la box est déjà résidentielle) |
| `env_vars` | toute autre variable de `.env.example`, une ligne `CLE=valeur` |

Démarrer → l'UI est sur `http://192.168.1.200:5173`. Entrée « Maturity
Analyzer » dans la barre latérale : *Paramètres → Tableaux de bord → Ajouter →
Page web* avec cette URL (réservée aux administrateurs).

Mise à jour : voir §6.

## 4. Migrer les données

Sans ouvrir de port ni manipuler le mot de passe MariaDB :

```powershell
.\deploy\migrate-db.ps1 -ShareDir \\192.168.1.200\share
```

Le script exporte les données de la base XAMPP, renomme les tables (`runpage` →
`RunPage` : Windows stocke les noms en minuscules, Linux distingue la casse) et
dépose le dump dans `share\maturity-import\`. Au démarrage suivant, le module
l'importe **seulement si la base est vide** (journal : `import done: N runs`).
Supprimer ensuite ce dossier (données clients).

Les profils CloakBrowser chauds du PC (`data/cloak-profiles/`) ne sont pas
migrés : un profil Windows n'est pas réutilisable sous Linux, ils se
reconstituent au fil des runs.

## 5. Tester en local avant HA

```powershell
docker compose -f deploy/docker-compose.yml up --build
```

→ `http://localhost:5180` (MariaDB 11.4 comme le module HA). Test de migration :
`.\deploy\migrate-db.ps1 -TargetHost 127.0.0.1 -TargetPort 3307 -TargetPassword maturite`.

## 6. Mettre à jour le module

À faire après toute modification du code (`src/`, `prisma/`, `package*.json`,
`Dockerfile`, `deploy/`) qu'on veut voir tourner sur HA.

**Avant** (sur le PC) :

1. `npm run typecheck` et `npm test` passent.
2. Optionnel mais conseillé si le `Dockerfile` ou l'entrypoint ont changé :
   tester l'image en local (§5).
3. Pas de run en cours dans l'app HA : un redémarrage l'interrompt (il
   restera « interrompu », avec reprise possible depuis `/runs`).

**Déployer** :

```powershell
.\deploy\package-addon.ps1 -Bump -Destination \\192.168.1.200\local_apps
```

`-Bump` incrémente la version dans `deploy/ha-addon/config.yaml` (0.1.1 →
0.1.2). **Sans changement de version, HA ne propose pas la mise à jour.** Si
Windows répond « accès refusé », refaire le `net use` du §1.

Puis dans HA : *Paramètres → Applications → Installer une application* → ⋮ →
*Rechercher des mises à jour* → ouvrir **Maturity Analyzer** → **Mettre à jour**.
HA reconstruit l'image (≈ 1 à 2 min) et redémarre le module.

**Vérifier** : onglet *Journal* du module.

- `Your database is now in sync with your Prisma schema` : schéma OK.
- `Windows fonts: /share/fonts-windows` : polices OK.
- `CloakBrowser prêt : … (pro)` : binaire OK.
- Puis une collecte de test depuis *Diagnostics* dans l'app.

**Ce qui est conservé** : la base MariaDB (runs, projets, réglages) et `/data`
(binaire CloakBrowser, profils chauds). Une nouvelle version de CloakBrowser est
retéléchargée au démarrage (~220 Mo) si `cloakbrowser` a été mis à jour dans
`package.json`.

**Changement de schéma Prisma** : il est appliqué au démarrage par
`prisma db push`, **sans** `--accept-data-loss`. Une modification qui détruirait
des données (colonne supprimée, type réduit) bloque le démarrage : le journal
affiche l'erreur Prisma et `prisma db push failed 20 times`. Dans ce cas, prévoir
une migration à la main plutôt que de forcer.

**Revenir en arrière** : `git checkout <commit précédent> -- src prisma …`, puis
redéployer avec `-Bump` (la version ne doit jamais redescendre, HA ne proposerait
pas la « mise à jour »).

**Si le build échoue** : le message d'HA ne dit rien d'utile. Le détail est dans
*Paramètres → Système → Journaux → Supervisor* (chercher
`Docker build failed for local/amd64-addon-maturity_analyzer`).

## Limites connues

- **Linux est plus détectable que Windows** (mesuré le 2026-09-23, même IP, même
  CloakBrowser Pro 151, polices Windows installées, locale fr) :
  makeupforever.com, givenchybeauty.com et kenzoparfums.com passent dans le
  conteneur comme sur le PC, mais **kiabi.com renvoie 403 dans le conteneur et
  passe sur le PC**. Les WAF les plus stricts voient donc la différence entre un
  hôte Linux et un vrai Windows. Pour ces sites, capturer depuis le PC.

- **Provider `cdp`** (votre Chrome) : indisponible dans le conteneur, reste un
  outil du PC. Seul `cloak` est utilisé.
- **Mesures lab** (TTFB, LCP, long tasks) : dépendent du CPU et du réseau. Un run
  sur le NUC n'est pas comparable à un run historique fait sur le PC.
- **Ingress HA** non supporté : l'UI utilise des URL absolues (`/runs`…).
- Pas d'authentification dans l'app : voir ci-dessous avant toute exposition.

## Exposition publique — à ne PAS faire en NAT direct

Un NAT IP publique → `:5173` expose une app sans login ni HTTPS : données
clients lisibles, réglages modifiables, et n'importe qui peut lancer des runs —
consommant la licence CloakBrowser et **grillant l'IP résidentielle auprès
d'Akamai**. Recommandé, par ordre de préférence :

1. **Cloudflare Tunnel + Cloudflare Access** (module *Cloudflared*) : aucun port
   ouvert, IP maison masquée, HTTPS, connexion e-mail/SSO avant l'app.
2. NAT `443` → reverse proxy (Caddy / NGINX Proxy Manager) avec Let's Encrypt
   **et** authentification devant l'app.

Et ajouter un login applicatif en défense en profondeur.
