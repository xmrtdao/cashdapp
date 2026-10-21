/**
 * MuAPI client — the correct shape of the API, learned the hard way.
 *
 * Corrections baked in after reading the real docs:
 *   * cost comes from POST /models/{name}/estimate-cost, NOT from the run
 *     response (which carries no cost field — that is why earlier probes
 *     all reported $0).
 *   * the endpoint is resolved from inspect; never assumed.
 *   * upload is POST /api/v1/upload_file and returns a hosted URL.
 *   * valid statuses are queued | pending | processing | completed | failed |
 *     cancelled. "succeeded"/"success" do not exist.
 *   * estimate-cost is dynamic: nano-banana-2-1 catalogues at $0.04 but costs
 *     $0.06 at resolution 2k. Always price before spending.
 */
import fs from 'node:fs/promises';

const HOST = 'https://api.muapi.ai';

export class MuAPI {
  constructor(apiKey) {
    if (!apiKey) throw new Error('MUAPI api key required');
    this.key = apiKey;
    this.spent = 0;
  }

  async #json(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { 'x-api-key': this.key, ...(init.headers || {}) },
    });
    const body = await res.text();
    let data;
    try { data = JSON.parse(body || '{}'); } catch { data = { raw: body.slice(0, 400) }; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url}`);
      err.status = res.status;
      err.detail = data;
      // The body travels with the error. A failed generation is usually
      // explained by the provider's own message, and losing it turns a
      // diagnosis into a guess.
      err.body = JSON.stringify(data).slice(0, 400);
      throw err;
    }
    return data;
  }

  get balance() { return this.#json(`${HOST}/api/v1/account/balance`); }

  model(name) { return this.#json(`${HOST}/api/v1/models/${name}`); }

  /** Real cost for this exact payload, before spending anything. */
  async estimate(name, payload) {
    const r = await this.#json(`${HOST}/api/v1/models/${name}/estimate-cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.cost ?? 0;
  }

  /** Host a local file so a model can fetch it. Returns the hosted URL. */
  async uploadFile(filePath) {
    const buf = await fs.readFile(filePath);
    const name = filePath.split(/[\\/]/).pop();
    const mime = /\.png$/i.test(name) ? 'image/png'
      : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), name);
    const r = await this.#json(`${HOST}/api/v1/upload_file`, { method: 'POST', body: fd });
    return r.url ?? r.image_url;
  }

  /**
   * Submit, then poll. `budgetStop` refuses to start a call that would exceed
   * the ceiling — the guard that stops an audit failure turning into a drain.
   */
  async run(name, payload, { budget = Infinity, timeoutMs = 480000, onTick } = {}) {
    const spec = await this.model(name);
    const endpoint = spec.endpoint ?? `/api/v1/${name}`;
    const cost = await this.estimate(name, payload);

    if (this.spent + cost > budget) {
      throw Object.assign(
        new Error(`budget refused: $${this.spent.toFixed(2)} spent + $${cost.toFixed(2)} > $${budget}`),
        { refused: true, cost },
      );
    }

    const sub = await this.#json(HOST + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const rid = sub.request_id ?? sub.id;
    this.spent += cost;

    // Synchronous answers skip the poll loop entirely.
    const direct = sub.outputs ?? sub.images;
    if (direct && direct.length) {
      return { model: name, requestId: rid, cost, outputs: direct, seconds: 0 };
    }

    const t0 = Date.now();
    let tick = 0;
    for (;;) {
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`timeout after ${timeoutMs}ms; request_id=${rid} (poll it later)`);
      }
      await new Promise(r => setTimeout(r, 3000));
      // The poll is where a rejected generation shows up. The body is kept,
      // because "HTTP 400" on its own does not say whether the prompt was
      // refused, the model was busy, or the request was malformed.
      let res;
      try {
        res = await this.#json(`${HOST}/api/v1/predictions/${rid}/result`);
      } catch (e) {
        const detail = String(e.body || e.message || '').slice(0, 300);
        throw Object.assign(new Error(`poll failed: ${detail}`),
                            { failed: true, requestId: rid });
      }
      if (res.status === 'completed') {
        const outputs = res.outputs ?? res.images ?? [];
        return { model: name, requestId: rid, cost, outputs,
                 seconds: Math.round((Date.now() - t0) / 1000) };
      }
      if (res.status === 'failed' || res.status === 'cancelled') {
        // Surface the provider's own error rather than retrying it away.
        throw Object.assign(new Error(`run ${res.status}: ${JSON.stringify(res.error ?? res).slice(0, 300)}`),
                            { failed: true, requestId: rid });
      }
      if (onTick && ++tick % 4 === 0) onTick(res.status);
    }
  }
}

export default MuAPI;