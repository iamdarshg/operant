/**
 * Measures WCAG 2.1 contrast for the token pairs this UI actually paints.
 * OKLCH -> OKLab -> linear sRGB -> relative luminance -> ratio.
 * usage: node design/contrast.mjs
 */

function oklchToLinearRgb([L, C, h]) {
  const hRad = (h * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

function ratio(fg, bg) {
  const a = luminance(oklchToLinearRgb(fg));
  const b = luminance(oklchToLinearRgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function srgbHex([L, C, h]) {
  const lin = oklchToLinearRgb([L, C, h]);
  return (
    '#' +
    lin
      .map((v) => {
        const c = Math.max(0, Math.min(1, v));
        const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        return Math.round(s * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

const T = {
  paper: [0.955, 0.006, 250],
  'paper-2': [0.91, 0.009, 250],
  'paper-3': [0.995, 0.005, 250],
  'paper-0': [0.975, 0.004, 250],
  ink: [0.16, 0.014, 262],
  'ink-2': [0.29, 0.014, 262],
  muted: [0.47, 0.016, 260],
  rule: [0.8, 0.011, 250],
  'ink-muted': [0.76, 0.012, 250],
  'ink-rule': [0.38, 0.014, 262],
  'ink-hover': [0.21, 0.014, 262],
  accent: [0.51, 0.22, 264],
  'accent-2': [0.81, 0.16, 82],
  'accent-ink': [0.995, 0.003, 250],
  error: [0.52, 0.19, 27],
  'error-on-ink': [0.74, 0.12, 27],
};

const PAIRS = [
  ['ink', 'paper', 'body text', 4.5],
  ['ink', 'paper-0', 'body text in a form well', 4.5],
  ['muted', 'paper', 'labels and meta', 4.5],
  ['muted', 'paper-0', 'labels inside a form well', 4.5],
  ['rule', 'paper', 'hairline divider (graphic)', 1.5],
  ['ink-muted', 'ink', 'secondary text on a plate', 4.5],
  ['accent-2', 'ink', 'figures on the board (bold 14px)', 4.5],
  ['paper', 'ink', 'body text on the board', 4.5],
  ['accent-ink', 'accent', 'primary button label', 4.5],
  ['accent', 'paper', 'focus ring drawn on paper', 3],
  ['accent-2', 'ink', 'focus ring drawn on the ink bar', 3],
  ['error', 'paper-0', 'error text on a result block', 4.5],
  ['error-on-ink', 'ink', 'error text on the tape', 4.5],
  ['ink-rule', 'ink', 'hairline inside the tape', 1.5],
];

const rows = PAIRS.map(([fg, bg, use, min]) => {
  const r = ratio(T[fg], T[bg]);
  return {
    use,
    fg: `${fg} ${srgbHex(T[fg])}`,
    bg: `${bg} ${srgbHex(T[bg])}`,
    ratio: `${r.toFixed(2)}:1`,
    min: `${min}:1`,
    under: r < min,
  };
});

console.table(rows);
const below = rows.filter((row) => row.under);
console.log(
  below.length === 0
    ? `all ${rows.length} pairs clear their threshold`
    : `${below.length} of ${rows.length} pairs are under threshold`,
);