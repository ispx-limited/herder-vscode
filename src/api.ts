// Thin client for the operator's own Herder API. No vscode imports;
// the extension layer supplies base URL and token.

import type { KindMeta, ValidationIssue } from "./core";

export interface Suggestion {
  path: string;
  writable: boolean;
  is_object: boolean;
}

export interface ReservedCanonical {
  name: string;
  valueType: string;
  feature: string;
  description: string;
}

export interface ValidateResult {
  ok: boolean;
  errors: ValidationIssue[];
}

export class HerderClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  // Fleet-wide path completion across every discovered model. The
  // endpoint enforces a three-character floor; respect it here so a
  // keystroke below it costs nothing.
  async suggest(prefix: string, limit = 50): Promise<Suggestion[]> {
    if (prefix.length < 3) return [];
    const url = `${this.baseUrl}/api/v1/schema/parameters/suggest?prefix=${encodeURIComponent(prefix)}&limit=${limit}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`suggest: HTTP ${res.status}`);
    return (await res.json()) as Suggestion[];
  }

  // The distinct data-model roots of the fleet's discovered models,
  // for completing the start of a path before the suggest endpoint's
  // three-character floor is reachable.
  async modelRoots(): Promise<string[]> {
    const url = `${this.baseUrl}/api/v1/schema/models?limit=100`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`models: HTTP ${res.status}`);
    const body = (await res.json()) as { data: { root_object: string }[] };
    return [...new Set(body.data.map((m) => m.root_object).filter(Boolean))];
  }

  // Exact-parity validation: the same registry-driven validator the
  // sync path runs. An invalid buffer is a 200 with ok:false; a 4xx is
  // transport or auth, never a verdict on the content.
  async validate(domain: string, body: string, name?: string): Promise<ValidateResult> {
    const url = `${this.baseUrl}/api/v1/config/${encodeURIComponent(domain)}/validate`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(name ? { body, name } : { body }),
    });
    if (!res.ok) throw new Error(`validate(${domain}): HTTP ${res.status}`);
    return (await res.json()) as ValidateResult;
  }
}

// Registry metadata published with the JSON Schemas. Cached for the
// session: kinds and reserved canonicals change on Herder releases,
// not while an operator types.
export class MetaStore {
  private kinds: KindMeta[] | null = null;
  private canonicals: ReservedCanonical[] | null = null;

  constructor(private metaBaseUrl: string) {}

  async getKinds(): Promise<KindMeta[]> {
    if (!this.kinds) {
      this.kinds = (await this.fetchJson("kinds.json")) as KindMeta[];
    }
    return this.kinds;
  }

  async getCanonicals(): Promise<ReservedCanonical[]> {
    if (!this.canonicals) {
      this.canonicals = (await this.fetchJson("reserved-canonicals.json")) as ReservedCanonical[];
    }
    return this.canonicals;
  }

  private async fetchJson(file: string): Promise<unknown> {
    const res = await fetch(`${this.metaBaseUrl}/${file}`);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return res.json();
  }
}
