import { test } from "node:test";
import assert from "node:assert/strict";
import { titleCase } from "../src/titleCase.js";
test("titleCase", () => {
  assert.equal(titleCase("hello wORLD"), "Hello World");
  assert.equal(titleCase("a"), "A");
  assert.equal(titleCase(""), "");
});
