import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/pet/PetApp.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("pet status starts hidden until debug settings are loaded", () => {
  assert.match(app, /<main class="pet-shell" data-debug-mode="false"/);
});

test("live settings changes control the status display gate", () => {
  assert.match(app, /private applySettings\(settings: AppSettings\): void \{\s*this.settings = settings;\s*this.petShell.dataset.debugMode = String\(settings.debugMode\);/);
});

test("normal mode suppresses all feedback while debug mode still honors expiry", () => {
  assert.match(css, /\.pet-shell:not\(\[data-debug-mode="true"\]\) \.pet-feedback,\s*\.pet-feedback\[hidden\]\s*\{\s*display: none;\s*\}/);
  assert.match(app, /private hideFeedback\(\): void \{[^}]*this.feedback.hidden = true;/);
});
