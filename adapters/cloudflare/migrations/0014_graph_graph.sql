-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
CREATE TABLE IF NOT EXISTS graph_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'file', owner_role TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS graph_edges (src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL DEFAULT 'imports', source TEXT NOT NULL, PRIMARY KEY (src, dst, rel));
CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges(dst);
