/**
 * PFP Template Designer — the production workflow.
 *
 * Every rule below was learned from a failed run, not from documentation.
 * The source of each is named so it survives being questioned later.
 *
 * ── THE DIVISION OF LABOUR ────────────────────────────────────────────────
 * MuAPI is the ORNAMENT ENGINE. It paints background, texture and brand
 * mood. It is never asked for anything a print file must be exact about.
 *
 * Evidence: nano-banana-2-1 AND nano-banana-pro were each given "exactly THREE
 * windows in a strict 3:2 aspect ratio" on the same prompt. Both returned FOUR
 * near-square windows. The $0.12 model did not fix a problem the $0.04 model
 * failed at. This is a limit of image generation, not a prompt-wording problem.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 * 1. Generate ARTWORK ONLY. No frames, no text, no logo in the shell prompt.
 *    v1 asked MuAPI for the whole template; it invented its own frames and its
 *    own "KC/C Insurance Group" logo underneath the correct ones.
 * 2. Upload client assets with POST /api/v1/upload_file, then reference the
 *    returned URL. Never invent a CDN path — a fabricated URL in the prompt is
 *    worse than no URL, because the model invents something to fill the gap.
 * 3. Even so, MuAPI will not reproduce a referenced logo faithfully. A real
 *    upload still produced "HORN" where the KCIC mark should be. Logos are
 *    therefore ALWAYS stamped from the original file, never generated.
 * 4. Grade the ornament density. "Seamless all-over field, no empty regions"
 *    guarantees ornament behind the branding; a #707070 logo then has no
 *    contrast against #707070 snowflakes. Rich at top, calm in the lower third.
 * 5. Read the palette from pixels. Colour selection is arithmetic, not
 *    judgement — a vision model adds cost, latency and variance to answer a
 *    question arithmetic answers exactly. Quantise, drop the white substrate.
 * 6. Knock out the logo's white substrate to alpha. Logos arrive as marks on a
 *    white page; printing that page drops a white rectangle on the card.
 * 7. Never upscale a logo past 1:1. The client gave us 103x93; magnifying it
 *    is what produces visible blur, and a blurred logo is a broken logo.
 * 8. Price with /models/{name}/estimate-cost, never from the run response.
 *    The run response carries no cost field — that is why early probes all
 *    reported $0.00. Dynamic pricing means 2k actually costs $0.06, not the
 *    catalogue's $0.04.
 * 9. Refuse a call that would breach the ceiling BEFORE submitting it.
 * 10. An audit failure opens a task. It never triggers an automatic retry —
 *     an unguarded loop is how an API bill becomes an incident.
 * 11. Both strips are byte-identical. The printer cuts down the middle; two
 *     different halves means the client receives two different products.
 * 12. Crop to fill, never letterbox. A print has no white margin to hide behind.
 * 13. Minor changes go to nano-banana-*-edit; only new drafts go to a
 *     text-to-image model. Edit re-decides the whole composition otherwise.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { MuAPI } from './muapi.mjs';
import { composite, CARD_W, CARD_H, WIN_W, WIN_H, FRAME_TOPS } from './pfp-compositor.mjs';

// ── Print spec (templatesbooth.com industry reference) ─────────────────────
export const PRINT = {
  cardW: 1200, cardH: 1800,      // 4x6in @ 300dpi
  stripW: 600,                    // 2x6in
  windowAspect: 3 / 2,
  framesPerStrip: 3,
};

const STYLE_BANK = {
  corporate_holiday: {
    name: 'Corporate Holiday',
    ground: '#0B3B22',
    motifs: 'stylised snowflakes and ice-crystal frost',
    accentHexes: ['#C8CBCE', '#707070', '#F06020'],
    note: 'festive, geometric, corporate',
  },
  wedding_classic: {
    name: 'Wedding Classic',
    ground: '#FDF5E6',
    motifs: 'ivory roses, soft floral lace, pearlescent shimmer',
    accentHexes: ['#D4AF37', '#FFFFFF'],
    note: 'romantic, airy, high-key. Light ground needs a DARK text colour',
  },
  wedding_rustic: {
    name: 'Wedding Rustic',
    ground: '#A68966',
    motifs: 'weathered wood grain, burlap, wild meadow flowers',
    accentHexes: ['#D4AF37', '#6B8E5A'],
    note: 'warm, organic, artisanal',
  },
  graduation_prestige: {
    name: 'Graduation Prestige',
    ground: '#002366',
    motifs: 'laurel wreaths, gold tassels, crisp geometry',
    accentHexes: ['#FFD700', '#FFFFFF'],
    note: 'academic, formal',
  },
  hoco_prom: {
    name: 'Hoco & Prom',
    ground: '#000033',
    motifs: 'bokeh light points, velvet texture, art deco diamonds',
    accentHexes: ['#D4AF37', '#F5E6C8'],
    note: 'glamour, nightlife',
  },
  celebration: {
    name: 'Birthday / Quince / Bar Mitzvah',
    ground: '#FFFFFF',
    motifs: 'confetti, balloons, celebratory scrollwork',
    accentHexes: ['#FFD700', '#E85D75'],
    note: 'bright, playful. Light ground needs a DARK text colour',
  },
};

/** Luminance decides whether type is light or dark — a fixed light fill on a
 *  light ground is invisible, and two of the six styles have light grounds. */
