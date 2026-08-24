# Authentification OAuth2 (client_credentials) — design

Date : 2026-08-24
Statut : proposé, en attente de relecture
Conformité : audité contre MCP 2025-06-18 et 2025-11-25, OAuth 2.1 et RFC 9700
Version cible : 0.2.0

## Problème

Le serveur sait s'authentifier par clé d'API (`ES_API_KEY`) ou par login/mot de
passe (`ES_USERNAME`/`ES_PASSWORD`). Un déploiement d'entreprise impose un
troisième facteur : un jeton OAuth2 obtenu auprès d'un fournisseur d'identité
(Keycloak, Azure AD, Ping), présenté en `Authorization: Bearer …`.

Une contrainte de version cadre tout le reste, et il faut la dire avant le
design : **un cluster 7.x ne sait pas valider lui-même un jeton d'un IdP tiers.**
Le realm JWT n'existe qu'à partir de 8.2, et le realm OIDC de 7.x est une
licence platinum dont le flux est celui du navigateur — inutilisable depuis un
serveur stdio lancé par un client MCP. Le montage retenu est donc celui d'une
**passerelle devant Elasticsearch** qui valide l'OAuth2 et relaie la requête.

Ce que le serveur doit faire se réduit alors à trois choses : obtenir un jeton
par `client_credentials`, le garder frais, et le présenter à chaque requête.

## Décisions

| Décision | Choix | Raison |
|---|---|---|
| Flux | `client_credentials` uniquement | Le seul flux non interactif ; un serveur stdio n'a ni navigateur ni utilisateur devant lui |
| Point d'injection | `base.child({ auth: { bearer } })`, mémoïsé par jeton | Le pool de connexions **et** le *product check* sont partagés (vérifié ci-dessous) : une rotation de jeton ne coûte aucun aller-retour réseau |
| Acquisition | Paresseuse, au premier appel d'outil | Une panne passagère de l'IdP ne doit pas empêcher la session de démarrer ; l'erreur devient un fragment `Error:` diagnosticable au lieu d'un « MCP server failed » muet |
| Renouvellement | Proactif, à `min(60 s, expires_in / 2)` avant l'expiration | Le second terme est ce qui évite qu'un jeton de 30 s soit considéré expiré en permanence |
| `expires_in` absent | Traité comme 300 s, signalé une fois sur stderr | La RFC le *recommande* sans l'exiger. Supposer une durée courte fait redemander un jeton plus souvent que nécessaire ; supposer une durée longue fait servir un jeton mort |
| `token_type` inattendu | Erreur explicite si présent et différent de `bearer` | Envoyer `Bearer` sur un jeton qui n'en est pas produirait un 401 dont la cause serait invisible |
| Échec d'obtention | Remonté comme résultat d'outil `isError`, jamais comme exception | Le contrat du dépôt : une panne doit atteindre le modèle en contenu lisible. Voir le point d'attention ci-dessous, c'est ce qui dicte la forme des handlers |
| Concurrence | *Single-flight* : la requête en vol est partagée | Sans ça, N appels d'outils simultanés déclenchent N échanges de jeton à l'expiration |
| `refresh_token` | Aucun ; renouveler = redemander | RFC 6749 §4.4.3 : `client_credentials` ne doit pas renvoyer de `refresh_token`. C'est ce qui garde le composant sans état à persister |
| Précédence | OAuth2 > clé d'API > basic | OAuth2 est le facteur le plus explicite : trois variables délibérées contre une |
| Client de base quand OAuth2 est actif | **Aucune** option `auth` | Propriété de sûreté : si le chemin OAuth2 échoue, la requête part sans identité et reçoit un 401, au lieu de repartir silencieusement sous l'identité de la clé d'API |
| Configuration partielle | **Fatale au démarrage** | Une URL de jeton sans secret ne doit pas retomber sur un autre facteur. Un `ES_MAX_RETRIES` malformé a un repli sain ; une authentification à moitié configurée qui change d'identité n'en a pas |
| Authentification cliente | `client_secret_post` par défaut, `client_secret_basic` au choix | Keycloak, Azure AD, Auth0 et Ping acceptent tous `post` ; `basic` existe pour les IdP qui refusent l'un des deux |
| Secret | `ES_OAUTH_CLIENT_SECRET` ou `..._FILE` | Un secret monté en fichier n'apparaît pas dans `docker inspect` ni dans l'environnement du processus |
| Repli non préfixé | Aucun | Un `CLIENT_SECRET` ambiant qui déciderait de l'identité du serveur est le danger de `USERNAME` documenté dans `CLAUDE.md`, en pire |
| `ES_OAUTH_TOKEN_URL` | **HTTPS exigé**, `http://` toléré uniquement sur boucle locale | OAuth 2.1 §1.5 et MCP : « All authorization server endpoints **MUST** be served over HTTPS ». Ici le risque n'est pas le SSRF — l'URL vient de l'opérateur, pas d'une source hostile — c'est le `client_secret` qui traverserait le réseau en clair. Pas de drapeau de contournement : la boucle locale suffit aux tests, et un `ES_OAUTH_INSECURE` finirait en production |
| Diagnostic sur 401/403 | Lire `WWW-Authenticate` et rapporter `error` et `scope` | C'est la forme que la révision 2025-11-25 normalise : `403` + `error="insufficient_scope"` + `scope="…"`. Transformer « 403 Forbidden » en « la passerelle veut `es:write`, `ES_OAUTH_SCOPE` porte `es:read` » est plus utile qu'un rejeu, et c'est ce qui remplace le rejeu écarté |
| Fin de ligne du secret | Toujours `.trim()`, source fichier comprise, et vide = refus | Un secret collé dans une configuration traîne une fin de ligne — la documentation de Claude Code avertit explicitement de ce cas — et un fichier écrit avec `echo` en contient toujours une. Non coupée, elle produit un `invalid_client` opaque |
| Rejeu sur 401 | Hors périmètre 0.2.0 | Avec un renouvellement proactif, un 401 signifie jeton révoqué, dérive d'horloge > 60 s, ou mauvais `scope`/`audience` — trois cas qu'un rejeu ne corrige pas. Le diagnostic `WWW-Authenticate` ci-dessus est le remplacement utile |
| Transport HTTP | `fetch` global + `AbortSignal.timeout(10 s)` | Aucune dépendance nouvelle ; les deux sont natifs sur le Node 24 du `.nvmrc` |

