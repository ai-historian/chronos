import { test } from "node:test";
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions as Item } from "electron";
import { buildMenu, type MenuActions, type MenuState } from "../src/main/menu";

const models = [
  { id: "a", name: "A", provider: "p1", reasoning: true, contextWindow: 1, input: ["text"] },
  { id: "b", name: "B", provider: "p2", reasoning: false, contextWindow: 1, input: ["text"] },
] as MenuState["models"];

function mkActions(calls: string[] = []): MenuActions {
  const names = ["newWorkspace", "openWorkspace", "importSources", "closeWorkspace", "newSession", "resumeSession", "restartAgent", "showPage", "login", "toggleYolo", "toggleTree", "toggleChat", "zoomIn", "zoomOut", "zoomReset", "openDocs", "openDiscord", "reportIssue", "showLogs", "about"];
  const a: any = {};
  for (const n of names) a[n] = () => calls.push(n);
  a.openRecent = (p: string) => calls.push(`openRecent:${p}`);
  a.setModel = (p: string, i: string) => calls.push(`setModel:${p}/${i}`);
  a.setThinking = (l: string) => calls.push(`setThinking:${l}`);
  a.setTheme = (t: string) => calls.push(`setTheme:${t}`);
  return a;
}

const base: MenuState = { models, currentModel: "p2/b", thinking: "high", yolo: true, theme: "dark", hasWorkspace: true, recent: [{ path: "/w/one" }] };
const top = (m: Item[], label: string) => m.find((i) => i.label === label)!;
const sub = (i: Item): Item[] => i.submenu as Item[];
const item = (m: Item, label: string) => sub(m).find((i) => i.label === label)!;

test("top-level menus in order (linux)", () => {
  assert.deepEqual(buildMenu(mkActions(), base, "linux").map((i) => i.label), ["File", "Session", "Agent", "View", "Help"]);
});

test("darwin prepends the app menu", () => {
  const m = buildMenu(mkActions(), base, "darwin");
  assert.equal(m[0].role, "appMenu");
  assert.deepEqual(m.slice(1).map((i) => i.label), ["File", "Session", "Agent", "View", "Help"]);
});

test("model radios, current checked; click calls setModel", () => {
  const calls: string[] = [];
  const m = buildMenu(mkActions(calls), base, "linux");
  const sm = sub(item(top(m, "Agent"), "Model"));
  assert.deepEqual(sm.map((i) => [i.label, i.type, i.checked]), [["p1/a", "radio", false], ["p2/b", "radio", true]]);
  (sm[0].click as any)();
  assert.deepEqual(calls, ["setModel:p1/a"]);
});

test("empty models shows disabled placeholder", () => {
  const m = buildMenu(mkActions(), { ...base, models: [], currentModel: undefined }, "linux");
  const sm = sub(item(top(m, "Agent"), "Model"));
  assert.equal(sm.length, 1);
  assert.equal(sm[0].label, "No models — connect a provider");
  assert.equal(sm[0].enabled, false);
});

test("thinking has six radios, current checked", () => {
  const sm = sub(item(top(buildMenu(mkActions(), base, "linux"), "Agent"), "Thinking level"));
  assert.equal(sm.length, 6);
  assert.ok(sm.every((i) => i.type === "radio"));
  assert.deepEqual(sm.filter((i) => i.checked).map((i) => i.label), ["high"]);
});

test("yolo checkbox and theme radios reflect state", () => {
  const m = buildMenu(mkActions(), base, "linux");
  const y = item(top(m, "Agent"), "YOLO mode");
  assert.equal(y.type, "checkbox");
  assert.equal(y.checked, true);
  const th = sub(item(top(m, "View"), "Theme"));
  assert.deepEqual(th.map((i) => [i.label, i.checked]), [["System", false], ["Light", false], ["Dark", true]]);
});

test("open recent lists recent workspaces", () => {
  const calls: string[] = [];
  const m = buildMenu(mkActions(calls), base, "linux");
  const rec = sub(item(top(m, "File"), "Open recent"));
  assert.equal(rec[0].label, "/w/one");
  (rec[0].click as any)();
  assert.deepEqual(calls, ["openRecent:/w/one"]);
  const empty = sub(item(top(buildMenu(mkActions(), { ...base, recent: [] }, "linux"), "File"), "Open recent"));
  assert.equal(empty[0].enabled, false);
});

test("workspace-bound items disabled without a workspace", () => {
  const m = buildMenu(mkActions(), { ...base, hasWorkspace: false }, "linux");
  const file = top(m, "File");
  assert.equal(item(file, "Import sources…").enabled, false);
  assert.equal(item(file, "Close workspace").enabled, false);
  assert.notEqual(item(file, "New workspace…").enabled, false);
  assert.notEqual(item(file, "Open workspace…").enabled, false);
  for (const l of ["Session", "Agent"]) {
    assert.equal(top(m, l).enabled, false, l);
  }
  const view = top(m, "View");
  assert.equal(item(view, "Toggle file tree").enabled, false);
  assert.equal(item(view, "Toggle chat").enabled, false);
  assert.notEqual(item(view, "Theme").enabled, false);
});

test("accelerators and roles", () => {
  const m = buildMenu(mkActions(), base, "linux");
  assert.equal(item(top(m, "File"), "New workspace…").accelerator, "CmdOrCtrl+Shift+N");
  assert.equal(item(top(m, "File"), "Open workspace…").accelerator, "CmdOrCtrl+O");
  assert.equal(item(top(m, "File"), "Close workspace").accelerator, "CmdOrCtrl+Shift+W");
  assert.equal(item(top(m, "Session"), "New session").accelerator, "CmdOrCtrl+N");
  assert.equal(item(top(m, "Session"), "Restart agent").accelerator, "CmdOrCtrl+Shift+R");
  assert.equal(item(top(m, "View"), "Toggle file tree").accelerator, "CmdOrCtrl+B");
  assert.equal(item(top(m, "View"), "Toggle chat").accelerator, "CmdOrCtrl+J");
  const roles = sub(top(m, "View")).map((i) => i.role).filter(Boolean);
  assert.deepEqual(roles, ["zoomIn", "zoomOut", "resetZoom", "toggleDevTools"]);
  assert.ok(sub(top(m, "File")).some((i) => i.role === "quit"));
});

test("session, help and theme clicks call actions", () => {
  const calls: string[] = [];
  const m = buildMenu(mkActions(calls), base, "linux");
  for (const [menu, label] of [["Session", "New session"], ["Session", "Resume…"], ["Session", "Show page…"], ["Agent", "Connect AI provider"], ["Help", "Documentation"], ["Help", "Discord"], ["Help", "Report issue"], ["Help", "Show logs"], ["Help", "About"]] as const) {
    (item(top(m, menu), label).click as any)();
  }
  (sub(item(top(m, "View"), "Theme"))[1].click as any)();
  assert.deepEqual(calls, ["newSession", "resumeSession", "showPage", "login", "openDocs", "openDiscord", "reportIssue", "showLogs", "about", "setTheme:light"]);
});
