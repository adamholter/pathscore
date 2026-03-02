'use strict';

function calcELO(comparisons, models) {
  const K = 32;
  const ratings = Object.fromEntries(models.map(m => [m, 1000]));
  const sorted = [...comparisons]
    .filter(c => c.status === 'complete' && c.winner)
    .sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));

  for (const c of sorted) {
    const ra = ratings[c.model_a_id] ?? 1000;
    const rb = ratings[c.model_b_id] ?? 1000;
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const sa = c.winner === 'A' ? 1 : c.winner === 'B' ? 0 : 0.5;
    ratings[c.model_a_id] = ra + K * (sa - ea);
    ratings[c.model_b_id] = rb + K * ((1 - sa) - (1 - ea));
  }
  return ratings;
}

function calcStats(comparisons, models) {
  const stats = Object.fromEntries(models.map(m => [m, {
    wins: 0, losses: 0, ties: 0, total: 0, score_sum: 0, score_count: 0,
  }]));

  for (const c of comparisons) {
    if (c.status !== 'complete' || !c.winner) continue;
    const a = stats[c.model_a_id];
    const b = stats[c.model_b_id];
    if (!a || !b) continue;

    a.total++;
    b.total++;

    if (c.winner === 'A') {
      a.wins++;
      b.losses++;
    } else if (c.winner === 'B') {
      b.wins++;
      a.losses++;
    } else {
      a.ties++;
      b.ties++;
    }

    if (c.model_a_score != null) {
      a.score_sum += c.model_a_score;
      a.score_count++;
    }
    if (c.model_b_score != null) {
      b.score_sum += c.model_b_score;
      b.score_count++;
    }
  }

  return stats;
}

function calcHeatmap(comparisons, models) {
  const matrix = {};
  models.forEach(a => {
    matrix[a] = {};
    models.forEach(b => { matrix[a][b] = null; });
  });
  const pairs = {};

  for (const c of comparisons) {
    if (c.status !== 'complete' || !c.winner) continue;
    const key = [c.model_a_id, c.model_b_id].sort().join('|||');
    if (!pairs[key]) pairs[key] = { wins: {}, total: 0 };
    pairs[key].total++;
    const winnerModel = c.winner === 'A' ? c.model_a_id : c.winner === 'B' ? c.model_b_id : null;
    if (winnerModel) pairs[key].wins[winnerModel] = (pairs[key].wins[winnerModel] || 0) + 1;
  }

  for (const [key, data] of Object.entries(pairs)) {
    const [ma, mb] = key.split('|||');
    if (!models.includes(ma) || !models.includes(mb)) continue;
    const wa = data.wins[ma] || 0;
    const wb = data.wins[mb] || 0;
    matrix[ma][mb] = data.total > 0 ? wa / data.total : null;
    matrix[mb][ma] = data.total > 0 ? wb / data.total : null;
  }

  return matrix;
}

module.exports = {
  calcELO,
  calcStats,
  calcHeatmap,
};