Options écartées pour le point d'injection, parce que c'est là que le design se
joue :

- **Reconstruire le `Client` à chaque rotation.** Marche, mais perd le pool
  keep-alive, refait le *product check*, et surtout impose de faire circuler un
  fournisseur de client à la place d'un `Client` dans les trois modules
  d'enregistrement pour un bénéfice nul face à `child()`.
- **Un Proxy qui injecte l'en-tête par requête.** Le jeton n'est pas disponible
  de façon synchrone, alors que les méthodes du client 7.x renvoient
  synchroniquement une promesse annulable : il faudrait fabriquer une
  annulabilité différée. Complexité réelle pour reproduire ce que `child()` fait
  déjà.
- **Muter `opts.headers` après construction.** Ne fonctionne pas : `Transport`
  **copie** l'objet à la construction (vérifié ci-dessous).

## Faits vérifiés dans `@elastic/elasticsearch@7.17.14`

Constatés en lisant le paquet installé, non de mémoire. Les numéros de ligne sont
ceux de la version épinglée.

- `ClientOptions.auth` accepte `BearerAuth = { bearer: string }`
  (`lib/pool/index.d.ts:65`), et `Connection.js:369` en fait
  `authorization: Bearer <jeton>`.
- `Client.child(opts)` (`index.js:260`) : fusionne les options sur les initiales,
  partage `connectionPool` et `serializer` (`index.js:265`), **et recopie le
  symbole du *product check*** (`index.js:278-280`) — un enfant ne refait donc
  pas le `GET /`. C'est ce fait qui rend une rotation gratuite.
- `child()` transforme `auth` en en-tête dès la construction :
  `options.headers = prepareHeaders(options.headers, options.auth)`
  (`index.js:272-274`).