export function textColoursFor(groundHex) {
  const hex = groundHex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55
    ? { primary: '#1B1B1B', secondary: '#8A4B12', onLight: true }
    : { primary: '#F2F4F5', secondary: '#F06020', onLight: false };
}

/** Rule 4 — the shell prompt. Art only, graded density, brand palette in. */
export function artworkPrompt(styleId, { brandHexes = [], hasLogo = true,
                                        theme = '', palette = '', moodHexes = [] } = {}) {
  const s = STYLE_BANK[styleId];
  if (!s) throw new Error(`unknown style: ${styleId} (have: ${Object.keys(STYLE_BANK).join(', ')})`);

  const brand = brandHexes.length
    ? `Build the accent palette around the client's own brand colours ${brandHexes.join(', ')}.`
    : '';

  // The client's own words, verbatim. This is what makes "a Toy Story birthday"
  // produce something Toy Story-ish instead of the generic celebration preset —
  // and it is deliberately NOT paraphrased, because a theme is precisely the
  // part where the client's phrasing carries the meaning.
  const subject = theme
    ? `${theme} — celebrate this theme specifically and recognisably`
    : s.motifs;

  // The design reference is a picture of the LOOK, not of the words. It gets
  // its own line so it steers the background without displacing the accent
  // colours or the brand colours - those come from the invitation and the
  // logo, and a reference picture is not allowed to overwrite them.
  const mood = moodHexes && moodHexes.length
    ? `The background should carry the mood of the client's own design reference, ` +
      `whose colours are ${moodHexes.join(', ')}. Use them for the background field and ` +
      `the ornamentation, keeping the accent colours above legible against it.`
    : '';

  // An explicit palette request outranks the style default, but never the
  // client's own brand colours.
  const accents = palette || s.accentHexes.join(', ');

  return (
    `A decorative background for a photo booth template, 4x6 portrait, filling the ` +
    `entire canvas edge to edge. Ground colour ${s.ground}. The subject is ${subject} in ` +
    `${accents}. ${s.note}.\n` +
    `ORNAMENT DENSITY IS GRADED, NOT UNIFORM: the upper third is richly scattered with ` +
    `${subject}, while the lower third is a calm, almost plain field carrying only a few ` +
    `small sparse motifs, so that a logo and text sit there with clean contrast. ` +
    `This grading is required — an evenly filled field will destroy legibility.\n` +
    (brand ? brand + '\n' : '') +
    (mood ? mood + '\n' : '') +
    `ABSOLUTE PROHIBITIONS: do not draw any photo frames, rectangles, windows, borders, ` +
    `panels or placeholders of any kind. Do not draw any text, letters, numbers, words, ` +
    `logos, badges, emblems or watermarks — including any character names from the theme. ` +
    `Draw the theme as shapes, colours and motifs only. ` +
    `Background ornament only, full bleed, no margin. ` +
    (hasLogo
      ? 'The client logo is placed later by a separate deterministic step; do not attempt it.'
      : '')
  );
}

