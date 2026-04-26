/**
 * Tests for `globToRegExp`.
 *
 * The "upstream parity" suite is a faithful port of the original test
 * file from https://github.com/fitzgen/glob-to-regexp
 * (https://raw.githubusercontent.com/fitzgen/glob-to-regexp/master/test.js).
 *
 * Additional vitest-flavored cases at the bottom cover edge behavior and
 * the option/flag matrix more explicitly.
 */

import { describe, expect, it } from "vitest";
import type { GlobToRegExpOptions } from "../src/index.js";
import { globToRegExp } from "../src/index.js";

function assertMatch(glob: string, str: string, opts?: GlobToRegExpOptions): void {
  expect(globToRegExp(glob, opts).test(str)).toBe(true);
}

function assertNotMatch(glob: string, str: string, opts?: GlobToRegExpOptions): void {
  expect(globToRegExp(glob, opts).test(str)).toBe(false);
}

// ---------------------------------------------------------------
// Upstream parity — ported from fitzgen/glob-to-regexp test.js
// ---------------------------------------------------------------

describe.each([
  { name: "globstar=false", globstar: false },
  { name: "globstar=true", globstar: true },
])("upstream parity ($name)", ({ globstar }) => {
  it("matches everything (single *)", () => {
    assertMatch("*", "foo");
    assertMatch("*", "foo", { flags: "g" });
  });

  it("matches the end (f*)", () => {
    assertMatch("f*", "foo");
    assertMatch("f*", "foo", { flags: "g" });
  });

  it("matches the start (*o)", () => {
    assertMatch("*o", "foo");
    assertMatch("*o", "foo", { flags: "g" });
  });

  it("matches the middle (f*uck)", () => {
    assertMatch("f*uck", "firetruck");
    assertMatch("f*uck", "firetruck", { flags: "g" });
  });

  it("anchors without 'g' flag, free-floats with it", () => {
    assertNotMatch("uc", "firetruck");
    assertMatch("uc", "firetruck", { flags: "g" });
  });

  it("matches zero characters (f*uck → fuck)", () => {
    assertMatch("f*uck", "fuck");
    assertMatch("f*uck", "fuck", { flags: "g" });
  });

  it("more complex matches", () => {
    assertMatch("*.min.js", "http://example.com/jquery.min.js", { globstar: false });
    assertMatch("*.min.*", "http://example.com/jquery.min.js", { globstar: false });
    assertMatch("*/js/*.js", "http://example.com/js/jquery.min.js", { globstar: false });
  });

  it("more complex matches with 'g' flag", () => {
    assertMatch("*.min.*", "http://example.com/jquery.min.js", { flags: "g" });
    assertMatch("*.min.js", "http://example.com/jquery.min.js", { flags: "g" });
    assertMatch("*/js/*.js", "http://example.com/js/jquery.min.js", { flags: "g" });
  });

  it("escapes regexp meta-characters in the glob", () => {
    // Glob source represents:  \\/$^+?.()=!|{},[].*
    const testStr = "\\\\/$^+?.()=!|{},[].*";
    const targetStr = "\\/$^+?.()=!|{},[].*";
    assertMatch(testStr, targetStr);
    assertMatch(testStr, targetStr, { flags: "g" });
  });

  it("anchored vs free-floating equivalents", () => {
    assertNotMatch(".min.", "http://example.com/jquery.min.js");
    assertMatch("*.min.*", "http://example.com/jquery.min.js");
    assertMatch(".min.", "http://example.com/jquery.min.js", { flags: "g" });

    assertNotMatch("http:", "http://example.com/jquery.min.js");
    assertMatch("http:*", "http://example.com/jquery.min.js");
    assertMatch("http:", "http://example.com/jquery.min.js", { flags: "g" });

    assertNotMatch("min.js", "http://example.com/jquery.min.js");
    assertMatch("*.min.js", "http://example.com/jquery.min.js");
    assertMatch("min.js", "http://example.com/jquery.min.js", { flags: "g" });
  });

  it("free-floating ('g') matches anywhere in the string", () => {
    assertMatch("min", "http://example.com/jquery.min.js", { flags: "g" });
    assertMatch("/js/", "http://example.com/js/jquery.min.js", { flags: "g" });

    assertNotMatch("/js*jq*.js", "http://example.com/js/jquery.min.js");
    assertMatch("/js*jq*.js", "http://example.com/js/jquery.min.js", { flags: "g" });
  });

  // ---- extended ---------------------------------------------------

  it("extended ?: match exactly one character", () => {
    assertMatch("f?o", "foo", { extended: true });
    assertNotMatch("f?o", "fooo", { extended: true });
    assertNotMatch("f?oo", "foo", { extended: true });
  });

  it("extended ?: with 'g' flag", () => {
    assertMatch("f?o", "foo", { extended: true, globstar, flags: "g" });
    assertMatch("f?o", "fooo", { extended: true, globstar, flags: "g" });
    assertMatch("f?o?", "fooo", { extended: true, globstar, flags: "g" });
    assertNotMatch("?fo", "fooo", { extended: true, globstar, flags: "g" });
    assertNotMatch("f?oo", "foo", { extended: true, globstar, flags: "g" });
    assertNotMatch("foo?", "foo", { extended: true, globstar, flags: "g" });
  });

  it("extended []: character ranges", () => {
    assertMatch("fo[oz]", "foo", { extended: true });
    assertMatch("fo[oz]", "foz", { extended: true });
    assertNotMatch("fo[oz]", "fog", { extended: true });
  });

  it("extended []: with 'g' flag (regression)", () => {
    assertMatch("fo[oz]", "foo", { extended: true, globstar, flags: "g" });
    assertMatch("fo[oz]", "foz", { extended: true, globstar, flags: "g" });
    assertNotMatch("fo[oz]", "fog", { extended: true, globstar, flags: "g" });
  });

  it("extended {}: choice of substrings", () => {
    assertMatch("foo{bar,baaz}", "foobaaz", { extended: true });
    assertMatch("foo{bar,baaz}", "foobar", { extended: true });
    assertNotMatch("foo{bar,baaz}", "foobuzz", { extended: true });
    assertMatch("foo{bar,b*z}", "foobuzz", { extended: true });
  });

  it("extended {}: with 'g' flag (regression)", () => {
    assertMatch("foo{bar,baaz}", "foobaaz", { extended: true, globstar, flags: "g" });
    assertMatch("foo{bar,baaz}", "foobar", { extended: true, globstar, flags: "g" });
    assertNotMatch("foo{bar,baaz}", "foobuzz", { extended: true, globstar, flags: "g" });
    assertMatch("foo{bar,b*z}", "foobuzz", { extended: true, globstar, flags: "g" });
  });

  it("complex extended pattern", () => {
    assertMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://foo.baaz.com/jquery.min.js", {
      extended: true,
    });
    assertMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.buzz.com/index.html", {
      extended: true,
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.buzz.com/index.htm", {
      extended: true,
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.bar.com/index.html", {
      extended: true,
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://flozz.buzz.com/index.html", {
      extended: true,
    });
  });

  it("complex extended pattern with 'g' flag (regression)", () => {
    assertMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://foo.baaz.com/jquery.min.js", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.buzz.com/index.html", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.buzz.com/index.htm", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://moz.bar.com/index.html", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertNotMatch("http://?o[oz].b*z.com/{*.js,*.html}", "http://flozz.buzz.com/index.html", {
      extended: true,
      globstar,
      flags: "g",
    });
  });

  it("globstar (when enabled) matches across path segments", () => {
    assertMatch("http://foo.com/**/{*.js,*.html}", "http://foo.com/bar/jquery.min.js", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertMatch("http://foo.com/**/{*.js,*.html}", "http://foo.com/bar/baz/jquery.min.js", {
      extended: true,
      globstar,
      flags: "g",
    });
    assertMatch("http://foo.com/**", "http://foo.com/bar/baz/jquery.min.js", {
      extended: true,
      globstar,
      flags: "g",
    });
  });

  it("escapes remaining special chars (no extended)", () => {
    // Glob source represents:  \\/$^+.()=!|,.*
    const testExtStr = "\\\\/$^+.()=!|,.*";
    const targetExtStr = "\\/$^+.()=!|,.*";
    assertMatch(testExtStr, targetExtStr, { extended: true });
    assertMatch(testExtStr, targetExtStr, { extended: true, globstar, flags: "g" });
  });
});

