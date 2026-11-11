<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# adapters/mcp: tool server for agent clients

JSON-RPC 2.0 MCP server (`initialize`, `ping`, `tools/list`, `tools/call`) with two transports on one core: `handleHttp(request)` and `handleLine(line)` (stdio). Tool failures return `isError` results. `readTools(db)` gives `list_items` and `get_item`; write tools belong behind claims and the console.

Owner role: product-manager. Trigger: client connects. Closing probe: `tools/list` returns the registered tools over both transports. Status: BUILT (`server.test.js`). Authentication is the shared route table's job (`adapters/shared/routes.js`, `tokenEnv`); streaming and resources: NOT COVERED.
