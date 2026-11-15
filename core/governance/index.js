// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// Self-amending governance (US-SPEC-07 section 3): signature register, recognition engine, pre-emission filter,
// self-amendment loop, objective space. Ports only: db, now, and the model ports each function names.
import { seedRegister } from './register.js';
import { scanState, rates } from './engine.js';
import { amendStep } from './amend.js';
import { drainGoalLedger, retireGoals } from './objectives.js';

export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
export * from './register.js';
export * from './engine.js';
export * from './amend.js';
export * from './objectives.js';

/**
 * One guarded pass for a tick: install the register if absent, record state signatures, run the amendment loop up to (not
 * including) adoption, drain adopted goals into work items and retire finished or lapsed ones. Model ports are optional:
 * without `generate` or `redteam` proposals wait at their stage and the weekly audit item lists them.
 */
export async function step({ db, now = Date.now(), generate, redteam, evaluate } = {}) {
  await seedRegister(db, { now });
  const drops = await scanState(db, { now });
  const amend = await amendStep(db, { now, generate, redteam, evaluate });
  const goals = await drainGoalLedger(db, { now });
  const retired = await retireGoals(db, { now });
  return { silent_drops: drops.length, proposals_raised: amend.raised, audit: amend.audit, goals_queued: goals.length, goals_retired: retired.length, rates: await rates(db, { now }) };
}
