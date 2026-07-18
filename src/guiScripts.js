import fs from "node:fs";
import path from "node:path";
import { assertInside, ensureProjectSession } from "./config.js";

function perlString(value) {
  return String(value)
    .replace(/\\/g, "/")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@");
}

export function queueScript(config, name, script) {
  ensureProjectSession(config);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const pendingDir = assertInside(config.queueDir, path.join(config.queueDir, "pending"));
  fs.mkdirSync(pendingDir, { recursive: true });
  const file = assertInside(pendingDir, path.join(pendingDir, `${stamp}_${safe}.pl`));
  fs.writeFileSync(file, script, "utf8");
  return file;
}

export function stateWriteSnippet(config, fields) {
  const stateFile = perlString(config.stateFile || path.join(config.workRoot, ".ms-mcp-state.json"));
  const json = JSON.stringify({
    ...fields,
    updatedAt: new Date().toISOString(),
  }, null, 2);
  const escaped = json
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@");
  return `
open(my $state_fh, ">", "${stateFile}") or die "Cannot write MS-MCP state: $!";
print $state_fh "${escaped}";
close($state_fh);
`;
}

export function stateWriteRuntimeDocSnippet(config, { currentExport, lastJob }) {
  const stateFile = perlString(config.stateFile || path.join(config.workRoot, ".ms-mcp-state.json"));
  const exportJson = JSON.stringify(currentExport || null)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@");
  const lastJobJson = JSON.stringify(lastJob || null)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@");
  return `
sub ms_mcp_json_escape {
  my ($value) = @_;
  $value = "" unless defined $value;
  $value =~ s/\\\\/\\\\\\\\/g;
  $value =~ s/"/\\\\"/g;
  $value =~ s/\\r/\\\\r/g;
  $value =~ s/\\n/\\\\n/g;
  return $value;
}
my $ms_mcp_doc_name = "";
eval { $ms_mcp_doc_name = $doc->Name; };
open(my $state_fh, ">", "${stateFile}") or die "Cannot write MS-MCP state: $!";
print $state_fh "{\\n";
print $state_fh "  \\"currentDocument\\": \\"" . ms_mcp_json_escape($ms_mcp_doc_name) . "\\",\\n";
print $state_fh "  \\"currentExport\\": ${exportJson},\\n";
print $state_fh "  \\"lastJob\\": ${lastJobJson},\\n";
print $state_fh "  \\"updatedAt\\": \\"" . scalar(localtime()) . "\\"\\n";
print $state_fh "}\\n";
close($state_fh);
`;
}

export function traceSnippet(config, message) {
  const traceFile = perlString(path.join(config.projectRoot || config.workRoot, "ms-mcp-trace.txt"));
  const text = perlString(message);
  return `
open(my $trace_fh, ">>", "${traceFile}") or die "Cannot write MS-MCP trace: $!";
print $trace_fh "${text} at " . scalar(localtime()) . "\\n";
close($trace_fh);
`;
}

export function documentResolverSnippet({ documentName, importPath }) {
  if (documentName) {
    const docName = perlString(documentName);
    return `
my $doc;
sub ms_mcp_try_doc {
  my ($name) = @_;
  my $candidate;
  eval { $candidate = $Documents{$name}; };
  return $candidate if $candidate;
  eval { $candidate = Documents->Item($name); };
  return $candidate if $candidate;
  return undef;
}
sub ms_mcp_is_3d_doc {
  my ($candidate) = @_;
  return 0 unless $candidate;
  my $ok = 0;
  eval { my $atoms = $candidate->Atoms; $ok = 1 if $atoms; };
  return $ok;
}
$doc = ms_mcp_try_doc("${docName}");
if (!$doc && "${docName}" !~ /\\.xsd$/i) {
  $doc = ms_mcp_try_doc("${docName}.xsd");
}
if (!$doc && "${docName}" =~ /^(.*)\\.xsd$/i) {
  $doc = ms_mcp_try_doc($1);
}
if (!$doc) {
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = 0; $i < $count; $i++) {
    my $candidate = Documents->Item($i);
    my $name = "";
    eval { $name = $candidate->Name; };
    if ($name eq "${docName}" || $name . ".xsd" eq "${docName}" || "${docName}" . ".xsd" eq $name) {
      $doc = $candidate;
      last;
    }
  }
}
die "Document not found in current GUI project: ${docName}" if !$doc;
`;
  }
  if (importPath) {
    const file = perlString(importPath);
    return `
my $doc = Documents->Import("${file}");
`;
  }
  throw new Error("documentResolverSnippet requires documentName or importPath.");
}

export function saveExportSnippet({ exportPath, save = true }) {
  const exportLine = exportPath
    ? `$doc->Export("${perlString(exportPath)}");`
    : "";
  return `
${save ? "$doc->Save;" : ""}
${exportLine}
`;
}

export function ballStickSnippet() {
  return `
eval {
  my $atoms = $doc->AsymmetricUnit->Atoms;
  foreach my $atom (@$atoms) {
    $atom->Style = "Ball and stick";
  }
};
`;
}