- Précédence des en-têtes, dans le bon sens pour nous :
  `Transport.js:390` fait `Object.assign({}, this.headers, options.headers)`,
  puis `Connection.js:261` fait
  `Object.assign({}, request.headers, params.headers)` — l'en-tête porté par
  l'enfant l'emporte sur celui de la connexion partagée. Un enfant *bearer*
  fonctionne donc même si le parent porte une clé d'API.
- `prepareHeaders` (`Connection.js:360`) ne pose l'en-tête d'authentification que
  si `headers.authorization == null` : un en-tête explicite gagne toujours.
- `Transport` **copie** `opts.headers` à la construction
  (`Transport.js:64`, `Object.assign({}, …, lowerCaseHeaders(opts.headers))`) :
  muter l'objet passé à l'appelant n'a aucun effet.
- `client.security.getToken` existe (`api/api/security.js:728`), donc le service
  de jetons d'Elasticsearch serait atteignable — c'est une option écartée, pas
  une option absente.
- Node 24 : `fetch` et `AbortSignal.timeout` sont natifs (vérifié à l'exécution).

## Conformité à la spécification MCP

Vérifié sur les pages de la spécification, révisions 2025-06-18 **et** 2025-11-25 :
le texte des deux clauses ci-dessous est identique mot pour mot dans les deux.

- **La spécification d'autorisation MCP ne s'applique pas à ce serveur, et le dit
  elle-même** : « Implementations using an STDIO transport **SHOULD NOT** follow
  this specification, and instead retrieve credentials from the environment. »
  Tout l'appareil OAuth de MCP — PKCE, RFC 8707 `resource`, RFC 9728 *protected
  resource metadata*, enregistrement dynamique — concerne l'axe **client MCP →
  serveur MCP** sur transport HTTP. Notre axe est l'autre : **serveur MCP →
  API amont**. Lire les variables d'environnement est donc littéralement ce que
  la spécification prescrit, pas un contournement.
- **Le rôle de client OAuth vers l'amont est explicitement prévu** : « If the MCP
  server makes requests to upstream APIs, it may act as an OAuth client to them.
  The access token used at the upstream API is a separate token, issued by the
  upstream authorization server. The MCP server **MUST NOT** pass through the
  token it received from the MCP client. » C'est exactement ce design, et le
  `MUST NOT` est satisfait par construction : un serveur stdio ne reçoit aucun
  jeton de son client. Noté ici pour qu'une évolution future ne « améliore » pas
  ce point en relayant un jeton d'appelant — ce serait l'anti-patron *token
  passthrough*, explicitement interdit.
- **Vol de jeton** : « tokens cached or logged on the server can access protected
  resources ». D'où la règle : le jeton vit **en mémoire seulement**, n'est jamais
  écrit sur disque, jamais journalisé, jamais renvoyé dans un résultat d'outil.
- **En-tête, jamais l'URL** : OAuth 2.1 §5.1.1 et RFC 9700 (« Clients **MUST
  NOT** pass access tokens in a URI query parameter »). `child({ auth: { bearer } })`
  produit un en-tête `Authorization`, donc satisfait par construction.
- **RFC 9700 §2.4 sur le grant *resource owner password credentials* : « MUST NOT
  be used ».** Cela donne une raison normative, et non une préférence, à l'écart
  du service de jetons d'Elasticsearch (`/_security/oauth2/token`, grant
  `password`) listé hors périmètre : sa forme est celle du grant que le BCP
  interdit.
- **RFC 9700 sur l'authentification cliente** : « It is RECOMMENDED to use
  asymmetric cryptography for client authentication, such as mutual TLS for OAuth
  2.0 or signed JWTs. » Le BCP ne déprécie pas `client_secret_post` ni
  `client_secret_basic`, mais recommande mieux. `private_key_jwt` et mTLS restent
  hors périmètre 0.2.0, et c'est désormais un écart nommé plutôt qu'un oubli.
- **Minimisation des portées** (section *Scope Minimization* du document de bonnes
  pratiques) : éviter les portées fourre-tout, demander le minimum. Conséquence
  concrète ici, à documenter plutôt qu'à coder : **la portée OAuth et le gating
  des jeux d'outils doivent s'accorder.** Un déploiement sans
  `ES_ALLOW_DESTRUCTIVE` devrait demander une portée en lecture seule ; demander
  une portée d'écriture pour un serveur dont les outils d'écriture ne sont pas
  enregistrés élargit le rayon de souffle du secret sans rien apporter.

