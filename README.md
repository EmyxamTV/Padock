# Padock

Padock est un panel d'hébergement Minecraft inspiré de l'architecture de Pterodactyl. Le Panel central gère les comptes et les instances, tandis qu'un agent léger installé sur chaque nœud Linux contrôle Docker, les processus et les fichiers.

## État actuel

- compte administrateur et session HTTP-only ;
- PostgreSQL avec migration automatique depuis l'ancien fichier JSON ;
- comptes administrateur/utilisateur, propriétaires et sous-utilisateurs ;
- page de profil avec modification sécurisée du pseudo, de l’e-mail et du mot de passe ;
- permissions par serveur et journal d'audit ;
- gestionnaire de fichiers avec éditeur intégré ;
- upload jusqu’à 128 Mo, téléchargement et renommage de fichiers ;
- accès SFTP isolé par serveur avec mot de passe temporaire ;
- éditeur guidé des principales propriétés Minecraft ;
- catalogue CurseForge pour les plugins, mods et modpacks ;
- sélection et installation directe d’un modpack pendant la création du serveur ;
- filtrage des modpacks sans server pack et recommandations automatiques de RAM/disque ;
- installation automatique des modpacks, dépendances et version exacte du loader ;
- modification sécurisée des limites RAM, CPU et disque depuis l’interface ;
- recherche et filtrage des instances par nom, logiciel, version et état ;
- adresse de connexion copiable et consommation disque mesurée par l’agent ;
- sous-domaines Minecraft sans port grâce à Gate Lite (`survie.mc.example.com`) ;
- génération et rechargement automatique des routes de la passerelle ;
- déploiement Dokploy prêt à l’emploi avec domaine HTTPS natif pour le panel ;
- renommage des instances et historique d’activité dédié à chaque serveur ;
- réparation/recréation du conteneur Docker sans supprimer le monde ni les extensions ;
- arrêt forcé de secours pour les conteneurs bloqués ;
- diagnostic des arrêts Docker, erreurs mémoire et healthchecks directement dans le panel ;
- sauvegardes compressées, restauration et sauvegarde de sécurité ;
- tâches planifiées exécutables manuellement ;
- métriques CPU, RAM et réseau en direct ;
- Panel et agent de nœud séparés ;
- communication Panel-Agent authentifiée par jeton ;
- vue des nœuds avec CPU, mémoire et état Docker ;
- création de serveurs Paper, Vanilla, Purpur, Fabric, Forge et NeoForge ;
- choix du nœud, de la version, de la RAM et du port ;
- allocations IP/ports et quotas mémoire, CPU et disque ;
- démarrage, arrêt, redémarrage, console en direct et commandes RCON ;
- monde persistant dans `/var/lib/padock/servers/<id>` ;
- détection propre des nœuds hors ligne.

Consultez [ARCHITECTURE.md](ARCHITECTURE.md) pour la cible fonctionnelle et les prochaines étapes.

## Installation Linux sur une seule machine

Prérequis : Docker Engine avec le plugin Compose.

```bash
git clone <url-du-depot> padock
cd padock
cp .env.example .env
```

Générez deux secrets distincts :

```bash
echo "PADOCK_JWT_SECRET=$(openssl rand -hex 48)" >> .env
echo "PADOCK_NODE_TOKEN=$(openssl rand -hex 48)" >> .env
echo "PADOCK_DATABASE_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env
```

Puis configurez l'adresse publique et démarrez :

```env
PADOCK_PUBLIC_URL=https://panel.example.com
PADOCK_PANEL_DATA_DIR=/var/lib/padock/panel
PADOCK_SERVERS_DIR=/var/lib/padock/servers
PADOCK_BACKUPS_DIR=/var/lib/padock/backups
PADOCK_SFTP_PUBLIC_HOST=sftp.example.com
PADOCK_SFTP_PUBLIC_PORT=2022
CURSEFORGE_API_KEY='$votre-cle-curseforge'
```

```bash
sudo mkdir -p /var/lib/padock/{panel,servers,backups}
sudo chown -R 1000:1000 /var/lib/padock
docker compose up -d --build
```

Les anciennes variables `PANELMC_*`, les conteneurs Minecraft nommés `panelmc-<id>` et les métadonnées `.panelmc` restent reconnus automatiquement. Une installation existante peut ainsi être redéployée avant de migrer progressivement son `.env` vers `PADOCK_*`.

