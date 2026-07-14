# Architecture Padock

## Objectif

Padock reprend les principes efficaces de Pterodactyl tout en restant spécialisé dans Minecraft. Il ne cherche pas à être un orchestrateur multi-jeux générique.

```text
Navigateur
    │ HTTPS + WebSocket
    ▼
Panel central ───── stockage métier
    │ API authentifiée
    ├──────────────► Agent nœud France 1 ──► Docker ──► serveurs Minecraft
    ├──────────────► Agent nœud France 2 ──► Docker ──► serveurs Minecraft
    └──────────────► Agent nœud Canada   ──► Docker ──► serveurs Minecraft

Joueurs ── survie.mc.example.com:25565 ──► Gate Lite ──► 127.0.0.1:25566
        └─ creatif.mc.example.com:25565 ───────────────► 127.0.0.1:25567
```

## Responsabilités

### Panel

- utilisateurs, rôles personnalisés, permissions globales et droits par serveur ;
- catalogue des nœuds et allocations réseau ;
- configuration logique des serveurs ;
- attribution des sous-domaines et génération atomique des routes Gate ;
- quotas, modèles Minecraft et paramètres de démarrage ;
- interface Web, audit et orchestration.

Le Panel ne monte jamais le socket Docker.

### Agent

- cycle de vie des conteneurs ;
- limites mémoire et, à terme, CPU et disque ;
- remontée de la console et des métriques ;
- commandes RCON ;
- API de fichiers, sauvegardes et serveur SFTP isolé par instance.

L'agent utilise les conteneurs et leurs labels comme source de vérité locale. Les mondes restent disponibles même si le Panel est arrêté.

## Modèle de sécurité

- un jeton différent par nœud ;
- HTTPS obligatoire pour enregistrer un nœud distant en production ;
- jetons conservés uniquement côté Panel ;
- aucun accès Docker depuis le navigateur ou le Panel ;
- commandes et logs transitent par le Panel afin de centraliser les permissions ;
- jetons de nœuds et secrets TOTP chiffrés au repos en AES-256-GCM ;
- sessions révocables, double authentification TOTP, codes de récupération et clés API hachées ;
- les permissions effectives d’un compte combinent son rôle personnalisé et ses exceptions individuelles ;
- seuls les administrateurs créent ou modifient les rôles, et un gestionnaire ne peut déléguer que les droits qu’il possède ;
- isolation Docker et limites de mémoire appliquées par l'agent.
- un seul port Minecraft public (`25565`), les backends étant liés à `127.0.0.1` en mode passerelle ;
- un wildcard DNS limite les changements DNS à une configuration initiale unique.

## Feuille de route

### Phase 1 — fondation distribuée

- [x] Panel et agent séparés ;
- [x] appairage et état des nœuds ;
- [x] création et alimentation des serveurs ;
- [x] console temps réel et RCON ;
- [x] choix du nœud lors de la création.

### Phase 2 — administration type Pterodactyl

- [x] PostgreSQL et migration automatique depuis le stockage JSON ;
- [x] utilisateurs, rôles personnalisés, propriétaires, sous-utilisateurs et permissions granulaires ;
- [x] allocations IP/ports par nœud ;
- [x] modification des nœuds et gestion protégée de leurs plages d’allocations ;
- [x] limites mémoire et CPU, contrôle du quota disque au démarrage ;
- [x] journal d'audit administrateur.

### Phase 3 — exploitation Minecraft

- [x] gestionnaire de fichiers sécurisé avec éditeur texte ;
- [x] SFTP intégré à l'agent avec comptes persistants, restrictions par dossier et lecture seule ;
- [x] sauvegardes manuelles, planifiées, restauration et copie pré-restauration ;
- [x] tâches planifiées, commandes et actions d'alimentation ;
- [x] métriques CPU, RAM et réseau en direct ;
- [x] historique graphique sur 7 jours et compteur de joueurs ;
- [x] gestion des propriétés, plugins et mods via CurseForge ;
- [x] téléchargement vérifié et installation des server packs CurseForge officiels.

### Phase 4 — production

- [x] déploiement Docker Compose adapté à Dokploy ;
- [x] domaine HTTPS du panel via Dokploy et sous-domaines de jeu sans port via Gate Lite ;
- [x] authentification à deux facteurs, sessions, clés API, SMTP et récupération de compte ;
- [x] chiffrement des secrets de nœuds et TOTP au repos ;
- [x] stockage objet S3 compatible pour les sauvegardes ;
- [x] clonage, mise à niveau avec rollback et transfert en flux continu entre deux nœuds ;
- [x] file d’opérations persistante, reprise après redémarrage et verrou de worker PostgreSQL ;
- [x] maintenance/capacité des nœuds, allocations atomiques, groupes, quotas et modèles de serveurs ;
- [ ] lecture/écriture active-active de plusieurs réplicas HTTP du Panel.
