# Recherche de logs ECS — design

Date : 2026-08-25
Statut : validé et implémenté (0.3.0)
Version cible : 0.3.0

## Problème

Les 26 outils actuels sont génériques : ils parlent à un cluster, pas à un
schéma. Pour la question la plus fréquente d'un cluster de logs — « les erreurs
du service de facturation depuis une heure » — un modèle doit écrire une
quinzaine de lignes de DSL, connaître le mapping, et il reçoit du `_source`
verbeux dont il n'a besoin que de cinq champs.

Or les logs sont en **ECS**, poussés par l'éditeur : le schéma est *connu
d'avance*. C'est exactement ce qui permet d'offrir des paramètres nommés au lieu
d'un DSL, et une sortie en lignes de log au lieu d'un vidage JSON. Le gain est
double, et le second compte autant que le premier : moins de contexte consommé
par réponse.

## Contrainte de version, qui cadre les types

Le cluster cible est en **7.8**, et deux types utilisés par l'ECS récent n'y
existent pas : `match_only_text` est arrivé en **7.14**, `wildcard` en **7.9**.
L'éditeur pousse donc nécessairement des mappings d'avant ECS 1.12. Vérifié sur
les deux révisions qui encadrent la bascule :

| Champ | ECS 1.6 | ECS 1.12 |
|---|---|---|
| `error.message` | `text` | `match_only_text` |
| `error.stack_trace` | `keyword` + `.text` (`text`) | `wildcard` + `.text` |

Le module vise donc les types ECS 1.x, sans requête de découverte. Deux
conséquences directes sur le design :

- **`error.message` ne s'agrège pas** — ni en `text`, ni en `match_only_text`, et
  l'ECS ne lui donne aucun sous-champ `keyword`. Grouper les erreurs par message
  est hors de portée à moins qu'un *dynamic template* local n'ajoute
  `error.message.keyword`.
- **`error.stack_trace` s'agrège** en 1.x puisqu'il est `keyword` — et c'est un
  piège. Les gabarits ECS posent `ignore_above: 1024` sur les keyword, donc une
  trace plus longue n'est **pas indexée** et disparaît silencieusement d'une
  agrégation. Grouper par trace donnerait un décompte faux qui a l'air juste. À
  confirmer sur votre gabarit ; en attendant, le regroupement se fait sur
  `error.type`.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Forme | Un **quatrième jeu d'outils**, `src/register/ecsTools.ts` | La même architecture que les trois autres : le gating est l'enregistrement, donc un déploiement sans logs ECS ne paie pas un octet de schéma dans son `tools/list` |
| Activation | `ES_ECS_TOOLS=true` ou `1`, sans repli non préfixé | Convention de `ES_ADMIN_TOOLS` ; un `ECS_TOOLS` ambiant ne doit pas décider de la surface du serveur |
| Cible des requêtes | `ES_ECS_INDEX_PATTERN`, **requise** quand le jeu est actif | Absente, c'est un refus au démarrage, comme un bloc OAuth2 partiel. Un défaut `logs-*` faux balaierait des index qui ne sont pas les vôtres, et répondrait sans le dire |
| Version ECS | Types ECS 1.x, documentés | Voir ci-dessus : 7.8 ne peut pas exprimer les autres |
| Outils | `search_logs`, `log_histogram`, `error_summary`, `top_values` | Les quatre questions d'une enquête : qu'est-ce qui s'est passé, depuis quand, qu'est-ce qui est cassé, chez qui |
| Pas de DSL libre | Aucun paramètre n'accepte de query DSL | `search` existe déjà pour ça. Un `filter` brut ici ferait un doublon avec deux façons de se tromper, et ferait grossir un schéma dont l'intérêt est d'être petit |
| Temps relatif | `15m`, `2h`, `7d` deviennent `now-15m` ; tout le reste passe tel quel | Une expression de date Elasticsearch reste utilisable pour un cas précis, sans que le cas courant coûte huit caractères de cérémonie |
| Champs rapatriés | `_source` limité aux champs rendus | Sur 500 événements ECS, demander tout le `_source` est la différence entre une réponse et un budget épuisé. C'est le même constat que la phase 1, appliqué à la requête plutôt qu'à la sortie |
| Pagination | Par le temps (`until`), pas par `from` | L'idiome des logs, et le *deep paging* d'Elasticsearch est le chemin coûteux. `limit` réutilise le plafond de 100 de `MAX_SEARCH_SIZE` |
| Niveaux | Échelle connue, casse ignorée, valeurs inconnues passées en termes exacts | `log.level` est un `keyword` sans vocabulaire imposé par l'ECS : `ERROR`, `error` et `SEVERE` coexistent selon les bibliothèques. Une échelle qui écarterait ce qu'elle ne connaît pas ferait disparaître des lignes sans le dire |
| Regroupement des erreurs | `error.type` | Le seul champ `keyword` sûr. `error.message` ne s'agrège pas, `error.stack_trace` est tronqué par `ignore_above` |
| Champ `text` demandé à `top_values` | Aucune liste blanche : on traduit l'erreur du cluster | Même choix que pour `WWW-Authenticate` en 0.2.0 — un message qui nomme le problème et les alternatives `keyword` vaut mieux qu'un garde-fou qui interdit un champ personnalisé légitime |
| `structuredContent` | Aucun sur ces quatre outils | Mesuré en phase 4 : les mêmes faits coûtent environ le double en JSON qu'en ligne compacte. Ici la ligne de log *est* la réponse |

