import * as vscode from "vscode";
import { HerderClient, MetaStore } from "./api";
import {
  issuePosition,
  scriptDomain,
  tsStringContext,
  yamlContext,
  yamlDomains,
  type CompletionContext,
  type ValidationIssue,
} from "./core";

const TOKEN_KEY = "herder.apiToken";
const DEBOUNCE_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("herder");
  context.subscriptions.push(diagnostics);

  let meta = new MetaStore(config().get<string>("metaBaseUrl", ""));
  let client: HerderClient | null = null;

  // Silent-when-unconfigured wasted a real operator's evening: the
  // status bar now states the extension's mode whenever a config file
  // has focus, so "nothing happens" always has a visible reason.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  context.subscriptions.push(status);
  function updateStatus(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isConfigDocument(doc)) {
      status.hide();
      return;
    }
    if (client) {
      status.text = "Herder: ready";
      status.tooltip = `Completion and validation against ${config().get<string>("apiUrl", "")}`;
    } else {
      status.text = "Herder: set herder.apiUrl";
      status.tooltip =
        "herder.apiUrl is empty in this workspace, so API completion and validation are disabled. Envelope completion still works.";
    }
    status.show();
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus));

  async function rebuildClient(): Promise<void> {
    const url = config().get<string>("apiUrl", "").replace(/\/+$/, "");
    const token = (await context.secrets.get(TOKEN_KEY)) ?? "";
    client = url ? new HerderClient(url, token) : null;
    updateStatus();
  }
  void rebuildClient();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("herder")) {
        meta = new MetaStore(config().get<string>("metaBaseUrl", ""));
        void rebuildClient();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("herder.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Herder API token (stored in VS Code secret storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token !== undefined) {
        await context.secrets.store(TOKEN_KEY, token);
        await rebuildClient();
        vscode.window.setStatusBarMessage("Herder: token stored", 3000);
      }
    }),
    vscode.commands.registerCommand("herder.clearToken", async () => {
      await context.secrets.delete(TOKEN_KEY);
      await rebuildClient();
    }),
    vscode.commands.registerCommand("herder.validateFile", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) void validateDocument(doc);
    }),
  );

  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position) {
      const line = document.lineAt(position.line).text.slice(0, position.character);
      const ctx =
        document.languageId === "yaml" ? yamlContext(line) : tsStringContext(line);
      if (!ctx) return undefined;
      try {
        const items = await completionsFor(ctx);
        // Parameter lists are a server-side page of a much larger set;
        // marking them incomplete makes every keystroke re-query with
        // the longer prefix instead of client-filtering the first page,
        // which silently hides everything past the alphabetical head.
        return new vscode.CompletionList(items, ctx.kind === "parameter");
      } catch {
        return undefined; // completion never surfaces errors; validation does
      }
    },
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: "yaml" }, { language: "typescript" }],
      provider,
      ".",
      '"',
      "'",
    ),
  );

  async function completionsFor(ctx: CompletionContext): Promise<vscode.CompletionItem[]> {
    // Envelope completion needs only the published registry, so it
    // works before any API URL is configured.
    if (ctx.kind === "resourceKind" || ctx.kind === "apiVersion") {
      const kinds = await meta.getKinds();
      if (ctx.kind === "resourceKind") {
        return kinds.map((k) => {
          const item = new vscode.CompletionItem(k.kind, vscode.CompletionItemKind.Class);
          item.detail = `${k.apiVersion}, domain ${k.domain}`;
          return item;
        });
      }
      const seen = new Set<string>();
      return kinds
        .filter((k) => (seen.has(k.apiVersion) ? false : seen.add(k.apiVersion)))
        .map((k) => new vscode.CompletionItem(k.apiVersion, vscode.CompletionItemKind.Module));
    }
    if (ctx.kind === "canonical") {
      const names = await meta.getCanonicals();
      return names
        .filter((c) => c.name.startsWith(ctx.prefix) || ctx.prefix.length < "canonical.".length)
        .map((c) => {
          const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Constant);
          item.detail = `${c.valueType}, ${c.feature}`;
          item.documentation = c.description;
          return item;
        });
    }
    if (!client) return [];
    const suggestions = await client.suggest(ctx.prefix);
    return suggestions.map((s) => {
      const item = new vscode.CompletionItem(
        s.path,
        s.is_object ? vscode.CompletionItemKind.Module : vscode.CompletionItemKind.Field,
      );
      item.detail = s.is_object ? "object" : s.writable ? "writable" : "read-only";
      if (s.is_object) {
        // Completing a container keeps the list open for the next
        // segment, mirroring how the path is actually typed.
        item.command = { command: "editor.action.triggerSuggest", title: "" };
      }
      return item;
    });
  }

  const timers = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => void validateDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!config().get<boolean>("validateOnChange", true)) return;
      if (!isConfigDocument(e.document)) return;
      const key = e.document.uri.toString();
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => void validateDocument(e.document), DEBOUNCE_MS),
      );
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
  );

  async function validateDocument(doc: vscode.TextDocument): Promise<void> {
    if (!client || !isConfigDocument(doc)) return;
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);
    const body = doc.getText();
    let domains: string[];
    if (doc.languageId === "yaml") {
      domains = yamlDomains(body, await meta.getKinds().catch(() => []));
      if (domains.length === 0) {
        diagnostics.delete(doc.uri); // not a Herder resource file
        return;
      }
    } else {
      domains = [scriptDomain(relPath, config().get("scriptDomains", {}))];
    }
    try {
      const issues: ValidationIssue[] = [];
      for (const domain of domains) {
        const result = await client.validate(domain, body, relPath);
        issues.push(...result.errors);
      }
      diagnostics.set(doc.uri, issues.map((i) => toDiagnostic(doc, i)));
    } catch (err) {
      // Transport or auth failure is not a verdict on the buffer:
      // leave existing diagnostics alone and say what broke once.
      vscode.window.setStatusBarMessage(`Herder validate: ${String(err)}`, 5000);
    }
  }

  function toDiagnostic(doc: vscode.TextDocument, issue: ValidationIssue): vscode.Diagnostic {
    const pos = issuePosition(issue);
    const line = Math.min(Math.max(pos.line - 1, 0), doc.lineCount - 1);
    const range = issue.scope === "current_file"
      ? doc.lineAt(line).range.with({ start: new vscode.Position(line, Math.max(pos.column - 1, 0)) })
      : new vscode.Range(0, 0, 0, 0);
    const message = issue.scope === "current_file"
      ? issue.message
      : `${issue.file}: ${issue.message}`;
    const d = new vscode.Diagnostic(
      range,
      message,
      issue.scope === "current_file"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning,
    );
    d.source = "herder";
    return d;
  }
}

function isConfigDocument(doc: vscode.TextDocument): boolean {
  return (
    (doc.languageId === "yaml" || doc.languageId === "typescript") &&
    doc.uri.scheme === "file"
  );
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("herder");
}

export function deactivate(): void {}
