#!/usr/bin/env node
// PathScore CLI -- test runner and diagnostics
'use strict';

const fs = require('fs');
if (fs.existsSync('./.env')) {
  fs.readFileSync('./.env', 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const BASE = `http://localhost:${process.env.PORT || 7642}`;

const usage = `
PathScore CLI

Commands:
  node cli.cjs test-quick        Run a minimal benchmark (2 models, 2 prompts) to verify the system works
  node cli.cjs test-judge        Test judge connectivity with a dummy pair
  node cli.cjs test-parse        Test SVG extraction from various LLM response formats
  node cli.cjs list-runs         List all benchmark runs
  node cli.cjs results <run-id>  Show results for a run
  node cli.cjs status            Show server status
`;

async function apiFetch(path, options) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(BASE + path, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function extractSVG(text) {
  text = text.replace(/<think[\s\S]*?<\/think>/gi, '');
  const cb = text.match(/\`\`\`(?:svg|xml)?\s*(<svg[\s\S]*?<\/svg>)/i);
  if (cb) return cb[1].trim();
  const raw = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (raw) return raw[0].trim();
  if (text.trim().startsWith('<svg')) return text.trim();
  return null;
}

async function cmdStatus() {
  console.log('Checking server at', BASE, '...');
  try {
    const prompts = await apiFetch('/api/default-prompts');
    console.log('Server OK:', prompts.length, 'default prompts available');
    const runs = await apiFetch('/api/runs');
    console.log('Runs in DB:', runs.length);
  } catch(e) {
    console.error('Server not responding:', e.message);
    process.exit(1);
  }
}

async function cmdListRuns() {
  const runs = await apiFetch('/api/runs');
  if (!runs.length) { console.log('No runs found.'); return; }
  console.log('\n' + 'ID'.padEnd(12) + 'NAME'.padEnd(35) + 'STATUS'.padEnd(12) + 'MODE'.padEnd(20) + 'GENS  CMPS');
  console.log('-'.repeat(90));
  for (const r of runs) {
    const id = r.id.slice(0,8);
    const name = (r.name||'').slice(0,33).padEnd(35);
    const status = (r.status||'').padEnd(12);
    const mode = (r.mode||'standard').padEnd(20);
    console.log(id + '  ' + name + status + mode + r.genDone+'/'+r.genTotal+'  '+r.cmpDone+'/'+r.cmpTotal);
  }
  console.log('');
}

async function cmdResults(runId) {
  if (!runId) { console.error('Usage: node cli.cjs results <run-id>'); process.exit(1); }
  // Allow short IDs
  if (runId.length < 36) {
    const runs = await apiFetch('/api/runs');
    const match = runs.find(r => r.id.startsWith(runId));
    if (!match) { console.error('Run not found:', runId); process.exit(1); }
    runId = match.id;
  }
  const data = await apiFetch('/api/runs/' + runId + '/results');
  console.log('\n== Results: ' + data.run.name + ' ==');
  console.log('Mode:', data.run.mode || 'standard');
  console.log('Models:', data.models.length, '| Prompts:', data.run.config.prompts.length, '| Comparisons:', data.comparisons.filter(c=>c.status==='complete').length);
  console.log('\nELO Leaderboard:');
  console.log('#   MODEL'.padEnd(50) + 'ELO    W/L/T');
  console.log('-'.repeat(70));
  for (const [i, row] of data.leaderboard.entries()) {
    const pos = String(i+1).padEnd(4);
    const model = (row.model||'').slice(0,44).padEnd(46);
    const elo = String(row.elo).padEnd(7);
    const wlt = `${row.wins}/${row.losses}/${row.ties}`;
    console.log(pos + model + elo + wlt);
  }
  console.log('');
  // Heatmap
  const models = data.models;
  const hm = data.heatmap;
  if (models.length >= 2) {
    console.log('Win Rate Heatmap (row vs col):');
    const header = '              ' + models.map(m => m.split('/').pop().slice(0,10).padStart(11)).join(' ');
    console.log(header);
    for (const rm of models) {
      const label = rm.split('/').pop().slice(0,12).padEnd(14);
      const cells = models.map(cm => {
        if (rm===cm) return ' N/A'.padStart(11);
        const v = hm[rm]?.[cm];
        if (v==null) return '  --'.padStart(11);
        return (Math.round(v*100)+'%').padStart(11);
      }).join(' ');
      console.log(label + cells);
    }
    console.log('');
  }
}

async function cmdTestQuick() {
  console.log('Running quick test benchmark (2 models, 2 prompts)...');
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set in .env');
    process.exit(1);
  }
  const config = {
    mode: 'standard',
    models: [
      { id: 'google/gemini-2.5-flash', reasoning_effort: null },
      { id: 'google/gemini-flash-1.5-8b', reasoning_effort: null },
    ],
    prompts: [
      { id: crypto.randomUUID(), text: 'a red circle on white background', category: 'abstract' },
      { id: crypto.randomUUID(), text: 'a simple house icon', category: 'icon' },
    ],
    judge: { model: 'google/gemini-2.5-flash', runs: 1 },
    generation: { max_tokens: 2048, temperature: 0.7 },
    name: 'CLI Quick Test',
  };

  const run = await apiFetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CLI Quick Test', config, mode: 'standard' }),
  });
  console.log('Created run:', run.id);
  await apiFetch('/api/runs/' + run.id + '/start', { method: 'POST' });
  console.log('Started. Polling for completion...');

  let completed = false;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const status = await apiFetch('/api/runs/' + run.id);
    process.stdout.write('\r  Status: ' + status.status.padEnd(12) + '  ' + i*3 + 's elapsed');
    if (['complete','error','stopped'].includes(status.status)) {
      completed = true;
      console.log('\nFinal status:', status.status);
      if (status.error) console.error('Error:', status.error);
      break;
    }
  }
  if (!completed) { console.log('\nTimeout after 360s'); return; }
  await cmdResults(run.id);
}

async function cmdTestParse() {
  console.log('Testing SVG extraction from various formats...\n');
  const tests = [
    { input: '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>', label: 'raw SVG' },
    { input: '\`\`\`svg\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n\`\`\`', label: 'svg code fence' },
    { input: '\`\`\`xml\n<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>\n\`\`\`', label: 'xml code fence' },
    { input: '\`\`\`\n<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>\n\`\`\`', label: 'plain code fence' },
    { input: '<think>I will draw a circle</think>\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>', label: 'think block + SVG' },
    { input: 'Here is your SVG:\n<svg xmlns="http://www.w3.org/2000/svg"><text>Hello</text></svg>\nHope that helps!', label: 'SVG embedded in text' },
    { input: 'Sorry, I cannot generate that.', label: 'no SVG (should return null)' },
    { input: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="0" y="0" width="400" height="400" fill="blue"/>', label: 'SVG without closing tag' },
  ];
  let pass = 0, fail = 0;
  for (const t of tests) {
    const result = extractSVG(t.input);
    const ok = t.label.includes('null') ? result === null : result !== null && result.trim().startsWith('<svg');
    const icon = ok ? '✓' : '✗';
    console.log(icon + ' ' + t.label + (result ? ' [' + result.slice(0,40).replace(/\n/g,' ') + '...]' : ' [null]'));
    if (ok) pass++; else fail++;
  }
  console.log('\n' + pass + '/' + (pass+fail) + ' tests passed');
}

async function cmdTestJudge() {
  console.log('Testing judge connectivity...');
  if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
  // Generate two minimal SVGs and call the judge via OpenRouter directly
  const fetch = (await import('node-fetch')).default;
  const svgA = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="150" fill="red"/></svg>';
  const svgB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="50" y="50" width="300" height="300" fill="blue"/></svg>';
  const pngA = 'data:image/svg+xml;base64,' + Buffer.from(svgA).toString('base64');
  const pngB = 'data:image/svg+xml;base64,' + Buffer.from(svgB).toString('base64');

  console.log('Sending comparison to judge: google/gemini-2.5-flash...');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'You are evaluating two SVG images for the prompt: "a colorful shape". Model A:' },
          { type: 'image_url', image_url: { url: pngA } },
          { type: 'text', text: 'Model B:' },
          { type: 'image_url', image_url: { url: pngB } },
          { type: 'text', text: 'Respond with ONLY JSON: {"thought_process":"...","winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"..."}' },
        ],
      }],
      max_tokens: 512,
      temperature: 0.1,
    }),
  });
  if (!res.ok) { console.error('Judge API error:', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  let parsed = {};
  try { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch(_) {}
  console.log('Judge response:');
  console.log('  Winner:', parsed.winner || '(parse failed)');
  console.log('  Scores:', parsed.model_a_score, 'vs', parsed.model_b_score);
  console.log('  Analysis:', (parsed.thought_process||'').slice(0,100));
  console.log('  Feedback:', (parsed.feedback||'').slice(0,100));
  if (parsed.winner) console.log('\nJudge test PASSED');
  else { console.log('\nJudge test FAILED (could not parse response)'); console.log('Raw:', content.slice(0,300)); }
}

const [,, cmd, ...args] = process.argv;
if (!cmd) { console.log(usage); process.exit(0); }

(async () => {
  try {
    switch(cmd) {
      case 'status': await cmdStatus(); break;
      case 'list-runs': await cmdListRuns(); break;
      case 'results': await cmdResults(args[0]); break;
      case 'test-quick': await cmdTestQuick(); break;
      case 'test-parse': await cmdTestParse(); break;
      case 'test-judge': await cmdTestJudge(); break;
      default: console.log('Unknown command:', cmd); console.log(usage); process.exit(1);
    }
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
