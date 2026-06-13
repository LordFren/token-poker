// Lightweight secret scanner — no external binaries, pure Node so it runs the
// same on every dev machine and in CI.
//
//   node scripts/secret-scan.mjs            # scan staged changes (pre-commit)
//   node scripts/secret-scan.mjs --staged   # same as above (explicit)
//   node scripts/secret-scan.mjs --all      # scan the whole tracked tree (CI)
//
// Exits non-zero (blocking the commit) if any high-signal secret pattern is
// found. Suppress a known-safe false positive by adding the marker
// `secret-scan-ok` somewhere on the same line.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOW_MARKER = "secret-scan-ok";

// High-signal patterns only — chosen to avoid noisy false positives.
const RULES = [
  { name: "Private key block", re: /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub personal token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{59,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
];

// Files we never want to scan (this scanner defines the patterns above; lock
// files and binaries are noise).
const SKIP_PATHS = new Set(["scripts/secret-scan.mjs", "package-lock.json"]);
const SKIP_EXT = /\.(jpg|jpeg|png|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|wasm|map)$/i;

const git = (args) => execFileSync("git", args, { encoding: "utf8" });

const mode = process.argv.includes("--all") ? "all" : "staged";

function files() {
  if (mode === "all") {
    return git(["ls-files"]).split("\n").filter(Boolean);
  }
  // Added/Copied/Modified/Renamed staged files (skip deletions).
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]).split("\n").filter(Boolean);
}

function contentOf(path) {
  // Scan exactly what will be committed (the staged blob), not the working tree.
  if (mode === "all") return readFileSync(path, "utf8");
  return git(["show", `:${path}`]);
}

const findings = [];

for (const path of files()) {
  if (SKIP_PATHS.has(path) || SKIP_EXT.test(path)) continue;
  let text;
  try {
    text = contentOf(path);
  } catch {
    continue; // unreadable / vanished
  }
  if (text.includes("\0")) continue; // binary (NUL byte)

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) {
        const token = m[0];
        const redacted = token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-3)}` : token;
        findings.push({ path, line: i + 1, rule: rule.name, redacted });
      }
    }
  }
}

if (findings.length === 0) {
  console.log(`secret-scan: clean (${mode}).`);
  process.exit(0);
}

console.error(`\n✖ secret-scan: ${findings.length} potential secret(s) found:\n`);
for (const f of findings) {
  console.error(`  ${f.path}:${f.line}  [${f.rule}]  ${f.redacted}`);
}
console.error(
  `\nIf a match is a false positive, add the marker "${ALLOW_MARKER}" on that line.` +
    `\nNever commit real credentials — rotate any key that was exposed.\n`,
);
process.exit(1);