Rien dans la révision 2025-11-25 ne change ce design. Elle ajoute les *Client ID
Metadata Documents*, la stratégie de sélection des portées et le flux de montée
en portée — tous sur l'axe client MCP → serveur MCP. `CLAUDE.md` devrait
toutefois cesser d'écrire « audité contre 2025-06-18 » sans dire que la révision
suivante a été relue.

## Portée des modifications

### Code

- **`src/auth/oauth2.ts`** (nouveau) — le fournisseur de jetons.
  `createTokenProvider(config)` renvoie `{ access(): Promise<string> }`. Contient
  le cache, le *single-flight*, le calcul d'expiration, la construction de la
  requête selon `authStyle`, et la traduction d'une réponse d'erreur en message.
  Ne connaît ni Elasticsearch ni MCP.

  La traduction d'erreur ne recopie **jamais** le corps de la réponse : elle en
  extrait les seuls champs que la RFC 6749 §5.2 définit — `error` et
  `error_description` — plus le code HTTP. Un IdP qui répercute les paramètres
  reçus dans son message d'erreur ferait autrement remonter le `client_secret`
  jusque dans un résultat d'outil, c'est-à-dire dans le contexte du modèle.
- **`src/auth/clientSource.ts`** (nouveau) — `ClientSource = () => Promise<Client>`.
  Sans OAuth2 : renvoie le client de base. Avec : mémoïse
  `base.child({ auth: { bearer } })` par chaîne de jeton, de sorte qu'un enfant
  n'est créé qu'à la rotation.
- **`src/config/schema.ts`** — un bloc `oauth` dans `ConfigSchema`, un `.refine()`
  qui rend la configuration partielle fatale, la lecture des variables dans
  `loadConfigFromEnv()`, et `createClientOptions` qui **omet `auth`** quand
  OAuth2 est configuré. Le `.refine()` se déclenche au `ConfigSchema.parse()` de
  `createElasticsearchMcpServer`, donc au démarrage, et sort par le `catch` de
  `main()` en `Server error: …` — le chemin qu'un `ES_HOST` absent emprunte déjà.

  C'est aussi ici que le secret est coupé : `.trim()` sur les deux sources, et un
  résultat vide est traité comme une configuration partielle, donc fatal. Le
  schéma valide en plus que `ES_OAUTH_TOKEN_URL` est en `https://`, la boucle
  locale exceptée.
- **`src/toolResult.ts`** — `toolError` enrichit un échec portant un 401 ou un
  403 avec ce que dit son en-tête `WWW-Authenticate` : `error` et `scope`, et rien
  d'autre.

  C'est le bon endroit, et pas par commodité : `toolError` est déjà le seul
  module qui décide ce qu'une erreur laisse passer vers le modèle — il ne
  transmet que `error.message`, jamais l'objet d'erreur, précisément parce que le
  `meta` d'une erreur du client Elasticsearch contient l'URL du nœud, laquelle
  peut porter des identifiants en clair. La même contrainte s'applique à ce que
  l'on ajoute : deux champs nommés, extraits de l'en-tête, jamais l'ensemble des
  en-têtes.

  Noter que ce chemin est distinct de celui de l'échec d'obtention, et les deux
  doivent rester séparés : un jeton qu'on n'a pas pu obtenir remonte par
  `withClient` avant que l'outil ne s'exécute ; un jeton obtenu mais refusé par
  la passerelle remonte par le `catch` de l'outil lui-même. Le premier dit « l'IdP
  n'a pas répondu », le second « la passerelle veut une autre portée ». Les
  confondre produirait le message trompeur dans les deux sens.
- **`src/server.ts`** — construit le `ClientSource`, le passe aux trois modules
  d'enregistrement, et ajoute une ligne stderr `Auth: …` nommant le facteur
  retenu et le point de terminaison, sans secret. Émet un avertissement si
  `ES_API_KEY` ou `ES_USERNAME` traînent alors qu'OAuth2 gagne : une précédence
  silencieuse est la façon dont on expédie la mauvaise identité en production.
