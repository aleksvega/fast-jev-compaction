import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `JEV_API_KEY` || `OPENROUTER_API_KEY` || `TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `JEV_MODEL`, else `jev-latest`. */
  model?: string;
  /** Defaults to `JEV_BASE_URL`, else the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey
      ?? process.env.JEV_API_KEY
      ?? process.env.OPENROUTER_API_KEY
      ?? process.env.TYPESAFE_API_KEY
      ?? '';
    this.model = options.model ?? process.env.JEV_MODEL;
    this.baseUrl = options.baseUrl ?? process.env.JEV_BASE_URL;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('no API key: set JEV_API_KEY (any provider), OPENROUTER_API_KEY (default) or TYPESAFE_API_KEY');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
