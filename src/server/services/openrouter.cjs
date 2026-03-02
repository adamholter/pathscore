'use strict';

function createOpenRouterService(config) {
  const fetchPromise = import('node-fetch').then(m => m.default);
  let modelsCache = null;
  let modelsCacheTime = 0;

  async function orFetch(path, body) {
    const fetch = await fetchPromise;
    const res = await fetch(`${config.openrouterBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pathscore.dev',
        'X-OpenRouter-Title': 'PathScore',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
    return json;
  }

  async function orStream(path, body, onChunk, signal) {
    const fetch = await fetchPromise;
    const res = await fetch(`${config.openrouterBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pathscore.dev',
        'X-OpenRouter-Title': 'PathScore',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json?.error?.message || `HTTP ${res.status}`);
    }

    let buffer = '';
    let full = '';
    let usage = null;
    for await (const chunk of res.body) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const p = JSON.parse(data);
          if (p.error) throw new Error(p.error.message);
          const delta = p.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onChunk(delta, full);
          }
          if (p.usage) usage = p.usage;
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
    return { content: full, usage };
  }

  async function getModels() {
    if (modelsCache && Date.now() - modelsCacheTime < 3600000) return modelsCache;
    const fetch = await fetchPromise;
    const res = await fetch(`${config.openrouterBase}/models`, {
      headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
    });
    const json = await res.json();
    modelsCache = (json.data || []).sort((a, b) => b.created - a.created);
    modelsCacheTime = Date.now();
    return modelsCache;
  }

  return {
    orFetch,
    orStream,
    getModels,
  };
}

module.exports = {
  createOpenRouterService,
};
