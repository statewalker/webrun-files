/**
 * Glob → RegExp compiler.
 *
 * TypeScript port of `glob-to-regexp` by Nick Fitzgerald.
 *
 * Upstream:
 *   - https://github.com/fitzgen/glob-to-regexp
 *   - source: https://raw.githubusercontent.com/fitzgen/glob-to-regexp/master/index.js
 *   - tests:  https://raw.githubusercontent.com/fitzgen/glob-to-regexp/master/test.js
 *
 * The original is published under the BSD 2-Clause license — see the
 * upstream repository for the full text. This port preserves the original
 * semantics; only the surface API has been re-typed for TypeScript.
 */

export interface GlobToRegExpOptions {
  /**
   * Enable bash-style extended globs. When `true`:
   *
   * - `?` matches exactly one character.
   * - `[abc]` / `[a-z]` matches a single character in the set / range.
   * - `{foo,bar}` matches one of the alternatives.
   *
   * When `false` (default), each of these characters is treated literally
   * (they are escaped in the output regexp).
   */
  extended?: boolean;

  /**
   * Enable bash-style globstar semantics for `*` and `**`.
   *
   * - With `globstar: false` (default), every run of `*`s is translated to
   *   `.*` — so `*` matches any number of characters, including `/`.
   * - With `globstar: true`, a single `*` only matches within one path
   *   segment (`[^/]*`), and a `**` segment (`**` between `/`s, or at the
   *   start/end of the pattern) matches zero or more whole segments.
   */
  globstar?: boolean;

  /**
   * RegExp flags passed to the `RegExp` constructor. When `flags` includes
   * `"g"`, the produced regexp is **not** anchored with `^…$`, so the glob
   * matches anywhere in the string instead of the whole string.
   */
  flags?: string;
}

/**
 * Compiles a glob pattern into a `RegExp`.
 *
 * @example
 * ```ts
 * globToRegExp("*.js");                       // /^.*\.js$/
 * globToRegExp("*.js", { globstar: true });   // /^([^/]*)\.js$/
 * globToRegExp("/foo/**", { globstar: true }) // /^\/foo\/((?:[^/]*(?:\/|$))*)$/
 * globToRegExp("foo{bar,baz}", { extended: true }); // /^foo(bar|baz)$/
 * ```
 */
export function globToRegExp(glob: string, opts: GlobToRegExpOptions = {}): RegExp {
  if (typeof glob !== "string") {
    throw new TypeError("Expected a string");
  }

  const str = String(glob);

  // The regexp we are building, as a string.
  let reStr = "";

  // Whether we are matching so called "extended" globs (like bash) and
  // should support single character matching, matching ranges of
  // characters, group matching, etc.
  const extended = !!opts.extended;

  // Globstar semantics for `*` / `**`.
  // - false: '/foo/*' becomes '^/foo/.*$' (matches '/foo/bar' AND '/foo/bar/baz')
  // - true:  '/foo/*' becomes '^/foo/[^/]*$' (matches '/foo/bar' only)
  //          '/foo/**' (with globstar=true) means "any depth under /foo".
  const globstar = !!opts.globstar;

  // True while inside an extended `{a,b}` group. Used to translate `,`.
  let inGroup = false;

  // RegExp flags passed straight through to the RegExp constructor.
  const flags = typeof opts.flags === "string" ? opts.flags : "";

  for (let i = 0; i < str.length; i++) {
    const c = str[i];

    switch (c) {
      case "/":
      case "$":
      case "^":
      case "+":
      case ".":
      case "(":
      case ")":
      case "=":
      case "!":
      case "|":
        reStr += `\\${c}`;
        break;

      case "?":
        reStr += extended ? "." : `\\${c}`;
        break;

      case "[":
      case "]":
        reStr += extended ? c : `\\${c}`;
        break;

      case "{":
        if (extended) {
          inGroup = true;
          reStr += "(";
        } else {
          reStr += `\\${c}`;
        }
        break;

      case "}":
        if (extended) {
          inGroup = false;
          reStr += ")";
        } else {
          reStr += `\\${c}`;
        }
        break;

      case ",":
        if (inGroup) {
          reStr += "|";
        } else {
          reStr += `\\${c}`;
        }
        break;

      case "*": {
        // Coalesce consecutive "*"s and remember the surrounding chars so
        // we can decide whether this run is a "globstar" segment.
        const prevChar = str[i - 1];
        let starCount = 1;
        while (str[i + 1] === "*") {
          starCount++;
          i++;
        }
        const nextChar = str[i + 1];

        if (!globstar) {
          // globstar disabled: any number of "*" maps to ".*".
          reStr += ".*";
        } else {
          const isGlobstar =
            starCount > 1 && // multiple "*"s
            (prevChar === "/" || prevChar === undefined) && // segment start
            (nextChar === "/" || nextChar === undefined); // segment end

          if (isGlobstar) {
            // Match zero or more whole path segments.
            reStr += "((?:[^/]*(?:\\/|$))*)";
            i++; // consume the trailing "/"
          } else {
            // Match within one path segment only.
            reStr += "([^/]*)";
          }
        }
        break;
      }

      default:
        reStr += c;
    }
  }

  // When the "g" flag is set, leave the regexp un-anchored so the caller
  // can match the glob anywhere within a longer string.
  if (!flags?.includes("g")) {
    reStr = `^${reStr}$`;
  }

  return new RegExp(reStr, flags);
}