export class PFPDesigner {
  /** @param {string} apiKey  @param {{budget?:number}} [opts] */
  constructor(apiKey, { budget = 5.00 } = {}) {
    this.mu = new MuAPI(apiKey);
    this.budget = budget;
    this.shellModel = 'nano-banana-2-1';   // $0.06 at 2k. Pro costs 3x and
    this.editModel = 'nano-banana-2-1-edit';// fixes nothing structural.
  }

  /** Rule 8 — price before spending, and say what it costs. */
  async price(model, payload) {
    const c = await this.mu.estimate(model, payload);
    return { cost: c, remaining: this.budget - this.mu.spent };
  }

  /** Rule 2 — real upload, never a fabricated CDN path. */
  async hostLogo(localPath) { return this.mu.uploadFile(localPath); }

  /**
   * Rule 13 — minor changes edit; a new draft regenerates.
   *
   * `theme` is the client's own description, passed through verbatim. That
   * matters: an earlier version ignored it entirely, so a client asking for
   * "a Toy Story birthday" got the generic celebration preset back and the
   * chat looked decorative rather than functional.
   */
  async render({ kind, styleId, brandHexes = [], theme = '', palette = '',
                 moodHexes = [], shellUrl, workDir, hasLogo = true, backdropPath = null }) {
    const model = kind === 'edit' ? this.editModel : this.shellModel;

    if (kind === 'edit') {
      if (!shellUrl) throw new Error('an edit needs the shell it is editing');
      const r = await this.mu.run(model, {
        images_list: [shellUrl],
        prompt: (theme || palette)
          ? `Refine the background ornamentation to better match: ${theme || palette}. ` +
            'Preserve the layout, the window positions and the palette structure. ' +
            'Do not add frames, text or logos.'
          : 'Refine the ornamentation only. Preserve the exact palette, ' +
            'density gradient and full bleed. Do not add frames, text or logos.',
      }, { budget: this.budget });
      const f = path.join(workDir, `shell_edit_${Date.now()}.jpg`);
      await fs.writeFile(f, Buffer.from(await (await fetch(r.outputs[0])).arrayBuffer()));
      return { shellPath: f, model, cost: r.cost, reusedArt: true, backdropPath };
    }

    const payload = {
      prompt: artworkPrompt(styleId, { brandHexes, hasLogo, theme, palette, moodHexes }),
      aspect_ratio: '2:3', resolution: '2k',
    };
    const { cost } = await this.price(model, payload);
    const r = await this.mu.run(model, payload,
      { budget: this.budget, timeoutMs: 600000 });
    const f = path.join(workDir, `shell_${Date.now()}.jpg`);
    await fs.writeFile(f, Buffer.from(await (await fetch(r.outputs[0])).arrayBuffer()));
    return { shellPath: f, model, cost: r.cost, shellUrl: r.outputs[0], backdropPath };
  }

  /** Rules 1,3,6,7,11,12 — the print file. */
  async finish({ shellPath, logoPath, backdropPath, line1, line2, outPath }) {
    const res = await composite({ shellPath, logoPath, backdropPath, line1, line2, outPath });
    return { ...res, geometry: `${CARD_W}x${CARD_H}, ${FRAME_TOPS.length} windows/strip @ ${WIN_W}x${WIN_H}` };
  }

  get spent() { return this.mu.spent; }
  async balance() { return this.mu.balance; }
}

export { STYLE_BANK, composite };
export default PFPDesigner;