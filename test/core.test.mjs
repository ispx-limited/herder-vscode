import { test } from "node:test";
import assert from "node:assert/strict";
import {
  issuePosition,
  scriptDomain,
  tsStringContext,
  yamlContext,
  yamlDomains,
} from "../out/core.js";

test("yamlContext completes devicePath values", () => {
  const ctx = yamlContext('      devicePath: "Device.WiFi.SS');
  assert.deepEqual(ctx, { kind: "parameter", prefix: "Device.WiFi.SS" });
});

test("yamlContext completes canonical values", () => {
  const ctx = yamlContext('    - canonical: "canonical.mgmt.conn');
  assert.deepEqual(ctx, { kind: "canonical", prefix: "canonical.mgmt.conn" });
});

test("yamlContext ignores other keys", () => {
  assert.equal(yamlContext('  name: "Device.WiFi.SSID'), null);
});

test("tsStringContext completes inside an open string literal", () => {
  const ctx = tsStringContext('const v = device.get("Device.WiFi.Radio.1.Chan');
  assert.deepEqual(ctx, { kind: "parameter", prefix: "Device.WiFi.Radio.1.Chan" });
});

test("tsStringContext is silent outside strings and in closed ones", () => {
  assert.equal(tsStringContext("const v = Device.WiFi"), null);
  assert.equal(tsStringContext('const v = device.get("Device.WiFi.SSID")'), null);
});

test("tsStringContext completes canonical names", () => {
  const ctx = tsStringContext("device.set('canonical.mgmt.");
  assert.deepEqual(ctx, { kind: "canonical", prefix: "canonical.mgmt." });
});

const KINDS = [
  { kind: "MappingProfile", apiVersion: "mapping.herder.io/v1alpha1", domain: "mapping", schema: "mappingprofile.schema.json" },
  { kind: "TelemetryProfile", apiVersion: "telemetry.herder.io/v1alpha1", domain: "telemetry", schema: "telemetryprofile.schema.json" },
];

test("yamlDomains routes a multi-document mixed-kind buffer to each domain once", () => {
  const buffer = [
    "apiVersion: mapping.herder.io/v1alpha1",
    "kind: MappingProfile",
    "---",
    "apiVersion: telemetry.herder.io/v1alpha1",
    "kind: TelemetryProfile",
    "---",
    "apiVersion: telemetry.herder.io/v1alpha1",
    "kind: TelemetryProfile",
  ].join("\n");
  assert.deepEqual(yamlDomains(buffer, KINDS), ["mapping", "telemetry"]);
});

test("yamlDomains is empty for a non-Herder yaml", () => {
  assert.deepEqual(yamlDomains("services:\n  web:\n    image: nginx\n", KINDS), []);
});

test("scriptDomain routes by glob, first match wins, default provisioning", () => {
  const map = { "**/actions/**": "actions", "**/topology/**": "telemetry_enrichment" };
  assert.equal(scriptDomain("platform/actions/ping.ts", map), "actions");
  assert.equal(scriptDomain("platform/topology/easymesh.ts", map), "telemetry_enrichment");
  assert.equal(scriptDomain("platform/provisioning/boot.ts", map), "provisioning");
});

test("issuePosition prefers structured position, falls back to the message", () => {
  assert.deepEqual(
    issuePosition({ scope: "current_file", file: "a.ts", message: "x", line: 4, column: 2 }),
    { line: 4, column: 2 },
  );
  assert.deepEqual(
    issuePosition({
      scope: "current_file",
      file: "a.ts",
      message: "[TYPESCRIPT_TYPE_ERROR] TS2322 (1:7): Type 'string' is not assignable to type 'number'.",
      line: null,
      column: null,
    }),
    { line: 1, column: 7 },
  );
  assert.deepEqual(
    issuePosition({ scope: "bundle", file: "b.yaml", message: "duplicate name", line: null, column: null }),
    { line: 1, column: 1 },
  );
});

test("yamlContext completes the envelope keys", () => {
  assert.deepEqual(yamlContext("kind: Telem"), { kind: "resourceKind", prefix: "Telem" });
  assert.deepEqual(yamlContext("kind: "), { kind: "resourceKind", prefix: "" });
  assert.deepEqual(yamlContext("apiVersion: telemetry.her"), { kind: "apiVersion", prefix: "telemetry.her" });
  assert.equal(yamlContext("  kind: Telem"), null); // envelope keys are top-level only
});

test("issuePosition parses yaml parse-error line numbers", () => {
  assert.deepEqual(
    issuePosition({ scope: "current_file", file: "a.yaml", message: "doc 0: yaml: yaml: line 8: found unexpected end of stream", line: null, column: null }),
    { line: 8, column: 1 },
  );
});
