// Pure logic, no vscode imports, so tests run under node:test.

export type CompletionContext =
  | { kind: "canonical"; prefix: string }
  | { kind: "parameter"; prefix: string }
  | { kind: "resourceKind"; prefix: string }
  | { kind: "apiVersion"; prefix: string };

// The envelope keys complete from the kind registry, so the editor
// works without any second YAML extension.
const ENVELOPE_VALUE = /^(kind|apiVersion)\s*:\s*["']?([\w./-]*)$/;

// A dotted data-model path: at least one dot, segments of word chars
// plus the {i} instance wildcard. Three chars minimum mirrors the
// suggest endpoint's own floor.
const PARAM_PREFIX = /^[A-Za-z][\w.{}-]{2,}$/;

// YAML keys whose string values complete: devicePath and path take
// parameter paths, canonical takes canonical names.
const YAML_VALUE = /(?:^|\s)(devicePath|path|canonical)\s*:\s*["']?([^"']*)$/;

export function yamlContext(lineToCursor: string): CompletionContext | null {
  const env = ENVELOPE_VALUE.exec(lineToCursor);
  if (env) {
    return env[1] === "kind"
      ? { kind: "resourceKind", prefix: env[2] }
      : { kind: "apiVersion", prefix: env[2] };
  }
  const m = YAML_VALUE.exec(lineToCursor);
  if (!m) return null;
  const [, key, value] = m;
  if (key === "canonical") return { kind: "canonical", prefix: value };
  // The key already says this value is a parameter path, so complete
  // from the first character; the dot heuristic in classify() exists
  // only for bare string literals where nothing marks the intent.
  return { kind: "parameter", prefix: value };
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
  // YAML parse errors carry only "line N" ("yaml: line 8: found
  // unexpected end of stream"); anchoring those at line 1 paints the
  // squiggle on apiVersion while the problem is at the cursor.
  const y = /line (\d+)/.exec(issue.message);
  if (y) return { line: parseInt(y[1], 10), column: 1 };
  return { line: 1, column: 1 };
}

// Instance wildcards: templates say WANDevice.{i}., the discovered
// model stores WANDevice.1. — query a representative instance and
// graft the typed wildcard prefix back onto each result.
export function wildcardQueryPrefix(prefix: string): string {
  return prefix.replace(/\{i\}/g, "1");
}

export function templatedLabel(typedPrefix: string, queryPrefix: string, path: string): string {
  return path.startsWith(queryPrefix) ? typedPrefix + path.slice(queryPrefix.length) : path;
}

// Decode errors ("field X not found in type Y") report lines relative
// to the first line after the document's `spec:` key, not the file.
// Verified empirically: spec: at file line 5, offending field at file
// line 8, reported as line 3. Parse errors and script positions keep
// their own conventions and are handled in issuePosition.
export function decodeErrorLine(buffer: string, message: string): number | null {
  const dm = /^doc (\d+): .*decode error/.exec(message);
  const lm = /line (\d+):/.exec(message);
  if (!dm || !lm) return null;
  const docIndex = parseInt(dm[1], 10);
  const rel = parseInt(lm[1], 10);
  const lines = buffer.split("\n");
  let doc = 0;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      doc++;
      if (doc > docIndex) break;
      start = i + 1;
      continue;
    }
  }
  if (doc < docIndex) return null;
  for (let i = start; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]) && i > start) break;
    if (/^spec\s*:/.test(lines[i])) return i + 1 + rel; // 1-based file line
  }
  return null;
}
