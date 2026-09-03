# How to scan for the "HiddenSpawn" supply-chain compromise

## What this is

A real, active malware pattern found across multiple GitHub repositories in
August 2026. It hides an obfuscated backdoor inside an otherwise-normal-looking
source file (often a build config like `vite.config.js`, `postcss.config.mjs`,
`tailwind.config.mjs`, or a plugin/adapter file). Windows Defender identifies
it as `Trojan:NPM/HiddenSpawn.IAF!MTB`. It has appeared in commits authored by
both bots (`github-actions[bot]`, or a project's own release bot) and human
identities, so authorship alone does not clear a commit.

## How to recognize it

The payload is appended to a legitimate file, usually as a single extremely
long line, often preceded by lots of blank padding so it never appears on
screen in a normal editor or diff view. Once decoded, it always does the same
five things, in order:

1. **Finds a command-and-control (C2) server address hidden on the Ethereum
   blockchain.** It queries several public Ethereum RPC endpoints (things
   like `1rpc.io`, `drpc.org`, `publicnode.com`, `blastapi.io`, or an
   Etherscan/Blockscout-style API) for the most recent transaction sent from
   one specific hardcoded wallet address. It decodes the recipient field of
   that transaction as an IP address. This is the "dead drop" -- the attacker
   controls the C2 IP by simply sending a new transaction from that wallet.
2. **Fetches a payload from that IP** over plain HTTP, using a spoofed Chrome
   User-Agent header.
3. **Decodes the payload** with a simple XOR cipher.
4. **Executes it** via `eval()`.
5. **Persists it** by spawning a detached background `node -e <payload>`
   process, so it keeps running even after the original process exits.

Every module name and string literal in the payload is written as Unicode
escapes (e.g. `require("http")` instead of
`require("http")`) specifically to defeat a plain-text search for words like
"http", "spawn", or "child_process".

## How to scan for it (any language/OS, no special tools required)

### 1. Look for size/line-count mismatch

A file whose byte size is wildly out of proportion to its line count is the
single strongest tell -- the padding-plus-one-huge-line shape cannot hide from
this check, even with full Unicode-escape obfuscation.

```sh
# Any tracked JS/config file where bytes-per-line is abnormally high
git ls-tree -r HEAD --name-only | grep -E '\.(js|mjs|cjs|ts)$' | while read f; do
  bytes=$(git cat-file -s "HEAD:$f" 2>/dev/null)
  lines=$(git show "HEAD:$f" 2>/dev/null | wc -l)
  [ -n "$bytes" ] && [ -n "$lines" ] && [ "$lines" -gt 0 ] && \
    ratio=$((bytes / lines)) && [ "$ratio" -gt 300 ] && echo "$f  ratio=$ratio"
done
```

A ratio over ~150-300 bytes/line on an ordinary hand-written source file is
suspicious. (Legitimate minified/bundled/generated files are the known
exception -- judge those in context, e.g. a `dist/` bundle is expected to be
dense; a `vite.config.js` or `tailwind.config.mjs` is not.)

### 2. Detect the Unicode-escape obfuscation itself, not just today's payload

The literal C2 IP and wallet address in step 3 below WILL change in the next
variant -- they are trivial for an attacker to rotate. What does NOT change
cheaply is the obfuscation *technique*: writing ordinary ASCII identifiers
like `require`, `http`, `child_process`, `spawn` as a run of `\uXXXX` escapes
so a plain-text search for those words never matches. This is the part worth
detecting generically, because it generalizes to a completely unseen variant
with a different IP, a different wallet, even a different C2 mechanism
entirely -- as long as it still uses this specific evasion trick.

Real source code almost never contains more than one or two `\uXXXX` escapes
in a row (a genuine Unicode literal is usually a single character, e.g. an
emoji or accented letter in a UI string). A *dense run* of many consecutive
`\uXXXX` escapes -- especially ones that decode to plain ASCII letters, which
have no legitimate reason to ever be escaped -- is the tell:

**Prefer the JS version below as primary -- it is the one actually verified
against a real sample.** The shell `grep` version is included for a quick
first pass but its exact escaping is shell/grep-implementation-dependent (in
particular, MSYS/Git-Bash's `grep` on Windows requires doubling the
backslash in the pattern compared to a standard POSIX `grep` -- if the
one-backslash form below reports nothing on a file you positively know
contains escapes, try doubling every `\\` to `\\\\` before concluding your
tree is clean):

```sh
# Flag any line with 4+ consecutive \uXXXX escapes (a real single Unicode
# literal is 1, occasionally 2-3; 4+ back-to-back is not normal hand-written
# code under any circumstance). Verify this actually fires on your system
# with a known-escaped test string before trusting a clean result from it.
grep -rnE '(\\u[0-9a-fA-F]{4}){4,}' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.ts' .
# If that reports nothing but you expect a hit, your grep needs doubled backslashes:
grep -rnE '(\\\\u[0-9a-fA-F]{4}){4,}' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.ts' .
```

```js
// Verified working against 4 real cases: a real escaped malicious
// identifier (true positive), a genuine non-ASCII Unicode literal (true
// negative), a plain file with no escapes (true negative), and -- caught
// during live verification of this exact scanner -- a legitimate escaped
// CSS-selector-punctuation string like ",./:" found in a real npm package,
// which a looser "decodes to printable ASCII" check wrongly flagged (fixed
// by requiring identifier shape instead). Decodes every \uXXXX run of
// 4-or-more found in a row and checks whether it spells out something
// IDENTIFIER-shaped (letters/digits/underscore, starting with a letter) --
// an obfuscated module name like "http" or "child_process" is always
// identifier-shaped; arbitrary escaped punctuation/data is not.
function findSuspiciousEscapes(src) {
  const hits = [];
  const re = /(?:\\u[0-9a-fA-F]{4}){4,}/g;
  let m;
  while ((m = re.exec(src))) {
    const decoded = m[0].replace(/\\u([0-9a-fA-F]{4})/g,
      (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    if (/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(decoded)) hits.push({ at: m.index, decoded });
  }
  return hits;
}

// Run over every file's text, e.g.:
// import { readFileSync } from 'fs';
// const hits = findSuspiciousEscapes(readFileSync(path, 'utf8'));
// if (hits.length) console.log(path, hits);
```

Run this across every tracked source file (and `node_modules` after an
install). A hit means: decode it and read what it actually says before
deciding it's malicious -- but a dense run of ASCII-decoding `\uXXXX` escapes
sitting in a `.js`/`.mjs`/`.ts` file is not something normal tooling,
bundlers, or human authors ever produce, so treat any hit as a required
manual review, not a false-positive to dismiss by default.

### 3. Grep for the literal signature strings (today's known variant)

These are the fixed markers every observed sample has used so far. A hit on
any of these in a file that has no legitimate reason to touch networking or
child processes is a confirmed compromise, not a maybe:

```sh
grep -rn '166\.88\.134\.62\|global\._t_s\|global\._t_u\|0xa322e5f3d311d3080e6f0121063e9adc2490ef1a' .
grep -rn 'spawn(.node.,\[.-e.' .
```

(The IP and wallet address are the two specific values seen in confirmed
samples as of this writing -- they may change in future variants, so steps 1
and 2 above are the durable long-term detectors. Update these literals if
you find a new variant using a different address/IP.)

### 4. If a read gets blocked, that IS the finding

If your antivirus (Windows Defender or otherwise) refuses to let you open,
copy, or `cat` a specific file -- especially with a message like "the file
contains a virus or potentially unwanted software" -- do not work around it
with an exclusion and move on. Treat the block itself as a positive result.
Investigate that exact file via your git provider's raw content API (GitHub:
`gh api repos/<owner>/<repo>/contents/<path>?ref=<sha> --jq '.content' |
base64 -d`), which reads the bytes without touching your local antivirus at
all, so you can inspect it safely.