// ---------------------------------------------------------------
// Globstar-specific tests — ported one-for-one from upstream
// ---------------------------------------------------------------

describe("globstar specifics", () => {
  it("/foo/* matches direct children only", () => {
    assertMatch("/foo/*", "/foo/bar.txt", { globstar: true });
    assertNotMatch("/foo/*", "/foo/bar/baz.txt", { globstar: true });
    assertNotMatch("/foo/*.txt", "/foo/bar/baz.txt", { globstar: true });
  });

  it("/foo/** matches at any depth", () => {
    assertMatch("/foo/**", "/foo/baz.txt", { globstar: true });
    assertMatch("/foo/**", "/foo/bar/baz.txt", { globstar: true });
  });

  it("/foo/*/*.txt matches exactly one segment in the middle", () => {
    assertMatch("/foo/*/*.txt", "/foo/bar/baz.txt", { globstar: true });
    assertNotMatch("/foo/*/*.txt", "/foo/bar/baz/qux.txt", { globstar: true });
  });

  it("/foo/**/*.txt matches at any depth", () => {
    assertMatch("/foo/**/*.txt", "/foo/bar/baz.txt", { globstar: true });
    assertMatch("/foo/**/*.txt", "/foo/bar/baz/qux.txt", { globstar: true });
    assertMatch("/foo/**/*.txt", "/foo/bar.txt", { globstar: true });
  });

  it("/foo/**/bar.txt matches at any depth (and zero depth)", () => {
    assertMatch("/foo/**/bar.txt", "/foo/bar.txt", { globstar: true });
    assertMatch("/foo/**/**/bar.txt", "/foo/bar.txt", { globstar: true });
  });

  it("/foo/**/*/baz.txt matches", () => {
    assertMatch("/foo/**/*/baz.txt", "/foo/bar/baz.txt", { globstar: true });
    assertNotMatch("/foo/*/bar.txt", "/foo/bar.txt", { globstar: true });
    assertNotMatch("/foo/*/*/baz.txt", "/foo/bar/baz.txt", { globstar: true });
  });

  it("/foo/**/**/*.txt matches at any depth", () => {
    assertMatch("/foo/**/**/*.txt", "/foo/bar.txt", { globstar: true });
  });

  it("/foo/**/*/*.txt matches", () => {
    assertMatch("/foo/**/*/*.txt", "/foo/bar/baz.txt", { globstar: true });
  });

  it("**/*.txt matches anywhere", () => {
    assertMatch("**/*.txt", "/foo/bar/baz/qux.txt", { globstar: true });
    assertMatch("**/foo.txt", "foo.txt", { globstar: true });
    assertMatch("**/*.txt", "foo.txt", { globstar: true });
  });

  it("partial globstar ('foo/**.txt' / 'bar**') does not span segments", () => {
    assertNotMatch("/foo/**.txt", "/foo/bar/baz/qux.txt", { globstar: true });
    assertNotMatch("/foo/bar**/*.txt", "/foo/bar/baz/qux.txt", { globstar: true });
    assertNotMatch("/foo/bar**", "/foo/bar/baz.txt", { globstar: true });
  });

  it("**/.txt requires a leading dot in the basename", () => {
    assertNotMatch("**/.txt", "/foo/bar/baz/qux.txt", { globstar: true });
  });

  it("*/*.txt requires exactly one parent segment", () => {
    assertNotMatch("*/*.txt", "/foo/bar/baz/qux.txt", { globstar: true });
    assertNotMatch("*/*.txt", "foo.txt", { globstar: true });
  });

  it("http://foo.com/* with globstar=true does not cross /", () => {
    assertNotMatch("http://foo.com/*", "http://foo.com/bar/baz/jquery.min.js", {
      extended: true,
      globstar: true,
    });
    assertNotMatch("http://foo.com/*", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: true,
    });
  });

  it("http://foo.com/* with globstar=false crosses /", () => {
    assertMatch("http://foo.com/*", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: false,
    });
  });

  it("http://foo.com/** with globstar=true crosses /", () => {
    assertMatch("http://foo.com/**", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: true,
    });
  });

  it("explicit segment counts work both with and without globstar", () => {
    assertMatch("http://foo.com/*/*/jquery.min.js", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: true,
    });
    assertMatch("http://foo.com/**/jquery.min.js", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: true,
    });
    assertMatch("http://foo.com/*/*/jquery.min.js", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: false,
    });
    assertMatch("http://foo.com/*/jquery.min.js", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: false,
    });
    assertNotMatch("http://foo.com/*/jquery.min.js", "http://foo.com/bar/baz/jquery.min.js", {
      globstar: true,
    });
  });
});

