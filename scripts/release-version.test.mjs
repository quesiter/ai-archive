import assert from "node:assert/strict";
import {test} from "node:test";
import {isCanonicalReleaseVersion, nextReleaseVersion} from "./release-version.mjs";

for (const [current, next] of [["2.4.8","2.4.9"],["2.4.9","2.5.0"],["2.9.9","3.0.0"],["2.5.2","2.5.3"],["9.9.9","10.0.0"]]) {
  test(`${current} increments to ${next}`, () => assert.equal(nextReleaseVersion(current), next));
}

test("rejects overflowing segments and noncanonical version strings", () => {
  for (const invalid of ["2.4.12","2.10.0","02.5.2","2.5","V2.5.2","2.5.2-beta",null]) {
    assert.equal(isCanonicalReleaseVersion(invalid), false);
    assert.throws(() => nextReleaseVersion(invalid));
  }
});

test("rejects unsafe major values and overflow", () => {
  assert.equal(isCanonicalReleaseVersion("9007199254740992.0.0"), false);
  assert.throws(() => nextReleaseVersion("9007199254740991.9.9"));
});
