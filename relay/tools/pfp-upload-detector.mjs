/**
 * Read an uploaded file and decide what kind of event it belongs to.
 *
 * A client drops in a wedding invitation and the studio should land on a
 * wedding design without being told; a corporate logo should read as corporate.
 * The heuristic engine already knows that from words, but a picture has to be
 * LOOKED at, so this asks a vision model and then clamps its answer to the
 * styles that actually exist.
 *
 * Cost: $0.025 per read, once per upload, and only for files large enough to
 * be worth reading. That is deliberate — a 2KB logo does not need a vision
 * call, and uploading one should not quietly cost a client money.
 */
import { MuAPI } from './muapi.mjs';

const DETECT_MODEL = 'openrouter-vision';

const SYSTEM = `You classify images that a photo-booth client has uploaded.
Reply with ONLY a compact JSON object, no prose, no markdown fence:
{"kind":"invitation|logo|photo|misc","event":"wedding|graduation|homecoming|prom|corporate|holiday|birthday|quince|bar_mitzvah|unknown","palette":["#RRGGBB",...],"mood":"three words","title":"the main wording on the document, as printed","date":"the date on the document, exactly as printed","confidence":0.0-1.0}
Rules: kind=invitation for stationery with event wording. kind=logo for a
business mark or wordmark. event=unknown when the image genuinely does not say.
title and date are what the document SAYS, read off the picture itself - the
main line of wording for title, the date as printed for date. Leave both as
empty strings when the picture does not show them, and never guess them.`;

export class UploadDetector {
  constructor(apiKey) { this.mu = new MuAPI(apiKey); }

  /** Cheap pre-filter: is this file worth a vision call at all? */
  static worthReading(w, h, bytes) {
    if (bytes < 8000) return false;           // tiny file: a favicon, not a brief
    return Math.max(w, h) >= 300;             // too small to carry any context
  }

  /**
   * @returns {{kind:string,event:string,palette:string[],mood:string,
   *            title:string,date:string,confidence:number,source:string,raw?:string}}
   */
  async classify({ imageUrl, w, h, bytes, filename = '' }) {
    const fallback = {
      kind: /logo/i.test(filename) ? 'logo' : 'misc',
      event: 'unknown', palette: [], mood: '', title: '', date: '',
      confidence: 0, source: 'filename',
    };
    if (!UploadDetector.worthReading(w, h, bytes)) return fallback;

    try {
      const r = await this.mu.run(DETECT_MODEL, {
        images_list: [imageUrl],
        system_prompt: SYSTEM,
        prompt:
          'Look at this uploaded image. What kind of document or artwork is it, ' +
          'what kind of event does it relate to, what are its dominant ' +
          'colours, and what does it actually say - the main line of wording and ' +
          'the date? Reply with the JSON object only.',
        max_tokens: 400,
        temperature: 0.1,
      }, { timeoutMs: 90000 });

      const text = (r.outputs?.[0] || '').trim();
      return { ...fallback, ...extractJson(text), source: `vision:${DETECT_MODEL}` };
    } catch (e) {
      // A failed read must never block the client; fall back to the filename
      // and let the studio proceed.
      return { ...fallback, source: 'fallback', error: e.message };
    }
  }
}

/** Pull the first JSON object out of a model reply. */
function extractJson(text) {
  if (!text) return {};
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    const o = JSON.parse(body.slice(start, end + 1));
    return {
      kind: String(o.kind || 'misc'),
      event: String(o.event || 'unknown'),
      palette: Array.isArray(o.palette) ? o.palette.slice(0, 3).map(String) : [],
      mood: String(o.mood || '').slice(0, 80),
      // The wording on the document, when it can be read. A model that is
      // unsure must leave these empty rather than invent a date - a guessed
      // date on a wedding invitation is worse than no date.
      title: String(o.title || '').slice(0, 120),
      date: String(o.date || '').slice(0, 60),
      confidence: Number(o.confidence) || 0,
    };
  } catch { return {}; }
}

/** Map a detected event onto a studio style. Only real styles come back. */
export function styleForEvent(event, kind) {
  if (kind === 'logo') return 'corporate_modern';   // a business mark is a business event
  switch (String(event || '').toLowerCase()) {
    case 'wedding': return 'wedding_classic';
    case 'graduation': return 'graduation_prestige';
    case 'homecoming': case 'prom': return 'hoco_prom';
    case 'corporate': return 'corporate_modern';
    case 'holiday': return 'corporate_holiday';
    case 'birthday': case 'quince': case 'bar_mitzvah': return 'celebration';
    default: return null;                            // caller keeps the current style
  }
}

export default UploadDetector;