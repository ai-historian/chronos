import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES, themeCss, resolveTheme, type ThemeName } from "../src/main/theme";

const css = readFileSync(join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");
const used = [...new Set([...css.matchAll(/var\((--vscode-[a-zA-Z-]+)/g)].map((m) => m[1]))];

test("styles.css consumes vscode variables", () => {
  assert.ok(used.length >= 20);
});

for (const name of ["light", "dark"] as ThemeName[]) {
  test(`${name} theme defines every variable used by styles.css`, () => {
    const out = themeCss(name);
    for (const v of used) {
      assert.ok(THEMES[name][v], `${v} missing in THEMES.${name}`);
      assert.ok(out.includes(`${v}:`), `${v} missing in themeCss(${name})`);
    }
    assert.ok(out.startsWith(":root{"));
  });
}

test("resolveTheme", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