Le Panel écoute sur le port `3000` et le SFTP sur le port `2022`. La première visite permet de créer l'administrateur. Placez le Panel derrière Caddy, Traefik ou Nginx avec HTTPS et ouvrez le port SFTP uniquement si vous souhaitez l’utiliser à distance.

La clé CurseForge se crée dans la [console développeur CurseForge](https://console.curseforge.com/). Copiez-la intégralement entre apostrophes simples dans `.env`. Elles protègent les caractères spéciaux tels que `$`, `#`, `!` et `&` : ne doublez pas les `$` et n’ajoutez aucun antislash. Après une modification du fichier, appliquez-la avec `docker compose up -d --force-recreate padock agent`. Sans clé, toutes les fonctions du Panel restent disponibles sauf le catalogue et l’installation CurseForge.

Lorsqu’un modpack est choisi pendant la création, Padock récupère le `serverPackFileId` du fichier compatible, télécharge le server pack officiel, vérifie son empreinte SHA-1 ou MD5, puis prépare le conteneur avec `GENERIC_PACK`. Pour un serveur existant, Padock crée d’abord une sauvegarde avant de le reconfigurer. Le monde n’est pas supprimé.

Un projet sans server pack ZIP est refusé proprement. Padock ne retombe pas sur le pack client. L’archive serveur reste stockée dans `.padock/server-packs` dans les données du serveur et est appliquée au premier démarrage.

## Déploiement avec Dokploy et domaines Minecraft

Utilisez `compose.dokploy.yaml` comme fichier Compose dans Dokploy et copiez les variables de `.env.dokploy.example` dans l’onglet Environment. Remplacez les trois secrets, les domaines, l’IP publique et `DOCKER_GID` avant le premier déploiement.

Dans l’onglet **Domains** de l’application Docker Compose Dokploy, ajoutez le domaine du panel sur :

- service : `padock` ;
- port du conteneur : `3000` ;
- domaine : la même valeur que `PADOCK_PUBLIC_URL`, sans `https://` dans le champ Domain ;
- HTTPS : activé.

La gestion de domaines native de Dokploy configure les routes HTTP de Traefik pour l’interface Web. Le trafic Minecraft n’est pas HTTP : `compose.dokploy.yaml` lance donc également Gate Lite sur le port TCP `25565`.

Créez ces enregistrements DNS chez votre fournisseur :

```text
panel.example.com   A     IP_DU_SERVEUR_DOKPLOY
*.mc.example.com    A     IP_DU_SERVEUR_DOKPLOY
```

Puis configurez :

```env
PADOCK_PUBLIC_URL=https://panel.example.com
PADOCK_GATEWAY_DOMAIN=mc.example.com
PADOCK_GATEWAY_DNS_TARGET=IP_DU_SERVEUR_DOKPLOY
```

Ouvrez les ports TCP `80`, `443` et `25565` sur le pare-feu. Le port `2022` est nécessaire uniquement pour le SFTP. Il ne faut pas ouvrir la plage des ports internes Minecraft : lorsque la passerelle est active, l’agent les lie à `127.0.0.1` et seul Gate y accède.

Dans la modale de création, Padock propose automatiquement un sous-domaine dérivé du nom. Par exemple, `Survie entre amis` devient `survie-entre-amis.mc.example.com`. Gate recharge le routage à chaud lors d’une création, modification ou suppression. Les joueurs utilisent cette adresse sans ajouter de port et aucun enregistrement DNS individuel n’est nécessaire grâce au wildcard.

Pour une installation existante, les serveurs déjà créés doivent utiliser un port interne différent de `25565`, réservé à Gate. Après activation de la passerelle, utilisez **Configuration → Réparer le conteneur** sur les anciennes instances arrêtées afin que leur port soit relié uniquement à l’interface locale.

## Développement

```bash
npm install
```

Le mode développement utilise automatiquement un jeton local et connecte le Panel à l'agent sur le port `3001` :

```bash
npm run dev
```

Services disponibles : interface `5173`, Panel `3000`, agent `3001`.

## Sécurité

Seul l'agent monte `/var/run/docker.sock`. Le Panel n'a aucun accès direct à Docker. Pour un nœud distant, exposez son API uniquement en HTTPS et limitez l'accès réseau à l'adresse du Panel. Les jetons de nœuds ne sont jamais retournés à l'interface Web. Les accès SFTP sont enfermés dans le dossier du serveur et utilisent un secret signé valable 30 minutes. En mode Dokploy, Gate est le seul service de jeu exposé publiquement ; les ports des backends restent sur la boucle locale.

La suppression d'une instance retire son conteneur, mais conserve volontairement le monde sur le nœud.
