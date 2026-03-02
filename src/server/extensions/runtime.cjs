'use strict';

const { BUILTIN_EXTENSIONS } = require('./builtins.cjs');

function validateHookShape(hookType, fn) {
  if (typeof fn !== 'function') {
    throw new Error('Extension fn_body must return a function');
  }
  if (!['provider', 'judge', 'mode', 'results'].includes(hookType)) {
    throw new Error(`Unsupported hook_type: ${hookType}`);
  }
}

function compileExtension(ext, helpers, strict) {
  const hookFn = (new Function('helpers', ext.fn_body))(helpers);
  if (strict) validateHookShape(ext.hook_type, hookFn);
  return hookFn;
}

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

function createExtensionRuntime({ repos, helpers, mode = 'legacy' }) {
  let registry = { provider: null, judge: null, mode: {}, results: [] };

  function installBuiltins() {
    const now = Date.now();
    for (const ext of BUILTIN_EXTENSIONS) {
      repos.extensions.upsertBuiltin({
        id: ext.id,
        name: ext.name,
        description: ext.description,
        hookType: ext.hook_type,
        modeId: ext.mode_id,
        modeLabel: ext.mode_label,
        modeIcon: ext.mode_icon,
        modeDesc: ext.mode_desc,
        fnBody: ext.fn_body,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  function rebuild() {
    const strict = mode === 'strict';
    const exts = repos.extensions.listEnabled();
    registry = { provider: null, judge: null, mode: {}, results: [] };
    for (const ext of exts) {
      try {
        const hookFn = compileExtension(ext, helpers, strict);
        if (ext.hook_type === 'provider') {
          registry.provider = (...args) => withTimeout(Promise.resolve(hookFn(...args)), strict ? 30000 : 0, `Provider extension ${ext.name}`);
        } else if (ext.hook_type === 'judge') {
          registry.judge = (...args) => withTimeout(Promise.resolve(hookFn(...args)), strict ? 45000 : 0, `Judge extension ${ext.name}`);
        } else if (ext.hook_type === 'mode' && ext.mode_id) {
          registry.mode[ext.mode_id] = (...args) => withTimeout(Promise.resolve(hookFn(...args)), strict ? 300000 : 0, `Mode extension ${ext.name}`);
        } else if (ext.hook_type === 'results') {
          registry.results.push({ name: ext.name, fn: hookFn });
        }
      } catch (e) {
        console.warn(`[ext] ${ext.name}: ${e.message}`);
      }
    }
  }

  function invoke(type, payload) {
    if (type === 'provider') return registry.provider?.(...payload) || null;
    if (type === 'judge') return registry.judge?.(...payload) || null;
    if (type === 'mode') return registry.mode[payload.modeId]?.(...payload.args) || null;
    if (type === 'results') return registry.results;
    return null;
  }

  return {
    installBuiltins,
    rebuild,
    getRegistry: () => registry,
    invoke,
  };
}

module.exports = {
  createExtensionRuntime,
};
