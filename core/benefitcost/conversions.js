// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The common metric is the WELLBY: one point of life satisfaction (0-10 scale) for one person for one year. Benefits in other units are converted
// through the PUBLISHED assumptions below. Every parameter is a distribution with a status: 'cited' (taken from a named source),
// 'assumption' (the maintainers' reading, with the range meant to span the published disagreement) or 'unverified' (never a default).
// A result lists the statuses it used, so a reader sees how much of a number rests on assumption. A tenant may override any parameter by id.
export const PARAMS = {
  ls_mean: { dist: { kind: 'ci90', low: 3.5, high: 6, shape: 'normal' }, unit: 'points (0-10)', status: 'assumption',
    note: 'Average life satisfaction of the people helped; low-income populations typically sit near 4-5.5. Override per solution when the population is known.' },
  neutral_point: { dist: { kind: 'ci90', low: 0.5, high: 5, shape: 'normal' }, unit: 'points (0-10)', status: 'assumption',
    note: 'Life satisfaction at which an extra year of life is neither good nor bad. Genuinely disputed (the Happier Lives Institute lists it as an open research question), so the range is wide on purpose.' },
  sd_ls: { dist: 2.17, unit: 'points per SD', status: 'cited',
    note: 'Average standard deviation of 0-10 life-satisfaction measures, used to turn an effect in SD into WELLBYs (Happier Lives Institute cost-effectiveness methodology).' },
  discount: { dist: { kind: 'tri', min: 0.015, mode: 0.03, max: 0.05 }, unit: 'per year', status: 'assumption',
    note: 'Annual discount rate for future wellbeing and cost; spans the 1.5% health and 3.5% standard rates used in UK appraisal. Shown, never hidden.' },
  consumption_doubling_wellby: { dist: { kind: 'ci90', low: 0.15, high: 1.2, shape: 'lognormal' }, unit: 'WELLBYs per person-year', status: 'assumption',
    note: 'WELLBYs gained by one person from doubling their consumption for one year. Placeholder range pending a line-by-line read of the Happier Lives Institute estimate from the Kenya cash-transfer trials; the log scale reflects diminishing returns to income.' },
  moral_weight_death_u5: { dist: { kind: 'ci90', low: 33, high: 154, shape: 'lognormal' }, unit: 'doublings-years per death', status: 'cited',
    note: 'Value of averting one child death relative to doubling one person consumption for a year: 33:1 (time-relative interest account) to 154:1 (deprivationism) in Happier Lives Institute estimates; GiveWell currently uses 100:1.' },
};
export const GRADES = {
  A: { label: 'Systematic review or several consistent randomised trials', haircut: { kind: 'uniform', min: 0.8, max: 1 } },
  B: { label: 'One randomised trial or a strong quasi-experiment', haircut: { kind: 'uniform', min: 0.6, max: 0.9 } },
  C: { label: 'Observational or modelled link', haircut: { kind: 'uniform', min: 0.3, max: 0.7 } },
  D: { label: 'Expert judgement or untested mechanism', haircut: { kind: 'uniform', min: 0.1, max: 0.5 } },
};
// WELLBYs per unit of a node's amount, for one draw p of the parameters. 'stream' units are per person-year and get duration, decay and discounting;
// 'stock' units already contain their own duration.
export const UNITS = {
  wellby: { stream: true, per: () => 1 },
  sd_ls_year: { stream: true, per: p => p.sd_ls },
  consumption_doubling_year: { stream: true, per: p => p.consumption_doubling_wellby },
  daly: { stream: false, per: p => Math.max(0, p.ls_mean - p.neutral_point) }, // one healthy year of life is worth the gap above the neutral point
  // deaths averted: remaining life years (node.life_years) valued above the neutral point, mixed 50/50 with the moral-weight route (model uncertainty).
  death_averted: { stream: false, per: (p, node, u) => (u < 0.5
    ? Math.max(0, p.ls_mean - p.neutral_point) * (node.life_years ?? p.life_years_default) * p.life_discount(node)
    : p.moral_weight_death_u5 * p.consumption_doubling_wellby) },
};
export const LIFE_YEARS_DEFAULT = { kind: 'ci90', low: 35, high: 65, shape: 'normal' };

// Discounted sum of a stream of 1/year starting after lag, lasting years, with optional linear decay to zero.
export function streamFactor({ years = 1, lag = 0, decay = 'none' }, r) {
  let f = 0; const n = Math.max(1, Math.round(years));
  for (let t = 0; t < n; t++) f += (decay === 'linear' ? 1 - t / n : 1) / Math.pow(1 + r, lag + t);
  return f;
}
export const annuity = (years, r) => { let f = 0; for (let t = 0; t < Math.max(1, Math.round(years)); t++) f += 1 / Math.pow(1 + r, t); return f; };