- **`src/register/*.ts`** — **Changement de surface mineur** : la signature passe
  de `(server, esClient: Client)` à `(server, source: ClientSource)`. Aucune
  signature d'outil ne change, et c'est le point : le facteur d'authentification
  appartient au client qu'on remet à l'outil, pas à sa liste d'arguments — le
  même raisonnement que pour l'annulation (`src/cancellable.ts`).

  Le helper `es(extra)` ne peut pas devenir `await source()` tel quel, et c'est
  le seul piège réel de ce design : `es()` est appelé **dans le handler, hors du
  `try` de l'outil**. Un rejet d'obtention de jeton y remonterait au SDK, qui en
  ferait une erreur de protocole — précisément ce que tout le dépôt évite. Les
  handlers passent donc par un helper partagé :

  ```ts
  withClient(extra, (es) => search(es, index, queryBody))
  ```

  `withClient` obtient le client, applique `withCancellation`, et traduit un
  échec d'obtention en `toolError("OAuth2 token request failed", …)` — le seul
  endroit du dépôt où une erreur d'authentification est mise en forme. Vingt-six
  handlers changent d'une ligne chacun, mécaniquement.
- **Bump de version** : `package.json` **et** la version codée en dur du
  `McpServer` dans `src/server.ts`, sous peine d'échec de la garde de release.

### Variables de configuration

| Variable | Rôle |
|---|---|
| `ES_OAUTH_TOKEN_URL` | Point de terminaison du jeton. Sa présence **active** le facteur. HTTPS exigé, sauf boucle locale |
| `ES_OAUTH_CLIENT_ID` | Identifiant client. Requis |
| `ES_OAUTH_CLIENT_SECRET` | Secret client. Requis, sauf via le fichier ci-dessous |
| `ES_OAUTH_CLIENT_SECRET_FILE` | Chemin d'un fichier contenant le secret |
| `ES_OAUTH_SCOPE` | `scope` optionnel (Azure AD attend `api://…/.default`) |
| `ES_OAUTH_AUDIENCE` | `audience` optionnelle (Auth0 la demande pour émettre un JWT) |
| `ES_OAUTH_AUTH_STYLE` | `post` (défaut) ou `basic` |

### Vérification

- `test/oauth2.test.ts` — le fournisseur, avec `fetch` bouchonné : cache,
  *single-flight* (deux appels concurrents ⇒ une seule requête), marge
  d'expiration y compris le cas `expires_in: 30`, les deux styles
  d'authentification cliente, et **l'absence du secret comme du jeton dans tout
  message d'erreur**. Chaque assertion nouvelle est vérifiée par mutation, comme
  le reste du dépôt.
- `test/clientSource.test.ts` — même enfant tant que le jeton vaut, enfant
  différent après rotation, et un client de base intact sans OAuth2.
- `test/config.test.ts` — précédence des trois facteurs, caractère fatal de la
  configuration partielle, lecture du secret par fichier, absence de repli non
  préfixé, **refus d'un `ES_OAUTH_TOKEN_URL` en `http://` non local**, et secret
  débarrassé de sa fin de ligne depuis les deux sources.
