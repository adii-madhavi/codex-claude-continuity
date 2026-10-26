import { test } from "node:test";
import assert from "node:assert/strict";
import { wordCount } from "../src/wordCount.js";
test("wordCount", () => {
  assert.equal(wordCount("one two  three"), 3);
  assert.equal(wordCount("   "), 0);
  assert.equal(wordCount(""), 0);
});
