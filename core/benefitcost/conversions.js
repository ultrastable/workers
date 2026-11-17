// SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
// Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
// The common metric is the WELLBY: one point of life satisfaction (0-10 scale) for one person for one year. Benefits in other units are converted
// through the PUBLISHED assumptions below. Every parameter is a distribution with a status: 'cited' (taken from a named source),
// 'assumption' (the maintainers' reading, with the range meant to span the published disagreement) or 'unverified' (never a default).
// A result lists the statuses it used, so a reader sees how much of a number rests on assumption. A tenant may override any parameter by id.
export const PARAMS = {
  ls_mean: { dist: { kind: 'ci90', low: 2.3, high: 4.4, shape: 'normal' }, unit: 'points (0-10)', status: 'cited',
    note: 'Average life satisfaction of recipients in rural Kenya: 4.4/10 from survey data, 2.3/10 in the IDinsight beneficiary survey (Happier Lives Institute, Estimating moral weights, section 4.1.1, pp. 13-14). Override per solution when the population differs.' },
  neutral_point: { dist: { kind: 'ci90', low: 0.05, high: 2.5, shape: 'normal' }, unit: 'points (0-10)', status: 'cited',
    note: 'Life satisfaction at which an extra year of life is neither good nor bad. Range 0.05-2.5 used by the Happier Lives Institute (section 4.1.1, p. 15), which cites an IDinsight estimate of 0.56 and UK survey respondents choosing death near 2/10. Still disputed.' },
  sd_ls: { dist: 2.17, unit: 'points per SD', status: 'cited',
    note: 'Average standard deviation of 0-10 life-satisfaction measures, used to turn an effect in SD into WELLBYs (Happier Lives Institute cost-effectiveness methodology).' },
  discount: { dist: { kind: 'tri', min: 0.015, mode: 0.03, max: 0.05 }, unit: 'per year', status: 'assumption',
    note: 'Annual discount rate for future wellbeing and cost; spans the 1.5% health and 3.5% standard rates used in UK appraisal. Shown, never hidden.' },
  consumption_doubling_wellby: { dist: { kind: 'ci90', low: 2, high: 19, shape: 'lognormal' }, unit: 'WELLBYs per doubling-year', status: 'cited',
    note: 'WELLBYs from doubling one person consumption for a year, including household spillovers: 7 (90% interval 2 to 19) (Happier Lives Institute, Estimating moral weights, section 5.3, p. 21); about 1.8 (0.6-5.0) for the recipient alone.' },
  death_u5_deprivationism: { dist: { kind: 'ci90', low: 58, high: 360, shape: 'lognormal' }, unit: 'WELLBYs per death averted', status: 'cited',
    note: 'WELLBYs from averting one under-5 death if death is bad by the life it deprives: 220 (58 to 360) (Happier Lives Institute, section 5.3, p. 21).' },
  death_u5_tria: { dist: { kind: 'ci90', low: 9, high: 110, shape: 'lognormal' }, unit: 'WELLBYs per death averted', status: 'cited',
    note: 'Same under the time-relative interest account, which values a young child less: 45 (9 to 110) (Happier Lives Institute, sections 4.1.2 and 5.3). The two views are mixed 50/50 per draw as model uncertainty; GiveWell uses 100 doubling-years per death.' },
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
  // deaths averted (under 5): the two cited philosophical views, mixed 50/50 per draw.
  death_averted: { stream: false, per: (p, node, u) => (u < 0.5 ? p.death_u5_deprivationism : p.death_u5_tria) },
};

// Discounted sum of a stream of 1/year starting after lag, lasting years, with optional linear decay to zero.
export function streamFactor({ years = 1, lag = 0, decay = 'none' }, r) {
  let f = 0; const n = Math.max(1, Math.round(years));
  for (let t = 0; t < n; t++) f += (decay === 'linear' ? 1 - t / n : 1) / Math.pow(1 + r, lag + t);
  return f;
}
export const annuity = (years, r) => { let f = 0; for (let t = 0; t < Math.max(1, Math.round(years)); t++) f += 1 / Math.pow(1 + r, t); return f; };
