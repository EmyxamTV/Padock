# Installer Padock avec Dokploy et des sous-domaines Minecraft

Ce guide décrit une installation complète sur un serveur Linux : Dokploy, Padock, PostgreSQL, l’agent Docker et Gate Lite. À la fin, le panel sera accessible avec une adresse HTTPS telle que `https://panel.example.com` et les joueurs pourront rejoindre un serveur avec `survie.mc.example.com`, sans écrire de port.

Ce guide correspond au dépôt [`EmyxamTV/Padock`](https://github.com/EmyxamTV/Padock), branche `main`, et au fichier `compose.dokploy.yaml`. Il couvre une installation neuve sur un seul serveur Dokploy. Remplacez partout `example.com`, `203.0.113.10` et les valeurs commençant par `REMPLACER_` par vos propres informations.

## Résultat attendu

À la fin de l’installation :

- `https://panel.example.com` ouvre Padock avec un certificat HTTPS valide ;
- PostgreSQL conserve les comptes, rôles, nœuds, tâches et configurations ;
- l’agent crée et contrôle les conteneurs Minecraft sur le serveur Linux ;
- les joueurs rejoignent `nom-du-serveur.mc.example.com` sur le port standard `25565` ;
- les ports internes des serveurs Minecraft restent inaccessibles depuis Internet ;
- le SFTP est disponible sur le port `2022` si vous l’ouvrez ;
- les modpacks CurseForge possédant un server pack peuvent être installés automatiquement.

## 1. Architecture utilisée

```text
Navigateur ── HTTPS ──► Dokploy / Traefik ──► Padock:3000

Joueur ── survie.mc.example.com:25565 ──► Gate Lite
                                              └──► 127.0.0.1:25566 ──► serveur Survie
Joueur ── creatif.mc.example.com:25565 ─► Gate Lite
                                              └──► 127.0.0.1:25567 ──► serveur Créatif
```

Dokploy gère le domaine HTTPS du panel. Ses domaines sont des routes HTTP Traefik et ne peuvent pas sélectionner un serveur Minecraft à partir du nom saisi par le joueur. Gate Lite assure donc le routage Minecraft sur le port standard `25565`.

Un seul enregistrement DNS wildcard est nécessaire. Padock ajoute et retire ensuite les routes Gate automatiquement lors de la création, de la modification ou de la suppression d’un serveur.

## 2. Prérequis

Préparez :

- un VPS ou serveur dédié Linux avec une adresse IP publique fixe ;
- Ubuntu 22.04/24.04 ou Debian 11/12 de préférence ;
- un accès SSH avec `root` ou `sudo` ;
- un nom de domaine dont vous pouvez modifier la zone DNS ;
- le code Padock dans un dépôt Git accessible à Dokploy ;
- au minimum 2 Go de RAM et 30 Go de disque pour Dokploy seul ;
- pour Padock et Minecraft, 8 Go de RAM minimum sont conseillés, et 16 Go ou plus pour plusieurs serveurs ou de gros modpacks.

Les ports suivants doivent être disponibles :

| Port | Protocole | Usage |
|---:|:---:|---|
| 22 | TCP | SSH |
| 80 | TCP | HTTP et validation Let's Encrypt |
| 443 | TCP | HTTPS du panel |
| 3000 | TCP | interface d'administration Dokploy lors de l'installation |
| 25565 | TCP | passerelle Minecraft Gate |
| 2022 | TCP | SFTP Padock, facultatif |

N’ouvrez pas les ports internes `25566`, `25567`, etc. Ils sont liés à `127.0.0.1` et restent accessibles uniquement par Gate.

Avant d’installer Dokploy, vérifiez que `80`, `443` et `3000` ne sont pas déjà utilisés :

```bash
sudo ss -ltnp | grep -E ':(80|443|3000)\b' || true
```

## 3. Préparer le DNS

Dans la zone DNS de votre domaine, ajoutez :

| Type | Nom | Valeur | Proxy CDN |
|:---:|---|---|---|
| A | `panel` | `IP_DU_SERVEUR` | possible |
| A | `*.mc` | `IP_DU_SERVEUR` | désactivé / DNS uniquement |
| A | `sftp` | `IP_DU_SERVEUR` | désactivé / DNS uniquement, facultatif |

Avec le domaine `example.com`, cela donne :

```text
panel.example.com   A   203.0.113.10
*.mc.example.com    A   203.0.113.10
sftp.example.com    A   203.0.113.10
```

Si vous utilisez Cloudflare, laissez impérativement le nuage gris, mode **DNS only**, sur `*.mc`. Le proxy Web Cloudflare standard ne transporte pas le protocole Minecraft TCP.

Vous n’avez pas besoin d’enregistrement SRV : Gate écoute sur le port Minecraft standard `25565`. Le wildcard couvre automatiquement `survie.mc.example.com`, `modde.mc.example.com` et tous les futurs serveurs.

Vérifiez la résolution depuis votre PC :

```bash
nslookup panel.example.com
nslookup test.mc.example.com
```

Les deux noms doivent retourner l’adresse IP publique du serveur.

L’enregistrement `sftp.example.com` n’est nécessaire que si vous souhaitez utiliser ce nom dans les clients SFTP. Vous pouvez aussi utiliser `panel.example.com` comme hôte SFTP, car il pointe vers la même machine.

## 4. Installer Dokploy

Connectez-vous au serveur :

```bash
ssh root@IP_DU_SERVEUR
```

Installez Dokploy avec le script officiel :

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Le script installe également Docker s’il n’est pas déjà présent. Quand l’installation est terminée, ouvrez :

```text
http://IP_DU_SERVEUR:3000
```

Créez le compte administrateur Dokploy. Vous pourrez ensuite attribuer un domaine HTTPS à Dokploy lui-même et désactiver l’accès direct au port `3000` si vous le souhaitez.

Documentation officielle : [installation de Dokploy](https://docs.dokploy.com/docs/core/installation).

## 5. Configurer le pare-feu

Exemple avec UFW :

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 25565/tcp
sudo ufw allow 2022/tcp
sudo ufw enable
sudo ufw status
```

Le port `2022` peut être omis si vous ne voulez pas utiliser le SFTP. Le port `3000` peut être refermé après avoir configuré et vérifié un domaine HTTPS pour l’interface Dokploy.

Vérifiez aussi le pare-feu du fournisseur VPS, parfois séparé du pare-feu Linux.

## 6. Préparer les dossiers persistants

Padock utilise des volumes Docker pour PostgreSQL, les données du panel et la configuration Gate. Les mondes et sauvegardes Minecraft restent dans `/var/lib/padock` sur l’hôte afin que l’agent puisse les monter dans les conteneurs qu’il crée.

Sur le serveur :

```bash
sudo mkdir -p /var/lib/padock/servers
sudo mkdir -p /var/lib/padock/backups
sudo chown -R 1000:1000 /var/lib/padock
sudo chmod 750 /var/lib/padock
```

Ces dossiers ne doivent jamais être placés dans le répertoire cloné du dépôt, car Dokploy remplace ce répertoire pendant les redéploiements.

## 7. Créer l’application dans Dokploy

Dans Dokploy :

1. créez un **Project** nommé `Padock` ;
2. ajoutez un service **Docker Compose** et non un Docker Stack ;
3. sélectionnez GitHub ou le fournisseur **Git** ;
4. utilisez le dépôt `https://github.com/EmyxamTV/Padock.git` ;
5. choisissez la branche `main` ;
6. indiquez `./compose.dokploy.yaml` comme **Compose Path** ;
7. laissez Dokploy construire l’image depuis le dépôt ;
8. si le dépôt devient privé, configurez auparavant une GitHub App ou les identifiants Git dans Dokploy ;
9. n’ajoutez pas manuellement de `container_name` ni de labels Traefik au fichier Compose ;
10. enregistrez sans encore lancer le déploiement.

Le mode Docker Compose est nécessaire, notamment parce que cette installation construit l’image depuis le dépôt et utilise le réseau hôte Linux pour Gate.

Fichiers utiles du dépôt :

- [`compose.dokploy.yaml`](compose.dokploy.yaml) : stack de production ;
- [`.env.dokploy.example`](.env.dokploy.example) : modèle des variables ;
- [`README.md`](README.md) : fonctions générales du panel.

Documentation officielle : [Docker Compose dans Dokploy](https://docs.dokploy.com/docs/core/docker-compose).

Après avoir ajouté les variables de la section suivante, utilisez **Preview Compose**. Vérifiez que les quatre services `padock`, `agent`, `database` et `gate` apparaissent, puis confirmez que les valeurs secrètes ne sont pas affichées dans une capture d’écran ou un ticket public.

## 8. Générer les secrets

Sur votre PC Linux/macOS ou sur le serveur, générez quatre valeurs différentes :

```bash
openssl rand -hex 48
openssl rand -hex 48
openssl rand -hex 48
openssl rand -hex 32
```

Utilisez-les respectivement pour :

- `PADOCK_JWT_SECRET` ;
- `PADOCK_ENCRYPTION_KEY` ;
- `PADOCK_NODE_TOKEN` ;
- `PADOCK_DATABASE_PASSWORD`.

Ne réutilisez pas le même secret et ne publiez jamais ces valeurs dans Git.

Vous pouvez générer un bloc prêt à copier avec :

```bash
printf 'PADOCK_JWT_SECRET=%s\n' "$(openssl rand -hex 48)"
printf 'PADOCK_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 48)"
printf 'PADOCK_NODE_TOKEN=%s\n' "$(openssl rand -hex 48)"
printf 'PADOCK_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
```

Conservez une copie chiffrée de `PADOCK_ENCRYPTION_KEY`. Cette clé sert à relire les jetons de nœuds et les secrets TOTP existants après une restauration.

Récupérez aussi le groupe du socket Docker :

```bash
stat -c '%g' /var/run/docker.sock
```

La valeur retournée sera utilisée pour `DOCKER_GID`.

## 9. Ajouter les variables d’environnement

Dans l’onglet **Environment** du service Docker Compose Dokploy, collez puis adaptez :

```env
PADOCK_JWT_SECRET=REMPLACER_PAR_LE_PREMIER_SECRET
PADOCK_ENCRYPTION_KEY=REMPLACER_PAR_LE_DEUXIEME_SECRET
PADOCK_NODE_TOKEN=REMPLACER_PAR_LE_TROISIEME_SECRET
PADOCK_DATABASE_PASSWORD=REMPLACER_PAR_LE_SECRET_POSTGRESQL

PADOCK_PUBLIC_URL=https://panel.example.com
PADOCK_GATEWAY_DOMAIN=mc.example.com
PADOCK_GATEWAY_DNS_TARGET=203.0.113.10

PADOCK_SERVERS_DIR=/var/lib/padock/servers
PADOCK_BACKUPS_DIR=/var/lib/padock/backups

PADOCK_SFTP_PUBLIC_HOST=sftp.example.com
PADOCK_SFTP_PUBLIC_PORT=2022
PADOCK_MINECRAFT_IMAGE=itzg/minecraft-server:java25
DOCKER_GID=999

CURSEFORGE_API_KEY='VOTRE_CLE_CURSEFORGE'
```

Variables facultatives pour les fonctions de production :

```env
# Alertes Discord/webhook
PADOCK_ALERT_WEBHOOK=

# Vérification e-mail et mot de passe oublié
PADOCK_SMTP_HOST=smtp.example.com
PADOCK_SMTP_PORT=587
PADOCK_SMTP_USER=padock
PADOCK_SMTP_PASSWORD='MOT_DE_PASSE_SMTP'
PADOCK_SMTP_FROM='Padock <no-reply@example.com>'
PADOCK_SMTP_SECURE=false

# Sauvegardes S3 compatibles
PADOCK_S3_ENDPOINT=https://s3.example.com
PADOCK_S3_REGION=auto
PADOCK_S3_BUCKET=padock
PADOCK_S3_ACCESS_KEY=ACCESS_KEY
PADOCK_S3_SECRET_KEY='SECRET_KEY'
PADOCK_S3_PREFIX=padock/backups
PADOCK_S3_FORCE_PATH_STYLE=false
```

Laissez entièrement vides les blocs SMTP ou S3 si vous ne les utilisez pas. `PADOCK_ENCRYPTION_KEY` doit rester stable : le changer sans conserver l’ancienne valeur rendrait les jetons de nœuds et secrets TOTP existants illisibles.

Pour SMTP, utilisez généralement le port `587` avec `PADOCK_SMTP_SECURE=false`, ou le port `465` avec `PADOCK_SMTP_SECURE=true`, selon les indications de votre fournisseur. Pour Cloudflare R2, MinIO ou certains services S3 compatibles, l’endpoint est obligatoire ; avec AWS S3, il peut être laissé vide si la région et le bucket sont renseignés.

Remplacez :

- `example.com` par votre domaine ;
- `203.0.113.10` par l’IP publique du serveur ;
- `999` par le résultat de `stat -c '%g' /var/run/docker.sock` ;
- les quatre secrets par les valeurs générées ;
- la clé CurseForge, ou laissez `CURSEFORGE_API_KEY=''` pour désactiver le catalogue.

Ne terminez pas `PADOCK_PUBLIC_URL` par `/`. L’hôte SFTP doit être un nom DNS ou une IP joignable par les utilisateurs, sans `sftp://` et sans numéro de port.

`PADOCK_GATEWAY_DOMAIN` contient le domaine de base, sans `*.` et sans protocole. Utilisez donc `mc.example.com`, pas `*.mc.example.com` et pas `https://mc.example.com`.

Si la clé CurseForge contient `$`, `#`, `!` ou `&`, conservez les apostrophes simples. Elles empêchent l’interpréteur `.env` de modifier la clé.

Après avoir enregistré les variables, ouvrez de nouveau **Preview Compose** et contrôlez particulièrement :

- `padock` expose seulement le port interne `3000` à Traefik ;
- `agent` publie `2022:2022` ; si vous n’utilisez pas le SFTP, ne laissez pas le port `2022` ouvert dans les pare-feu ;
- `gate` utilise `network_mode: host` et écoute sur `25565` ;
- `database` ne publie aucun port PostgreSQL sur Internet ;
- les chemins `/var/lib/padock/servers` et `/var/lib/padock/backups` sont bien montés dans `agent`.

## 10. Déployer une première fois

Dans Dokploy, cliquez sur **Deploy**. Le déploiement construit l’image Padock et lance quatre services :

- `padock` : API et interface Web ;
- `agent` : gestion de Docker, des fichiers, de la console et du SFTP ;
- `database` : PostgreSQL ;
- `gate` : passerelle Minecraft par sous-domaine.

L’état attendu est :

- `padock` : healthy ;
- `agent` : running ;
- `database` : healthy ;
- `gate` : running.

Le premier build télécharge les dépendances Node.js et peut prendre plusieurs minutes. Ne relancez pas immédiatement le déploiement : ouvrez l’onglet **Deployments**, suivez les logs jusqu’à la fin, puis consultez les logs de chaque service. PostgreSQL applique automatiquement les migrations au démarrage du panel.

Dans les logs Gate, vous devez trouver des messages similaires à :

```text
running in lite mode
listening for connections {"addr":"0.0.0.0:25565"}
```

Avant le premier serveur, Padock crée une route sentinelle interne afin que Gate puisse démarrer. Cette route est remplacée automatiquement dès qu’un vrai sous-domaine est attribué.

Si `padock` reste unhealthy, vérifiez d’abord `database`, puis recherchez dans les logs du panel une erreur `DATABASE_URL`, `permission denied` ou `PADOCK_ENCRYPTION_KEY`. Une route Dokploy ne fonctionnera pas tant que le healthcheck du service échoue.

## 11. Ajouter le domaine HTTPS du panel dans Dokploy

Dans le service Docker Compose Padock :

1. ouvrez l’onglet **Domains** ;
2. cliquez sur **Add Domain** ;
3. entrez `panel.example.com` dans **Host/Domain** ;
4. sélectionnez le service `padock` ;
5. indiquez `3000` comme **Container Port** ;
6. utilisez `/` comme chemin ;
7. activez **HTTPS** ;
8. choisissez le certificat **Let's Encrypt** ;
9. enregistrez ;
10. redéployez le Docker Compose pour appliquer les labels Traefik.

La valeur doit correspondre exactement à `PADOCK_PUBLIC_URL=https://panel.example.com`.

Dokploy ajoute les labels Traefik au service `padock`. Il ne faut pas ajouter le domaine au service `agent`, `database` ou `gate`.

Documentation officielle : [domaines Docker Compose Dokploy](https://docs.dokploy.com/docs/core/docker-compose/domains) et [paramètres des domaines](https://docs.dokploy.com/docs/core/domains).

## 12. Initialiser Padock

Ouvrez :

```text
https://panel.example.com
```

Lors du premier accès :

1. choisissez le pseudo administrateur ;
2. choisissez un mot de passe d’au moins 10 caractères ;
3. validez la création du panel ;
4. ouvrez **Mon profil** pour renseigner votre adresse e-mail réelle si nécessaire.

Sécurisez immédiatement le premier compte :

1. ouvrez **Mon profil** ;
2. activez l’authentification à deux facteurs ;
3. enregistrez les codes de récupération dans un gestionnaire de mots de passe ;
4. contrôlez la liste des sessions ouvertes ;
5. si SMTP est configuré, demandez la vérification de l’adresse e-mail ;
6. ne créez une clé API que pour une intégration qui en a réellement besoin.

Le nœud principal doit apparaître en ligne dans la page **Nœuds**.

Le bouton **Modifier** d’un nœud permet de changer son nom, sa localisation et la connexion à l’agent. Un nouveau jeton reste facultatif et Padock teste toute nouvelle URL ou tout nouveau jeton avant de l’enregistrer. La même vue permet d’ajouter des plages de ports et de retirer uniquement les allocations qui ne sont utilisées par aucun serveur.

Dans **Utilisateurs**, l’administrateur peut ensuite créer des rôles personnalisés, choisir leurs permissions globales et les attribuer aux comptes. Un compte peut recevoir des permissions supplémentaires en plus de son rôle. Les droits d’accès à la console, aux fichiers, aux sauvegardes, au SFTP ou à la suppression restent configurables séparément pour chaque serveur.

Dans **Nœuds**, définissez ensuite :

- la capacité totale en RAM, CPU et disque du serveur ;
- une plage d’allocations, par exemple `25566-25620` ;
- le mode maintenance avant toute intervention sur l’hôte ;
- des limites cohérentes avec les ressources réellement disponibles.

Padock refuse un port situé hors des allocations du nœud et réserve atomiquement une allocation pendant une création ou un transfert.

## 13. Créer le premier serveur Minecraft

Depuis la vue générale :

1. cliquez sur **Nouveau serveur** ;
2. donnez un nom au serveur ;
3. gardez le nœud principal ;
4. choisissez le propriétaire ;
5. laissez **Créer une adresse de connexion sans port** activé ;
6. vérifiez le sous-domaine proposé ;
7. choisissez Paper, Vanilla, Purpur, Fabric, Forge ou NeoForge ;
8. indiquez une version Minecraft précise ou `LATEST` ;
9. choisissez un port libre proposé dans la plage d’allocations du nœud ;
10. configurez RAM, CPU et disque ;
11. activez éventuellement l’installation d’un modpack CurseForge ;
12. cliquez sur **Créer le serveur**.

Exemple :

```text
Nom affiché       : Survie entre amis
Sous-domaine      : survie
Adresse joueur    : survie.mc.example.com
Port interne      : choisi parmi les allocations libres, par exemple 25566
```

Le port interne n’est pas visible par les joueurs et n’a pas besoin d’être ouvert dans le pare-feu.

Après la création, cliquez sur **Démarrer**. Le premier lancement peut être long : Docker télécharge l’image Minecraft, puis le serveur génère son monde. Pour un modpack, le server pack officiel CurseForge est téléchargé et appliqué avant le lancement.

## 14. Tester la connexion

Depuis votre PC :

```bash
nslookup survie.mc.example.com
```

Le résultat doit être l’IP du serveur Dokploy.

Testez le port :

```bash
nc -vz survie.mc.example.com 25565
```

Dans Minecraft Java :

```text
Adresse du serveur : survie.mc.example.com
```

N’ajoutez ni `https://` ni `:25566`. Le client Minecraft utilise automatiquement `25565`, puis Gate sélectionne le backend grâce au sous-domaine.

### Valider le serveur dans Padock

Avant d’inviter des joueurs :

1. ouvrez l’onglet **Console** et attendez le message de démarrage complet ;
2. envoyez `list` depuis la console ;
3. ouvrez **Fichiers** et vérifiez la présence de `server.properties` et du monde ;
4. contrôlez les graphiques CPU, RAM, disque et joueurs dans **Monitoring** ;
5. ouvrez **Opérations** et vérifiez que la tâche de création est terminée sans erreur ;
6. arrêtez puis redémarrez le serveur une fois depuis Padock.

Pour un modpack CurseForge, seuls les projets et versions possédant un server pack officiel sont proposés. Si aucun server pack n’est fourni par l’auteur, Padock masque la version ou refuse l’installation au lieu d’utiliser les fichiers du client.

### Tester le SFTP

Dans le serveur Padock, créez un compte SFTP, choisissez les dossiers autorisés et activez éventuellement le mode lecture seule. Connectez-vous ensuite avec un client tel que FileZilla ou WinSCP :

```text
Protocole : SFTP
Hôte      : sftp.example.com
Port      : 2022
Utilisateur et mot de passe : valeurs affichées lors de la création du compte
```

Vérifiez qu’un compte limité ne peut ni remonter hors du serveur ni ouvrir un dossier non autorisé. Supprimez les comptes de test inutiles.

### Tester une sauvegarde

1. créez une sauvegarde manuelle depuis Padock ;
2. attendez la fin de la tâche dans **Opérations** ;
3. vérifiez sa taille et son emplacement local ou S3 ;
4. modifiez un petit fichier non critique ;
5. restaurez la sauvegarde ;
6. vérifiez que le fichier a retrouvé son état initial.

Une sauvegarde qui n’a jamais été restaurée ne doit pas être considérée comme validée.

## 15. Modifier un sous-domaine

Dans Padock :

1. ouvrez le serveur ;
2. ouvrez **Configuration** ;
3. dans **Adresse de connexion**, modifiez le sous-domaine ;
4. cliquez sur **Appliquer**.

Le fichier Gate est réécrit de façon atomique et Gate recharge la route sans redémarrage ni déconnexion des joueurs déjà en ligne. Aucun changement DNS n’est nécessaire grâce au wildcard.

## 16. Vérifications côté serveur

Afficher les ports en écoute :

```bash
sudo ss -ltnp | grep -E ':80|:443|:25565|:2022'
```

Lister les conteneurs :

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Les conteneurs Minecraft doivent avoir une liaison similaire à :

```text
127.0.0.1:25566 -> 25565/tcp
```

Ils ne doivent pas afficher `0.0.0.0:25566` lorsque la passerelle est activée.

Afficher les logs Gate :

```bash
docker ps --format '{{.ID}} {{.Names}}' | grep gate
docker logs NOM_DU_CONTENEUR_GATE --tail 100
```

Après une création ou modification de domaine, les logs doivent contenir :

```text
auto-reloading config
reloaded config successfully
```

Tester l’API publique du panel :

```bash
curl -fsS https://panel.example.com/api/health
```

La réponse doit contenir `"ok":true`, `"database":"postgresql"` et le nœud principal avec `"online":true`. Le champ `mail` reste à `false` tant que SMTP n’est pas configuré.

Validez ensuite les intégrations facultatives depuis l’interface :

- demandez un e-mail de vérification pour tester SMTP ;
- envoyez une notification de test pour contrôler le webhook ;
- créez une sauvegarde distante et vérifiez l’indicateur `S3` ;
- consultez **Opérations** pour confirmer qu’aucune tâche n’est bloquée ou en échec.

## 17. Mise à jour de Padock

1. créez une sauvegarde PostgreSQL et une sauvegarde des mondes ;
2. vérifiez que vous possédez toujours les quatre secrets de production ;
3. poussez la nouvelle version dans la branche configurée ;
4. ouvrez le service Padock dans Dokploy ;
5. contrôlez **Preview Compose** ;
6. cliquez sur **Deploy**, ou activez l’Auto Deploy/Webhook ;
7. surveillez les logs des quatre services ;
8. vérifiez `/api/health`, le nœud, Gate et un serveur Minecraft.

Les migrations PostgreSQL sont appliquées automatiquement au démarrage. Les mondes restent dans `/var/lib/padock/servers`, les sauvegardes dans `/var/lib/padock/backups`, et les volumes Docker conservent PostgreSQL ainsi que les données du panel.

Les volumes Docker `panelmc-*` conservent volontairement leur ancien identifiant interne afin qu’un redéploiement de Padock rattache les données d’une installation existante. Ce nom technique n’est pas visible dans l’interface.

## 18. Sauvegardes recommandées

Sauvegardez au minimum :

- le volume Docker PostgreSQL dont le nom logique est `panelmc-postgres` ;
- le volume panel dont le nom logique est `panelmc-panel` ;
- le volume Gate dont le nom logique est `panelmc-gateway` ;
- `/var/lib/padock/servers` ;
- `/var/lib/padock/backups`.

Docker préfixe généralement les volumes avec le nom du projet Compose. Vérifiez leurs noms réels avec :

```bash
docker volume ls | grep -E 'panelmc-(postgres|panel|gateway)'
```

Dokploy peut sauvegarder les volumes nommés vers une destination S3. Les dossiers `/var/lib/padock` doivent être inclus dans votre propre stratégie de sauvegarde hôte, par exemple avec Restic, Borg ou un snapshot du VPS.

Testez régulièrement une restauration sur une machine séparée.

Conservez également, dans un coffre-fort séparé :

- `PADOCK_ENCRYPTION_KEY` ;
- `PADOCK_JWT_SECRET` ;
- `PADOCK_NODE_TOKEN` ;
- `PADOCK_DATABASE_PASSWORD` ;
- la configuration DNS et la liste des domaines ;
- les identifiants S3 si les sauvegardes distantes sont activées.

### Ordre de restauration sur un nouveau serveur

1. installez Dokploy ;
2. recréez `/var/lib/padock/servers` et `/var/lib/padock/backups` ;
3. restaurez ces deux dossiers ;
4. restaurez les volumes PostgreSQL, panel et Gate ;
5. recréez l’application Compose avec les mêmes variables et surtout la même `PADOCK_ENCRYPTION_KEY` ;
6. redéployez Padock ;
7. vérifiez le nœud avant de démarrer les serveurs ;
8. contrôlez les routes Gate et testez une connexion Minecraft.

## 19. Dépannage

### Le build échoue dans Dokploy

Vérifiez :

- que le dépôt est accessible à Dokploy ;
- que la branche est `main` ;
- que le Compose Path est `./compose.dokploy.yaml` ;
- qu’il reste assez d’espace avec `df -h` et `docker system df` ;
- que les quatre secrets obligatoires ne sont pas vides ;
- que **Preview Compose** ne signale aucune interpolation invalide.

Ne supprimez pas les volumes pour résoudre une erreur de build : ils contiennent les données persistantes.

### Le domaine du panel affiche une erreur 404 ou 502

Vérifiez :

- l’enregistrement A de `panel.example.com` ;
- le service sélectionné : `padock` ;
- le port conteneur : `3000` ;
- `PADOCK_PUBLIC_URL=https://panel.example.com` ;
- le redéploiement après modification du domaine Dokploy ;
- les logs `padock` et Traefik.

### Le panel fonctionne, mais Minecraft ne se connecte pas

Vérifiez dans cet ordre :

1. `nslookup survie.mc.example.com` retourne la bonne IP ;
2. le wildcard est en mode DNS uniquement chez Cloudflare ;
3. le port TCP `25565` est ouvert dans les deux pare-feu ;
4. le service `gate` est running ;
5. le serveur Minecraft est démarré dans Padock ;
6. les logs Gate indiquent un rechargement réussi ;
7. le conteneur Minecraft écoute sur `127.0.0.1:25566` ou un autre port interne.

### Gate redémarre en boucle

Consultez ses logs. Les causes courantes sont :

- le port `25565` est déjà occupé par un ancien serveur ou proxy ;
- le fichier de configuration n’est pas encore généré parce que `padock` ne démarre pas ;
- `PADOCK_GATEWAY_DOMAIN` est absent ou invalide ;
- le volume `panelmc-gateway` n’est pas monté sur les deux services.

Trouvez le processus qui utilise `25565` :

```bash
sudo ss -ltnp | grep ':25565'
```

### Le nœud apparaît hors ligne

Vérifiez :

- le service `agent` ;
- le montage `/var/run/docker.sock:/var/run/docker.sock` ;
- la valeur `DOCKER_GID` ;
- que `PADOCK_NODE_TOKEN` est strictement identique dans `padock` et `agent` ;
- les logs de l’agent.

### Erreur de permissions sur `/var/lib/padock`

Réappliquez :

```bash
sudo mkdir -p /var/lib/padock/{servers,backups}
sudo chown -R 1000:1000 /var/lib/padock
sudo chmod 750 /var/lib/padock
```

Puis redéployez `padock` et `agent`.

Si l’erreur concerne `/var/run/docker.sock`, contrôlez plutôt :

```bash
stat -c 'socket=%n uid=%u gid=%g mode=%a' /var/run/docker.sock
```

Reportez le GID affiché dans `DOCKER_GID`, enregistrez les variables Dokploy, puis redéployez.

### La clé CurseForge ne fonctionne pas

Utilisez :

```env
CURSEFORGE_API_KEY='clé-complète-avec-caractères-spéciaux'
```

Conservez les apostrophes simples et redéployez `padock` ainsi que `agent`. Les modpacks sans server pack officiel sont volontairement masqués et ne peuvent pas être installés automatiquement.

### Une création, sauvegarde ou restauration reste bloquée

Ouvrez **Opérations** dans Padock :

1. consultez le message et la progression de la tâche ;
2. vérifiez que le nœud n’est pas en maintenance ;
3. vérifiez sa capacité et ses allocations libres ;
4. ouvrez les logs `padock` et `agent` dans Dokploy ;
5. corrigez la cause, puis utilisez **Réessayer**.

Après un redémarrage du panel, les tâches persistantes inachevées sont récupérées. Ne créez pas plusieurs fois le même serveur pendant qu’une tâche est encore active.

### SMTP ou S3 ne fonctionne pas

Pour SMTP, contrôlez le couple port/`PADOCK_SMTP_SECURE`, les identifiants et l’adresse d’expéditeur autorisée. Pour S3, vérifiez l’endpoint, la région, le bucket, les droits de lecture/écriture/suppression et `PADOCK_S3_FORCE_PATH_STYLE` pour MinIO. Après toute modification des variables, redéployez le Compose.

### Une ancienne instance utilise le port 25565

Le port hôte `25565` est réservé à Gate. Arrêtez l’ancienne instance avant d’activer la passerelle et migrez-la vers une allocation différente. Ne démarrez jamais Gate et un backend Minecraft sur le même port hôte.

## 20. Checklist finale

- [ ] Dokploy est accessible et sécurisé.
- [ ] `panel.example.com` pointe vers le serveur.
- [ ] `*.mc.example.com` pointe vers le serveur en DNS uniquement.
- [ ] Les secrets de production sont uniques et non publiés.
- [ ] Les dossiers `/var/lib/padock/servers` et `backups` existent.
- [ ] Les quatre services sont en ligne.
- [ ] Le domaine Dokploy cible `padock:3000` avec HTTPS.
- [ ] Les ports 80, 443 et 25565/TCP sont ouverts.
- [ ] Les ports internes Minecraft ne sont pas ouverts publiquement.
- [ ] Le nœud principal est en ligne dans Padock.
- [ ] Une plage de ports et les capacités du nœud sont configurées.
- [ ] La 2FA administrateur est activée et les codes de récupération sont sauvegardés.
- [ ] Le premier serveur a un sous-domaine.
- [ ] Gate recharge sa route avec succès.
- [ ] La connexion Minecraft fonctionne sans saisir de port.
- [ ] La console, les fichiers et un redémarrage du serveur ont été testés.
- [ ] Les restrictions d’un compte SFTP ont été vérifiées, si SFTP est utilisé.
- [ ] SMTP, S3 et le webhook ont été testés s’ils sont configurés.
- [ ] Les sauvegardes PostgreSQL et des mondes sont configurées.
- [ ] Une restauration de sauvegarde a été testée.
- [ ] `PADOCK_ENCRYPTION_KEY` et les autres secrets sont conservés hors du serveur.

## Sources officielles

- [Installation de Dokploy](https://docs.dokploy.com/docs/core/installation)
- [Docker Compose dans Dokploy](https://docs.dokploy.com/docs/core/docker-compose)
- [Domaines Docker Compose Dokploy](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Gestion des domaines Dokploy](https://docs.dokploy.com/docs/core/domains)
- [Gate Lite et routage par sous-domaine](https://gate.minekube.com/guide/lite)
- [Installation Docker de Gate](https://gate.minekube.com/guide/install/docker)
- [Rechargement automatique de Gate](https://gate.minekube.com/guide/config/reload)
