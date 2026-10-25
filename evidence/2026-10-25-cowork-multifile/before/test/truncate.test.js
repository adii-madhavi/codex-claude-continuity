import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "../src/truncate.js";
test("truncate", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("", 2), "");
});
