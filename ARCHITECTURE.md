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

- utilisateurs, rôles et permissions ;
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
- [x] utilisateurs, propriétaires, sous-utilisateurs et permissions ;
- [x] allocations IP/ports par nœud ;
- [x] limites mémoire et CPU, contrôle du quota disque au démarrage ;
- [x] journal d'audit administrateur.

### Phase 3 — exploitation Minecraft

- [x] gestionnaire de fichiers sécurisé avec éditeur texte ;
- [x] SFTP intégré à l'agent avec identifiants temporaires ;
- [x] sauvegardes manuelles, planifiées, restauration et copie pré-restauration ;
- [x] tâches planifiées, commandes et actions d'alimentation ;
- [x] métriques CPU, RAM et réseau en direct ;
- [ ] historique graphique et compteur de joueurs ;
- [x] gestion des propriétés, plugins et mods via CurseForge ;
- [x] téléchargement vérifié et installation des server packs CurseForge officiels.

### Phase 4 — production

- [x] déploiement Docker Compose adapté à Dokploy ;
- [x] domaine HTTPS du panel via Dokploy et sous-domaines de jeu sans port via Gate Lite ;
- [ ] authentification à deux facteurs et récupération de compte ;
- [ ] chiffrement des secrets de nœuds au repos ;
- [ ] stockage objet S3 pour les sauvegardes ;
- [ ] transfert d'un serveur entre deux nœuds ;
- [ ] haute disponibilité du Panel et file de tâches.
