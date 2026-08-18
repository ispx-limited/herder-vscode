// Pure logic, no vscode imports, so tests run under node:test.

export type CompletionContext =
  | { kind: "canonical"; prefix: string }
  | { kind: "parameter"; prefix: string };

// A dotted data-model path: at least one dot, segments of word chars
// plus the {i} instance wildcard. Three chars minimum mirrors the
// suggest endpoint's own floor.
const PARAM_PREFIX = /^[A-Za-z][\w.{}-]{2,}$/;

// YAML keys whose string values complete: devicePath and path take
// parameter paths, canonical takes canonical names.
const YAML_VALUE = /(?:^|\s)(devicePath|path|canonical)\s*:\s*["']?([^"']*)$/;

export function yamlContext(lineToCursor: string): CompletionContext | null {
  const m = YAML_VALUE.exec(lineToCursor);
  if (!m) return null;
  const [, key, value] = m;
  if (key === "canonical") return { kind: "canonical", prefix: value };
  return classify(value);
}

// Inside a TS string literal, complete canonical names and parameter
// paths. The scan walks the line tracking quote state rather than
// parsing TS: good enough for single-line literals, which is what
// device.get("...") calls are.
export function tsStringContext(lineToCursor: string): CompletionContext | null {
  let quote: string | null = null;
  let start = -1;
  for (let i = 0; i < lineToCursor.length; i++) {
    const c = lineToCursor[i];
    if (quote === null && (c === '"' || c === "'" || c === "`")) {
      quote = c;
      start = i + 1;
    } else if (c === quote && lineToCursor[i - 1] !== "\\") {
      quote = null;
      start = -1;
    }
  }
  if (quote === null || start < 0) return null;
  return classify(lineToCursor.slice(start));
}

function classify(value: string): CompletionContext | null {
  if (value.startsWith("canonical.") || "canonical.".startsWith(value) && value.length >= 3) {
    return { kind: "canonical", prefix: value };
  }
  if (value.includes(".") && PARAM_PREFIX.test(value)) {
    return { kind: "parameter", prefix: value };
  }
  return null;
}

export interface KindMeta {
  kind: string;
  apiVersion: string;
  domain: string;
  schema: string;
}

// Domains of every document in a YAML buffer, in order of first
// appearance. A multi-document file of mixed kinds validates once per
// distinct domain; the caller merges diagnostics.
export function yamlDomains(buffer: string, kinds: KindMeta[]): string[] {
  const byApiVersion = new Map(kinds.map((k) => [k.apiVersion, k.domain]));
  const out: string[] = [];
  for (const m of buffer.matchAll(/^apiVersion:\s*["']?([^\s"']+)/gm)) {
    const domain = byApiVersion.get(m[1]);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

// Glob-to-domain routing for scripts. Supports ** (any depth) and *
// (one segment); first match wins, unmatched scripts default to
// provisioning, where most operator scripts live.
export function scriptDomain(relPath: string, globMap: Record<string, string>): string {
  const p = relPath.replace(/\\/g, "/");
  for (const [glob, domain] of Object.entries(globMap)) {
    if (globToRegex(glob).test(p)) return domain;
  }
  return "provisioning";
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "(?:.*)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^(?:.*/)?" + re + "$");
}

export interface ValidationIssue {
  scope: string;
  file: string;
  message: string;
  line: number | null;
  column: number | null;
}

// The transpiler reports positions inside the message text
// ("TS2322 (1:7): ..."), 1-based in operator-script space; structured
// line/column arrive null for those. Prefer structured when present.
export function issuePosition(issue: ValidationIssue): { line: number; column: number } {
  if (issue.line !== null && issue.line > 0) {
    return { line: issue.line, column: issue.column && issue.column > 0 ? issue.column : 1 };
  }
  const m = /\((\d+):(\d+)\)/.exec(issue.message);
  if (m) return { line: parseInt(m[1], 10), column: parseInt(m[2], 10) };
  return { line: 1, column: 1 };
}