## Faits vérifiés

- ECS 1.6 : `error.message` en `text`, `error.stack_trace` en `keyword` avec un
  sous-champ `.text` — <https://www.elastic.co/guide/en/ecs/1.6/ecs-error.html>
- ECS 1.12 : les mêmes champs en `match_only_text` et `wildcard` —
  <https://www.elastic.co/guide/en/ecs/1.12/ecs-error.html>
- ECS actuel (9.x) : `log.level` et `log.logger` sont `keyword` et **core**,
  `error.type` est `keyword` ; aucun de ces trois n'a changé de type depuis 1.x —
  <https://www.elastic.co/docs/reference/ecs/ecs-log>
- `match_only_text` existe depuis Elasticsearch 7.14, `wildcard` depuis 7.9 :
  c'est ce qui borne la version d'ECS qu'un cluster 7.8 peut porter.

Les champs sur lesquels le module filtre et agrège sont donc tous des `keyword` :
`log.level`, `log.logger`, `service.name`, `service.environment`, `host.name`,
`error.type`, `event.dataset`, `trace.id`. Le texte libre porte sur `message` et
`error.message`, tous deux `text`, via un `multi_match`.

## Portée des modifications

### Code

- **`src/tools/ecs/fields.ts`** (nouveau) — les constantes ECS et l'échelle des
  niveaux. Un seul endroit où le nom d'un champ est écrit, parce qu'une faute de
  frappe dans `service.name` ne produit pas d'erreur : elle produit zéro
  résultat, ce qui se lit comme « il n'y a rien ».
- **`src/tools/ecs/timeRange.ts`** (nouveau) — `15m` → `now-15m`, et le refus
  d'une valeur qui n'est ni l'un ni l'autre. Isolé parce que les quatre outils le
  partagent et que c'est la seule logique de ce module qui mérite ses propres
  tests.
- **`src/tools/ecs/logQuery.ts`** (nouveau, non prévu au spec initial) — le
  `bool.filter` que les quatre outils partagent, et la description de ce qui a
  réellement été filtré. Extrait pour la raison de `mappingFields.ts` : quatre
  copies de la même construction est là où elles commencent à diverger.
- **`src/tools/ecs/searchLogs.ts`**, **`logHistogram.ts`**,
  **`errorSummary.ts`**, **`topValues.ts`** (nouveaux) — un fichier par
  capacité, comme le reste de `src/tools/`.
- **`src/register/ecsTools.ts`** (nouveau) — le quatrième point
  d'enregistrement, avec `clientRunner` comme les trois autres.
- **`src/config/schema.ts`** — `ecsTools: boolean` et `ecsIndexPattern: string`,
  plus un `.refine()` : le motif est requis dès que le drapeau est levé.
- **`src/server.ts`** — enregistre le jeu quand il est actif, et l'annonce sur
  stderr avec le motif visé, pour qu'un opérateur voie ce que le module
  interroge sans appeler un outil.
- **`scripts/check-mcp-tools.mjs`** — la liste attendue passe de 15 à 17
  (`field_caps` et `analyze`, voir plus bas), et reste la seule assertion qui
  prouve que les quatre outils ECS sont bien *absents* quand ils ne sont pas
  demandés. C'est la moitié utile du contrôle : elle échoue si un outil fuit
  dans un déploiement par défaut.

### Les quatre outils

`search_logs` — `service`, `levels`, `since`, `until`, `query` (texte libre sur
`message` et `error.message`), `host`, `logger`, `traceId`, `limit`. Un
`bool.filter` avec un `range` sur `@timestamp` et des `terms` sur les keyword,
trié `@timestamp` décroissant, `_source` restreint. Rendu en lignes
`2026-08-25T10:00:00Z  ERROR  billing  srv-3  message…`, la trace d'erreur en
détail budgété.

`log_histogram` — `date_histogram` sur `@timestamp`, intervalle explicite ou
déduit de la fenêtre, ventilation optionnelle par `service.name` ou `log.level`.
Répond à « depuis quand » et « est-ce encore en cours » pour quelques centaines
d'octets.

`error_summary` — `terms` sur `error.type`, avec `min`/`max` sur `@timestamp` par
groupe et un exemple de message par `top_hits` de taille 1. Le décompte, la
première et la dernière occurrence, et de quoi reconnaître l'erreur.

`top_values` — `terms` sur un champ ECS `keyword` au choix, sur la même fenêtre
et les mêmes filtres. Sert aussi à découvrir le vocabulaire réel du cluster,
`log.level` compris.

### Aussi dans la 0.3.0

