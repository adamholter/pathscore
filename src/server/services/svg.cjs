'use strict';

const { Resvg } = require('@resvg/resvg-js');

function extractSVG(text) {
  text = text.replace(/<think[\s\S]*?<\/think>/gi, '');
  const cb = text.match(/```(?:svg|xml)?\s*(<svg[\s\S]*?<\/svg>)/i);
  if (cb) return cb[1].trim();
  const raw = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (raw) return raw[0].trim();
  if (text.trim().startsWith('<svg')) return text.trim();
  return null;
}

function svgToPngDataUrl(svgContent) {
  try {
    const resvg = new Resvg(svgContent, {
      fitTo: { mode: 'width', value: 400 },
      background: 'white',
    });
    const png = resvg.render().asPng();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (_) {
    return `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
  }
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

module.exports = {
  extractSVG,
  svgToPngDataUrl,
  svgToDataUrl,
};
