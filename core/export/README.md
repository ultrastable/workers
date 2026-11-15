<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/export: export before drop

US-01-R04: migrations are additive, and one that drops or rewrites data runs only after the affected tables were exported to an object store and the export was read back.

| Requirement | Status |
|---|---|
| US-01-R04 detect a destructive migration (drop table or column, rename, delete, update, replace, truncate) | BUILT (`classify`, `export.test.js`) |
| US-01-R04 export each affected table, read it back, compare row count and hash, record the proof | BUILT (`exportTable`, table `export_ledger`) |
| US-01-R04 refuse the migration when the export is missing, unreadable or different | BUILT (`applyMigration`, table `export_migrations`) |
| Every migration shipped in the repository is additive | BUILT as a test over `core/*/migrations` |
| A binding to a hosted object store | NOT COVERED: the store is a port (`put`, `get`); an R2 bucket binding fits it unchanged, and no live bucket was used |

Ports: `db`, `store`, `now`. Owner role: operations. Trigger: any migration applied through `applyMigration`. Closing probe: `node --test core/export/export.test.js`.
