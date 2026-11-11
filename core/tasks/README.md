<!-- SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0 -->
<!-- Copyright (c) 2026 Rowan Brad Quni-Gudzinas -->

# core/tasks: task runner and owner-step watch

Deferred work in `tasks_queue`. Handlers are an ordered list per kind (first success wins), retried with backoff, then `failed` and filed as item `TASK-<id>`. `watchOwnerSteps` closes gate cards whose probe passes and escalates, once, those open longer than `owner_step_hours` (24).

Owner role: operations. Trigger: every tick. Closing probe: no `pending` row older than its backoff; every failed task has an item. Status: BUILT (`tasks.test.js`). Workflow definitions beyond single tasks: NOT COVERED.
