# Master Koinos AI Node

Independent copy of the current Koinos AI Test app, extended with Free Koinos Node's
full Distribution tab and a read-only API backed by your own Koinos node.

- Full KAI application and existing AI/node features.
- Community pools, reburn, named percentage recipients, queues and history.
- Separate Master app identity, profile, Core port and update feed.
- Cached producer-data endpoint with bounded indexing and freshness checks.
- Offline, non-destructive migration of the old encrypted wallet and accounting.

Read [setup, migration and endpoint deployment](docs/MASTER_NODE.md) before
replacing the existing node controller. Distribution and API serving default to off.

Develop on `master-kaiapp` in `therexdev/kaiapp`. Node 22: `npm ci`, `npm test`, `npm start`.
Master shares the repository's signing settings. A `[release]` commit builds and
publishes to the isolated [Master download channel](https://github.com/therexdev/kaiapp/releases/tag/master-build).

Upstream snapshot: `therexdev/kaiapp:test@f57bae4062016e6b8fe0f538607637ee1b95896d`.
Distribution source: `therexdev/free-koinos-node@b86dfaaffc0a0490b329f8a7b0c81d0cb26770a7`.
Historical Test/Alpha documentation does not override Master's separate identity.
