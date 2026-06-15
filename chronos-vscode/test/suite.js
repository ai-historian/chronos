// Runs INSIDE the VS Code extension host (launched by run-ui-test.mjs).
// Asserts the chat-UI startup path end to end: command → ChronosPanel webview
// tab → pi RPC subprocess.
const vscode = require("vscode");
const { execSync } = require("node:child_process");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function findChronosTab() {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.label.startsWith("Chronos")) return tab;
    }
  }
  return undefined;
}

function piRpcProcessCount() {
  try {
    const out = execSync("pgrep -fa 'pi --mode rpc' || true", { encoding: "utf8" });
    return out.split("\n").filter((l) => l.includes("--mode rpc")).length;
  } catch {
    return 0;
  }
}

exports.run = async function run() {
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // Sanity: the dev extension is present and the setting contribution resolved
  const ext = vscode.extensions.getExtension("AI-Historian.chronos-ai-historian");
  check("extension present", !!ext, ext?.packageJSON.version);

  const uiMode = vscode.workspace.getConfiguration("chronos").get("ui");
  check("chronos.ui setting readable", uiMode === "chat", `value: ${uiMode}`);

  const api = await ext.activate();

  await vscode.commands.executeCommand("chronos.startSession");
  check("chronos.startSession executed", true);

  await waitFor("Chronos tab", () => !!findChronosTab());
  check("Chronos webview tab opened", true);

  // pi renames its process title to plain "pi", so don't pgrep — ask the
  // extension for its own status (exposed for exactly this purpose).
  await waitFor("agent ready", () => {
    const status = api.getChronosStatus();
    if (status?.agentStatus === "failed" || status?.agentStatus === "exited") {
      throw new Error(`agent ${status.agentStatus}: ${status.lastError}`);
    }
    return status?.agentStatus === "ready";
  });
  const status = api.getChronosStatus();
  check("pi RPC agent ready", true, `pid ${status?.agentPid}`);

  // The webview posts "ready" once its bundle executed without crashing
  await waitFor("webview ready handshake", () => api.getChronosStatus()?.webviewReady === true);
  check("webview bundle booted (ready handshake)", true);

  // The handshake done, make sure the subprocess stays alive
  await sleep(5000);
  const after = api.getChronosStatus();
  check("pi subprocess still alive after 5s", after?.agentStatus === "ready", after?.lastError);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} checks failed: ${failed.map((c) => c.name).join(", ")}`);
  }
};