Deux outils du thème « couverture ES », parce qu'ils servent directement ce
module. Ils vont dans le **jeu de données**, pas dans le jeu de diagnostic :
`get_mappings` y est déjà, et `field_caps` répond à la même question à l'échelle
d'un motif d'index — les séparer serait la même incohérence que celle qui a fait
déplacer `delete_index_template`. Le prix est assumé : le jeu par défaut passe de
15 à 17 outils, donc tous les déploiements paient leur schéma, module ECS ou
non.



- **`field_caps`** — quels champs existent sur un motif d'index, et de quel type.
  C'est la réponse à la limite documentée de `get_mappings`, qui exige un index
  concret : sur 365 index quotidiens, la question « ce champ existe-t-il, et
  est-il agrégeable » n'avait pas d'outil.
- **`analyze`** — `_analyze`, c'est-à-dire « pourquoi ma requête ne matche pas ».
  La question qui suit immédiatement une recherche de logs infructueuse.

### Vérification

- Tests par outil, avec le mock, assertant **le DSL qui part sur le fil** :
  forme du `bool.filter`, `range` sur `@timestamp`, `terms` sur `log.level`,
  ordre du tri, `_source` restreint, intervalle du `date_histogram`. C'est le
  point de ce dépôt : le mock intercepte au niveau connexion, donc un DSL mal
  imbriqué échoue au lieu d'être accepté en silence.
- `test/ecsTimeRange.test.ts` — `15m`, `2h`, `7d`, `now-1d`, une date ISO
  absolue, et une valeur absurde qui doit être refusée.
- `test/outputScale.test.ts` — une fixture de 500 événements ECS réalistes
  (message, `error.stack_trace`, `labels`) et le plafond sur `search_logs`.
- Gating : absent par défaut, présent avec le drapeau, et le refus au démarrage
  quand `ES_ECS_INDEX_PATTERN` manque. `test/server.test.ts` gagne une liste
  `ECS_TOOLS` de quatre noms et deux entrées dans `DATA_TOOLS` ; les six outils
  entrent au tableau `TOOLS` de `test/toolContract.test.ts`, qui vérifie qu'aucun
  ne lève d'exception.
- Le coût du `tools/list`, **mesuré** : 13 186 octets pour les 17 outils par
  défaut, 21 553 pour les 21 avec le jeu ECS. Le module coûte donc **8 367
  octets** par session, dont environ 7 200 de schémas — c'est-à-dire plus que
  tout le jeu par défaut. L'essentiel est structurel : dix filtres décrits une
  fois par outil. Une passe de raccourcissement des descriptions répétées en a
  repris 724 ; le reste ne se récupère qu'en supprimant des paramètres. C'est
  précisément le chiffre qui justifie le drapeau : un déploiement dont les logs
  ne sont pas en ECS ne paie rien.

### Documentation

`README.md` (une section sur le module et ses quatre outils, le tableau de
configuration), `smithery.yaml`, `Dockerfile`, `CLAUDE.md` (le tableau des jeux
d'outils gagne une ligne, et la contrainte de types ECS 1.x est à consigner là
où un futur lecteur la cherchera).

## Hors périmètre, délibérément

- **Les *resources* et la capacité `logging` de MCP**, l'ILM (`_ilm/explain`) et
  les diagnostics de nœud (`_cat/recovery`, `hot_threads`) : reportés en 0.4.0.
  Trois thèmes dans une release donnent un spec qu'on ne relit pas.
- **Les types ECS 8.x** (`match_only_text`, `wildcard`) : hors de portée d'un
  cluster 7.8. À rouvrir le jour où le cluster bouge, pas avant.
- **Toute écriture sur les logs.** Le module est en lecture seule, et ses outils
  seront annotés `readOnlyHint`.
- **Un paramètre de DSL libre.** `search` le fait déjà.

## Ce que l'implémentation a corrigé du design

Deux points que seule la mesure a fait apparaître :

- **`log_histogram` regroupe ses lignes cinquante par fragment.** Un fragment par
  bucket paraissait bon — c'est la règle « le détail est découpé, jamais d'un
  bloc » — mais le nombre de buckets n'est pas borné (1 minute sur 30 jours en
  fait 43 200) et chaque fragment porte son propre enrobage sur le fil. Le
  résultat dépassait le budget du nombre de ses propres fragments. Cinquante,
  comme `chunkedJson`, pour la même raison.
- **La détection du refus « fielddata » lit le corps de l'erreur, pas seulement
  son message.** `ResponseError.message` ne contient que le *type* de l'erreur à
  moins que `root_cause` ne soit un tableau (vérifié dans `lib/errors.js:93-104`),
  et la phrase qui nomme fielddata est dans la cause racine.

## Interaction connue

`search` et `search_logs` se recouvrent, volontairement : le premier reste pour
un DSL arbitraire sur n'importe quel index, le second pour la question courante
sur un schéma connu. Les deux descriptions doivent le dire, sans quoi un modèle
choisira au hasard — et le coût d'un mauvais choix n'est pas symétrique : `search`
sur un index de logs redemande le mapping et rapatrie tout le `_source`.