- `test/toolContract.test.ts` — le diagnostic, là où vit déjà le contrat de
  `toolResult` : une erreur portant
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="es:write"` doit
  produire un message nommant la portée manquante, et **rien du reste des
  en-têtes**. C'est ce qui justifie de n'avoir pas implémenté le rejeu, donc
  l'assertion qui doit tenir pour que cet écart reste défendable.
- Un test de session MCP réelle : OAuth2 configuré vers un point de terminaison
  injoignable, un appel d'outil, et le résultat doit être un `isError` portant le
  message d'obtention — pas une exception de protocole. C'est l'assertion qui
  garde le piège des handlers fermé.
- La suite existante doit passer inchangée : `test/server.test.ts` n'a pas
  d'OAuth2 configuré, donc le `ClientSource` y est le chemin trivial.
- `scripts/smoke.mjs` — obtient le client via le `ClientSource` au lieu de
  `new Client(...)`, ce qui fait du smoke la seule vérification du facteur contre
  un vrai IdP.

### Documentation

`README.md` (tableau de configuration, une section sur le montage avec
passerelle et la contrainte 7.x), `smithery.yaml` (les sept clés camelCase),
`Dockerfile` (les variables d'environnement, vides), et `CLAUDE.md` (précédence,
point d'injection, le fait que le *product check* est partagé, et la révision de
spécification réellement relue).

Deux points appartiennent à la documentation et non au code, et ils comptent
autant :

- **Le secret n'a pas sa place dans un `.mcp.json`.** Un `.mcp.json` de portée
  projet est versionné. Trois façons supportées de l'éviter, à montrer dans le
  README : l'expansion `"ES_OAUTH_CLIENT_SECRET": "${ES_OAUTH_CLIENT_SECRET}"`
  (Claude Code substitue `${VAR}` et `${VAR:-défaut}` dans `command`, `args` et
  `env` d'un serveur stdio), la portée locale dans `~/.claude.json` — que la
  documentation recommande explicitement « for servers with credentials you don't
  want in version control » — ou `ES_OAUTH_CLIENT_SECRET_FILE` vers un fichier
  monté.
- **Accorder la portée OAuth et le jeu d'outils.** Une portée en lecture seule
  pour un déploiement sans `ES_ALLOW_DESTRUCTIVE`, une portée d'écriture
  seulement là où les outils d'écriture sont réellement enregistrés.

## Hors périmètre, délibérément

- **Le service de jetons d'Elasticsearch** (`POST /_security/oauth2/token`,
  grant `password`). Atteignable — `client.security.getToken` existe — mais deux
  raisons l'écartent, et la seconde n'est pas une préférence : ce n'est pas le
  montage retenu, et sa forme est celle du grant *resource owner password
  credentials* que RFC 9700 §2.4 interdit (« MUST NOT be used »).
- **Un jeton *bearer* statique** (`ES_BEARER_TOKEN`). Sous-ensemble trivial du
  flux retenu, non demandé.
- **Les flux `authorization_code` et `device_code`.** Ils supposent un
  navigateur et un utilisateur ; un serveur stdio n'a ni l'un ni l'autre.
- **mTLS et le `private_key_jwt`** comme authentification cliente — écart nommé
  par rapport à la recommandation de RFC 9700, pas un oubli.
- **Le rejeu sur 401** et la révocation du jeton à l'extinction.

## Sources auditées

Listées pour que l'audit se relance au lieu de se refaire — c'est la même raison
qui fait vivre `scripts/measure-output.mjs` dans le dépôt. Les citations du
présent document viennent de ces pages, relues le 2026-08-24.

| Source | Ce qui en a été retenu |
|---|---|
| [MCP — Authorization, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | La clause stdio, le rôle de client OAuth vers l'amont, HTTPS obligatoire, vol de jeton |
| [MCP — Authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Les deux mêmes clauses, mot pour mot ; la forme `403` + `insufficient_scope` + `scope` |
| [MCP — Security Best Practices](https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices) | *Token passthrough*, minimisation des portées, exigence HTTPS hors boucle locale |
| [RFC 9700 — OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html) | Le grant *password* « MUST NOT be used » ; asymétrique recommandé pour l'authentification cliente ; jamais de jeton en paramètre d'URL |
| [RFC 6749 §4.4.3 et §5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4.3) | Pas de `refresh_token` en `client_credentials` ; les champs d'une réponse d'erreur |
| [Claude Code — MCP](https://code.claude.com/docs/en/mcp) | L'expansion `${VAR}` dans `env`, la portée locale pour les identifiants, l'avertissement sur les fins de ligne collées |

## Interaction connue, acceptée

Le cache de mapping de `search` est indexé sur l'identité du client
(`unwrapClient`, `src/cancellable.ts`). Un enfant par jeton signifie qu'à chaque
rotation ce cache repart froid : une requête `_mapping` par index, toutes les
quelques dizaines de minutes. C'est accepté et noté ici pour que le prochain
lecteur sache que ce n'était pas un oubli — introduire une seconde notion
d'identité « grappe » pour faire survivre un cache reviendrait à payer de la
complexité pour une erreur d'arrondi.
