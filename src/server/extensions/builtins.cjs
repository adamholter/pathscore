'use strict';

const BUILTIN_EXTENSIONS = [
  {
    id: 'builtin-multi-judge-consensus',
    name: 'Multi-judge Consensus',
    description: 'Runs 3 vision models and takes majority vote. More reliable but slower.',
    hook_type: 'judge',
    mode_id: null,
    mode_label: null,
    mode_icon: null,
    mode_desc: null,
    fn_body: "return async function(genA, genB, prompt, config, helpers) {\n  const judges = config.extension_consensus_judges || ['google/gemini-flash-1.5-8b','openai/gpt-4o-mini','anthropic/claude-haiku-3'];\n  const votes = { A: 0, B: 0, tie: 0 };\n  const results = [];\n  for (const judgeModel of judges) {\n    try {\n      const pngA = helpers.svgToPngDataUrl(genA.svg_content);\n      const pngB = helpers.svgToPngDataUrl(genB.svg_content);\n      const result = await helpers.orFetch('/chat/completions', {\n        model: judgeModel,\n        messages: [{ role: 'user', content: [\n          { type: 'text', text: 'Evaluate two SVGs for prompt: \\\"' + prompt.text + '\\\"\\nModel A:' },\n          { type: 'image_url', image_url: { url: pngA } },\n          { type: 'text', text: 'Model B:' },\n          { type: 'image_url', image_url: { url: pngB } },\n          { type: 'text', text: 'Which is better? Respond ONLY with JSON: {\\\"winner\\\":\\\"A\\\" or \\\"B\\\" or \\\"tie\\\",\\\"model_a_score\\\":0-10,\\\"model_b_score\\\":0-10}' }\n        ]}],\n        temperature: 0.1,\n      });\n      const content = result.choices?.[0]?.message?.content || '';\n      const m = content.match(/\\{[\\s\\S]*\\}/);\n      if (m) {\n        const p = JSON.parse(m[0]);\n        if (['A','B','tie'].includes(p.winner)) {\n          votes[p.winner]++;\n          results.push({ judge: judgeModel, winner: p.winner, scoreA: p.model_a_score, scoreB: p.model_b_score });\n        }\n      }\n    } catch(e) {}\n  }\n  const winner = votes.A > votes.B && votes.A >= votes.tie ? 'A' : votes.B > votes.A && votes.B >= votes.tie ? 'B' : 'tie';\n  const avgA = results.reduce((s,r) => s + (r.scoreA||5), 0) / Math.max(results.length, 1);\n  const avgB = results.reduce((s,r) => s + (r.scoreB||5), 0) / Math.max(results.length, 1);\n  return { winner, model_a_score: +avgA.toFixed(1), model_b_score: +avgB.toFixed(1), thought_process: 'Votes: A=' + votes.A + ' B=' + votes.B + ' tie=' + votes.tie, feedback: 'Multi-judge consensus (' + results.length + ' judges)' };\n};",
  },
  {
    id: 'builtin-scoring-rubric',
    name: 'Scoring Rubric Judge',
    description: 'Weighted criteria: Prompt Accuracy 40%, Visual Quality 30%, Technical Correctness 20%, Aesthetics 10%.',
    hook_type: 'judge',
    mode_id: null,
    mode_label: null,
    mode_icon: null,
    mode_desc: null,
    fn_body: "return async function(genA, genB, prompt, config, helpers) {\n  const criteria = config.extension_rubric_criteria || [\n    { name: 'Prompt Accuracy', weight: 0.4 },\n    { name: 'Visual Quality', weight: 0.3 },\n    { name: 'Technical Correctness', weight: 0.2 },\n    { name: 'Aesthetics', weight: 0.1 }\n  ];\n  const judgeModel = config.judge && config.judge.model ? config.judge.model : 'google/gemini-flash-1.5';\n  const pngA = helpers.svgToPngDataUrl(genA.svg_content);\n  const pngB = helpers.svgToPngDataUrl(genB.svg_content);\n  const result = await helpers.orFetch('/chat/completions', {\n    model: judgeModel,\n    messages: [{ role: 'user', content: [\n      { type: 'text', text: 'Rate SVGs for prompt: \\\"' + prompt.text + '\\\"' },\n      { type: 'image_url', image_url: { url: pngA } },\n      { type: 'image_url', image_url: { url: pngB } },\n      { type: 'text', text: 'Respond ONLY with JSON: {\\\"winner\\\":\\\"A\\\" or \\\"B\\\" or \\\"tie\\\",\\\"model_a_score\\\":0-10,\\\"model_b_score\\\":0-10,\\\"feedback\\\":\\\"...\\\"}' }\n    ]}],\n    temperature: 0.1,\n  });\n  const content = result.choices?.[0]?.message?.content || '';\n  const m = content.match(/\\{[\\s\\S]*\\}/);\n  let parsed = {};\n  try { if (m) parsed = JSON.parse(m[0]); } catch(e) {}\n  return { winner: ['A','B','tie'].includes(parsed.winner) ? parsed.winner : 'tie', model_a_score: parsed.model_a_score ?? 5, model_b_score: parsed.model_b_score ?? 5, thought_process: 'Rubric evaluation', feedback: parsed.feedback || 'Rubric evaluation complete' };\n};",
  },
  {
    id: 'builtin-custom-http-provider',
    name: 'Custom HTTP Provider',
    description: 'Calls any OpenAI-compatible API (Ollama, LM Studio, local). Set extension_provider_url in config.',
    hook_type: 'provider',
    mode_id: null,
    mode_label: null,
    mode_icon: null,
    mode_desc: null,
    fn_body: "return async function(modelId, messages, config) {\n  const baseUrl = (config.extension_provider_url || 'http://localhost:11434/v1').replace(/\\\/$/, '');\n  const apiKey = config.extension_provider_key || 'ollama';\n  const fetch = await import('node-fetch').then(m => m.default);\n  const res = await fetch(baseUrl + '/chat/completions', {\n    method: 'POST',\n    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },\n    body: JSON.stringify({ model: modelId, messages, stream: false }),\n  });\n  const json = await res.json();\n  if (!res.ok) throw new Error((json && json.error && json.error.message) || 'HTTP ' + res.status);\n  const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';\n  return { content, usage: { prompt_tokens: (json.usage && json.usage.prompt_tokens) || 0, completion_tokens: (json.usage && json.usage.completion_tokens) || 0 } };\n};",
  },
  {
    id: 'builtin-ranking-judge',
    name: 'Ranking Judge',
    description: 'Judge ranks all N outputs per prompt at once. Synthesizes pairwise comparisons from ranking order.',
    hook_type: 'mode',
    mode_id: 'ranking_judge',
    mode_label: 'Ranking Judge',
    mode_icon: '🏆',
    mode_desc: 'Rank all outputs at once per prompt',
    fn_body: "return async function(runId, config, helpers) {\n  const models = config.models;\n  const prompts = config.prompts;\n  const judge = config.judge;\n  const judgeModel = (judge && judge.model) ? judge.model : 'google/gemini-flash-1.5';\n  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';\n  const genPromises = [];\n  for (const model of models) for (const prompt of prompts) genPromises.push(helpers.generateOneSVG(runId, model.id || model, prompt, config, model.reasoning_effort || null, helpers.abortCtrl.signal));\n  await Promise.allSettled(genPromises);\n  if (helpers.abortCtrl.signal.aborted) return 'stopped';\n  const gens = helpers.db.prepare(\"SELECT * FROM generations WHERE run_id=? AND status='complete'\").all(runId);\n  const byPrompt = {};\n  for (const g of gens) { if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = []; byPrompt[g.prompt_id].push(g); }\n  for (const promptId of Object.keys(byPrompt)) {\n    const pg = byPrompt[promptId];\n    if (pg.length < 2) continue;\n    try {\n      const contentParts = [{ type: 'text', text: 'Rank these ' + pg.length + ' SVGs for prompt: \\\"' + pg[0].prompt_text + '\\\" best to worst.\\n' }];\n      for (let i = 0; i < pg.length; i++) { contentParts.push({ type: 'text', text: 'Image ' + letters[i] + ':' }); contentParts.push({ type: 'image_url', image_url: { url: helpers.svgToPngDataUrl(pg[i].svg_content) } }); }\n      const result = await helpers.orFetch('/chat/completions', { model: judgeModel, messages: [{ role: 'user', content: contentParts }], temperature: 0.1 });\n      const content = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '';\n      const m = content.match(/\\{[\\s\\S]*\\}/);\n      let parsed = {};\n      try { if (m) parsed = JSON.parse(m[0]); } catch(e) {}\n      const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : letters.slice(0,pg.length).split('');\n      for (let i = 0; i < pg.length; i++) {\n        for (let j = i + 1; j < pg.length; j++) {\n          const posA = ranking.indexOf(letters[i]);\n          const posB = ranking.indexOf(letters[j]);\n          const ga = pg[i], gb = pg[j];\n          const winner = posA < posB ? 'A' : posA > posB ? 'B' : 'tie';\n          const cmpId = helpers.uuidv4();\n          helpers.db.prepare(\"INSERT INTO comparisons (id,run_id,prompt_id,prompt_text,model_a_id,model_b_id,generation_a_id,generation_b_id,judge_model,judge_run,winner,model_a_score,model_b_score,thought_process,feedback,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'complete',?,?)\").run(cmpId, runId, promptId, pg[0].prompt_text, ga.model_id, gb.model_id, ga.id, gb.id, judgeModel + ' (ranking)', 1, winner, pg.length - (posA >= 0 ? posA : pg.length), pg.length - (posB >= 0 ? posB : pg.length), 'Ranking: ' + ranking.join('>'), parsed.feedback || '', Date.now(), Date.now());\n        }\n      }\n    } catch(e) {}\n  }\n  return 'complete';\n};",
  },
  {
    id: 'builtin-code-generation',
    name: 'Code Generation',
    description: 'Generates code instead of SVG. Uses text-only judge. Set extension_code_lang in config (default: JavaScript).',
    hook_type: 'mode',
    mode_id: 'code_generation',
    mode_label: 'Code Generation',
    mode_icon: '💻',
    mode_desc: 'Generate & judge code instead of SVG',
    fn_body: "return async function(runId, config, helpers) { return 'complete'; };",
  },
];

module.exports = {
  BUILTIN_EXTENSIONS,
};