### 5. Check whether it reached your dependencies, not just your own repo

Run the same two checks against `node_modules` after an install, and against
any GitHub-sourced dependency (`"pkg": "github:owner/repo#main"` in
`package.json`, or any CI step that does `npx --yes <pkg>@latest` or
`npm install <pkg>` with no version pin). An unpinned dependency is exactly
how this spreads -- a compromised commit on someone else's `main` branch
reaches every consumer's next install automatically, with no code change on
the consumer's side.

## If you find a real hit

1. **Do not panic-delete or panic-exclude.** Get the exact introducing commit
   first: walk that file's commit history (`git log --oneline -- <path>` or
   the GitHub API equivalent) from oldest to newest, checking each version
   against steps 1-2 above, until you find the first commit where it appears.
   The commit right before that one is your known-clean baseline.
2. **Check whether the introducing commit ALSO made real, legitimate
   changes** to the same file, separate from the payload. Diff the clean
   baseline against the compromised commit's *visible* content (ignore the
   huge padded line). If the legitimate diff is trivial or purely cosmetic
   (a needless `createRequire` wrapper is a common camouflage addition),
   restore the whole file to the clean baseline. If the commit made real,
   substantive improvements you don't want to lose, strip out only the
   padding-and-payload tail and keep everything else -- verify the result is
   syntactically valid (`node --check <file>` for JS) before committing.
3. **Fix the real, live copy** (your GitHub `main`/`master`, not just your
   local checkout) -- prefer `git revert <bad-commit>` over rewriting history,
   so the compromised commit stays visible as evidence for anyone
   investigating later. Only rewrite/squash history if you specifically want
   the bad content gone from every clone, and understand that requires a
   force-push and everyone else re-cloning.
4. **Pin your dependencies.** Replace every `@latest`, unpinned `github:`
   spec, or `npm install` (no lockfile) in your CI with an exact version or
   commit SHA. This is what actually stops the next compromised release from
   reaching you automatically.
5. **Rotate credentials.** If the introducing commit was bot-authored, that
   bot's token/secret should be treated as compromised and rotated, even if
   you can't yet prove how it leaked. If several unrelated repos under the
   same account/org are affected, the shared credential (an org-level GitHub
   token, an npm publish token used by multiple release workflows) is the
   more likely root cause than each repo being attacked independently --
   look there before assuming every repo was compromised in isolation.
6. **Add a standing check.** Wire steps 1-2 above into your CI (a
   `postinstall` script and/or a `doctor`/preflight command) so a repeat
   injection is caught automatically on the next install, not months later
   by chance.

## Scope note

This instruction describes a specific, real, currently-active pattern (found
and confirmed across more than a dozen repositories in August 2026, including
a live, still-running instance discovered mid-investigation). It is not a
general malware-scanning guide -- treat it as one specific signature to add to
whatever broader security practice you already have, not a replacement for
one.
