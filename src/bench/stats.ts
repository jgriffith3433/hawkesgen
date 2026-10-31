// Gen Bench's numbers (docs/bench.md): a run's summary, the trend over runs, the comparison with the market baseline,
// and how well each score agrees with J's ratings. Pure, so the tests check the math directly.

export type Scored = {
  brief: string; source?: string; status?: string; pass: number | null; identity: number | null; spread?: number | null; checklist: number | null;
  style: number | null; faults: number | null; credits?: number; cost?: number; seconds?: number; rating?: number | null;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
const nums = (rows: Scored[], f: (r: Scored) => number | null | undefined) => rows.map(f).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

export type Summary = {
  outputs: number; scored: number; failed: number; briefs: number;
  pass: number | null; identity: number | null; spread: number | null; checklist: number | null; style: number | null; faultFree: number | null;
  credits: number; cost: number; seconds: number;
};

/** One run (or one brief's results): means over scored outputs. `pass` and `faultFree` are shares; identity a mean distance. */
export function summarize(rows: Scored[]): Summary {
  const scored = rows.filter((r) => r.status === undefined || r.status === 'scored');
  return {
    outputs: rows.length,
    scored: scored.length,
    failed: rows.filter((r) => r.status === 'failed').length,
    briefs: new Set(rows.map((r) => r.brief)).size,
    pass: r3(mean(nums(scored, (r) => r.pass))),
    identity: r3(mean(nums(scored, (r) => r.identity))),
    spread: r3(mean(nums(scored, (r) => r.spread))),
    checklist: r3(mean(nums(scored, (r) => r.checklist))),
    style: r3(mean(nums(scored, (r) => r.style))),
    faultFree: r3(mean(nums(scored, (r) => (r.faults == null ? null : r.faults === 0 ? 1 : 0)))),
    credits: Math.round(rows.reduce((s, r) => s + (r.credits ?? 0), 0) * 100) / 100,
    cost: Math.round(rows.reduce((s, r) => s + (r.cost ?? 0), 0) * 10000) / 10000,
    seconds: Math.round(rows.reduce((s, r) => s + (r.seconds ?? 0), 0)),
  };
}

/** Ranks with ties sharing their mean rank (1-based). */
export function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = r;
    i = j + 1;
  }
  return out;
}

export function pearson(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = mean(a)!;
  const mb = mean(b)!;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

/** Spearman's rank correlation: does a higher score go with a higher rating? Null under 3 pairs or with no variation. */
export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** Each score as "higher is better" (identity is a distance, faults a count). */
export const SCORES: Record<string, (r: Scored) => number | null> = {
  identity: (r) => (r.identity == null ? null : -r.identity),
  checklist: (r) => r.checklist,
  style: (r) => r.style,
  faults: (r) => (r.faults == null ? null : r.faults === 0 ? 1 : 0),
  pass: (r) => r.pass,
};

export type Agreement = { score: string; n: number; spearman: number | null; passAgree: number | null; trusted: boolean | null };

/**
 * How each score agrees with J's 1-5 ratings: the rank correlation over rated outputs that have the score, and for pass
 * the share where pass matches "J rated it 4 or 5". A score is trusted at a correlation of 0.5 or more over 10 or more
 * ratings (roadmap: "a score that disagrees with J gets fixed before anyone trusts it").
 */
export function agreement(rows: Scored[]): Agreement[] {
  const rated = rows.filter((r) => typeof r.rating === 'number');
  return Object.entries(SCORES).map(([score, f]) => {
    const pairs = rated.map((r) => [f(r), r.rating as number] as const).filter((p): p is readonly [number, number] => typeof p[0] === 'number');
    const rho = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
    const passAgree = score === 'pass' && pairs.length ? pairs.filter(([p, rt]) => (p === 1) === (rt >= 4)).length / pairs.length : null;
    return { score, n: pairs.length, spearman: rho == null ? null : r3(rho), passAgree: r3(passAgree), trusted: pairs.length < 10 || rho == null ? null : rho >= 0.5 };
  });
}

/** Gen against the baseline per brief: each side's summary and who wins on each score. */
export function versus(gen: Scored[], base: Scored[]) {
  const briefs = [...new Set([...gen, ...base].map((r) => r.brief))];
  const better = (a: number | null, b: number | null, lowerWins = false) => (a == null || b == null ? null : a === b ? 'tie' : (lowerWins ? a < b : a > b) ? 'gen' : 'baseline');
  return briefs.map((brief) => {
    const g = summarize(gen.filter((r) => r.brief === brief));
    const b = summarize(base.filter((r) => r.brief === brief));
    return {
      brief, gen: g, baseline: b,
      wins: { identity: better(g.identity, b.identity, true), checklist: better(g.checklist, b.checklist), style: better(g.style, b.style), faultFree: better(g.faultFree, b.faultFree), pass: better(g.pass, b.pass) },
    };
  });
}