// ---------------------------------------------------------------
// Vitest-only edge cases
// ---------------------------------------------------------------

describe("globToRegExp — edge cases", () => {
  it("rejects non-string input", () => {
    // @ts-expect-error: deliberately wrong type
    expect(() => globToRegExp(123)).toThrow(TypeError);
    // @ts-expect-error: deliberately wrong type
    expect(() => globToRegExp(null)).toThrow(TypeError);
  });

  it("default options are equivalent to globstar=false, extended=false", () => {
    expect(globToRegExp("*").source).toBe(globToRegExp("*", {}).source);
    expect(globToRegExp("*").flags).toBe(globToRegExp("*", {}).flags);
  });

  it("empty glob produces a regexp that only matches the empty string", () => {
    const re = globToRegExp("");
    expect(re.test("")).toBe(true);
    expect(re.test("x")).toBe(false);
  });

  it("with 'g' flag the regexp is unanchored", () => {
    const re = globToRegExp("foo", { flags: "g" });
    expect(re.source.startsWith("^")).toBe(false);
    expect(re.source.endsWith("$")).toBe(false);
    expect(re.flags).toContain("g");
  });

  it("non-'g' flags are still passed through and the regexp stays anchored", () => {
    const re = globToRegExp("foo", { flags: "i" });
    expect(re.source.startsWith("^")).toBe(true);
    expect(re.source.endsWith("$")).toBe(true);
    expect(re.flags).toContain("i");
    expect(re.test("FOO")).toBe(true); // case-insensitive
  });
});
