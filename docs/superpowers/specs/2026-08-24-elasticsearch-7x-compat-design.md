# Compatibilité Elasticsearch 7.x — design

Date : 2026-08-24
Statut : approuvé, en implémentation

## Problème

Le serveur MCP utilise `@elastic/elasticsearch` 8.17.1, structurellement incapable
de parler à un cluster Elasticsearch 7.8.0 (cible : `logging-cluster`, 7.8.0,
`build_flavor: default`).

Deux blocages vérifiés dans le paquet publié, tous deux codés en dur dans
`lib/client.js` du client 8.17 et absents de `ClientOptions` :

- `productCheck: 'Elasticsearch'` — contrôle fondé sur l'en-tête
  `x-elastic-product`, qu'Elasticsearch n'émet qu'à partir de 7.14 ;
- media types `compatible-with=8`, qu'un serveur 7.8 rejette.

Seul du monkey-patching des internes du client les contournerait.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Matrice de versions | 7.x uniquement | Une seule forme d'API à écrire et à tester |
| Client | `@elastic/elasticsearch` `^7.17.14` | Son *product check* accepte les serveurs < 7.14 via `tagline` + `build_flavor` |
| Absorption du changement d'API | Réécriture directe des outils | Préserve la minceur délibérée des trois couches ; garde `tsc --strict` pleinement engagé, seul filet de sécurité du dépôt |
| Publication | Fork renommé `elasticsearch7-mcp` | Ne casse pas les utilisateurs ES 8 du nom amont |

Options écartées : une couche d'adaptation `src/es/client.ts` (indirection sans
contrepartie dès lors que la cible est mono-version — YAGNI) et des appels bruts
via `client.transport.request()` (perte des APIs typées et de toute vérification
du compilateur dans un dépôt sans tests).

## Faits vérifiés dans les paquets npm

Constatés en dépaquetant `@elastic/elasticsearch@7.17.14` et `@8.17.1`, non de mémoire :

- `lib/Transport.js` du client 7.17 : pour `major === 7 && minor < 14`, le product
  check valide `tagline === 'You Know, for Search'` **et**
  `version.build_flavor === 'default'`. Le `GET /` du cluster cible satisfait les deux.
- Le client 7.17 exporte `estypes` (`SearchRequest`, `ReindexRequest`,
  `SearchHighlightField`), avec le DSL niché dans `body?: { … }`.
- Forme des réponses 7.x : `{ body, statusCode, headers, warnings, meta }`.
- `ClientOptions` 7.x nomme l'option TLS **`ssl`**, non `tls`.
- Requêtes `HEAD` : un 404 ne lève pas d'erreur, `result.body` est converti en
  booléen. La logique de branchement de `createMapping` est donc préservée telle quelle.
- `engines: node >= 12` — compatible avec le Node 22.14 du `.nvmrc`.
- Le client 7.17 pourrait aussi joindre un cluster ES 8 via
  `ELASTIC_CLIENT_APIVERSIONING=true`. Hors périmètre : non câblé, non documenté,
  non testé.

## Portée des modifications

### Code

- `package.json` : dépendance client, renommage (`name`, clé `bin`), `version` 1.0.0,
  retrait de `homepage`/`bugs`/`repository` tant qu'aucune URL de fork n'existe —
  laisser pointer vers l'amont détournerait ses issues.
- `src/config/schema.ts` : `clientOptions.tls` → `clientOptions.ssl`. Le garde-fou
  `username && password` est conservé : c'est lui qui neutralise le
  `process.env.USERNAME` toujours défini sous Windows.
- Les 10 fichiers de `src/tools/` : DSL enveloppé dans `body`, lecture des réponses
  via `.body`. Correction au passage de `listIndices`, où `index.docsCount` n'est
  qu'un alias de type : l'API `cat` renvoie la clé `docs.count`, donc ce champ vaut
  `undefined` à l'exécution.
- `src/server.ts` : nom du `McpServer` aligné sur le fork.

Invariants préservés : signatures `(esClient, …)`, forme de retour
`{ content: [{ type: "text", text }] }`, aucune exception levée, erreurs renvoyées
en fragment préfixé `Error:`. Les noms d'outils et les schémas zod ne
changent pas — un client MCP existant ne voit aucune différence.

### Vérification

`npm run build` (`tsc --strict`) reste la seule vérification automatique.

`scripts/smoke.mjs` (JS pur, hors compilation) importe les fonctions réexportées
depuis `dist/src/server.js` et les exécute réellement : lecture seule par défaut
(`elasticsearch_health`, `list_indices`, `get_mappings`, `search` en `size: 1`),
écritures sur index jetable via `--write <index>`. Les outils ne levant jamais,
l'échec est détecté en cherchant le préfixe `Error:` dans les fragments retournés,
avec code de sortie non nul.

**Limite assumée** : le poste de développement n'atteint pas le cluster. La
compilation est donc la seule preuve apportée ; tout le comportement d'exécution
reste à vérifier par l'exploitant via ce script.

### Documentation

`README.md`, `README.zh-CN.md` (cible 7.x, nouveau nom `npx`, renvoi vers l'amont
pour ES 8, retrait du badge Smithery amont), `CHANGELOG.md`, `smithery.yaml`
(description), `CLAUDE.md` (faits client, contrat `.body`, `ssl`, `docs.count`).
`Dockerfile` inchangé.

## Note sur les fichiers de verrouillage

(Historique : le projet est passé à pnpm depuis, avec `pnpm-lock.yaml` pour seul
lockfile.) Yarn est absent de la machine de migration, mais `npm install` (npm 11) maintient
le `yarn.lock` existant : il l'a resynchronisé sur le client 7.17 et a supprimé
l'arbre `@elastic/transport`, que le client 7.x embarque lui-même. Un
`package-lock.json` a également été créé. Le dépôt porte donc deux locks
cohérents ; npm est l'outil utilisé par la doc et le `Dockerfile`.
