# Parameter matrix counts

Final audit snapshot: 2026-07-15 (Asia/Shanghai).

- `web/package.json` SHA-256: `7048f1c088f8a7e3b43ad0bb4dff76f617ff170d3d9896e298c1598deb11d2b4`
- `web/package-lock.json` SHA-256: `55ac7340cfbd368755eab157254ed32acdac1187b6ec6e0d5794cf3ef5ac1f79`
- `web/lib/proxies/uriToClash.ts` SHA-256: `d7233890451d11d54f334094b5eb27283b85b7093be0e9fc538afca9428c744f`
- `web/tests/subscriptions/proxyUri.test.ts` SHA-256: `c983532a6e33845377319e661ca293851079f76410479f6253a8f320d3bc17ab`
- `web/lib/proxies/mihomoUserId.ts` SHA-256: `619761f5ae766a898d8b83f3e96d374270fb024f8c5b869d87203bffc75d41d5`
- `web/lib/proxies/mihomoProxyValidator.ts` SHA-256: `90327b301676b825332cc127021221288f814adc39d762874c70b22fb4e0dca9`
- `web/tests/subscriptions/mihomoProxyValidator.test.ts` SHA-256: `bd9943e7024d436a28b68c81bd2b76c23ec81b86b37c5113d7f4787dc9391a9d`
- `web/lib/proxies/regexSafety.ts` SHA-256: `5b8c3be9a109b467d59f0be5dbf8abd3823dedf33cf31572c48ec7511cc66d05`
- `web/lib/proxies/filterMatch.ts` SHA-256: `ef3d5b923af2c54dc9c3efd8e42299e733652224a86417b350f55b39fe5c2273`
- `web/tests/proxies/operators.test.ts` SHA-256: `a5d91d5364e51761c0ace03abffdd3046b7d6281e3ebea7ce93c142fe3c1f70b`
- `web/lib/net/ipLiteral.ts` SHA-256: `c52e022c0629f8e70e9c61b40e13f47c899414dbd5f10a4c18fbce914296d5a7`
- `web/tests/net/ipLiteral.test.ts` SHA-256: `282fd0bc9de101c9440252bd4479ba12a47adac55d45b6fc0dc0a90823c021d5`
- `web/lib/net/safeFetch.ts` SHA-256: `a73fefca0a111666312afab83935d6befe62aed6dcc595f3c3c6f662816a17a1`
- `web/tests/net/safeFetch.test.ts` SHA-256: `d028e7dbaceef926fedeb4c9c2d8826fffb33aca5baa219ceaddb7068c0e97ba`
- `web/schemas/rule.ts` SHA-256: `a3dfffec75bc29c7e7bc5b7e76b774e4086a51b82d11c030f6b2147d9556845c`
- `web/tests/schemas/rule.test.ts` SHA-256: `a04461d4779d4eb46b31b5bcaf616df5ed7d6415264ff7ce0afa50d937be9f65`
- `web/lib/engine/parser.ts` SHA-256: `a0206012c1f8f5e9f960bb0abba29efa45674c9b1d0a11623ac9d80d17e75dc1`
- `web/tests/engine/baseInputSafety.test.ts` SHA-256: `a736908e99a726aa67df506cd46058748e447b83a4d2e6519d1bc4df3fb5fb9b`
- `web/lib/engine/ruleSetReferences.ts` SHA-256: `7218fd79d98073b562e8587ff3828e1955908d361415138fe8ea091101a16568`
- `web/tests/engine/ruleProviders.test.ts` SHA-256: `4290dd0bd0d0429836da13ee5a8cd364905d36591c93f62e9f4e8f412c48beb0`
- `web/lib/engine/renderer.ts` SHA-256: `27708e087236b897aaa47fbc896043f3235d3e4fb9afa2589c6023f26b994c33`
- `web/lib/engine/resolve.ts` SHA-256: `7c4813b32e6429e50b2903cc96b8fbc044926f56a966046a81c0b897359166bc`
- `web/tests/engine/resolve.test.ts` SHA-256: `8d0224533f8f0d55c639c5e069e7f7d13cc7ebfbf7f1c17e651ea339f5e5c6d7`
- `web/lib/engine/renderCache.ts` SHA-256: `8bbc991a5b16eae41ee75587346d833643bbadf2446d18f4965a713390228961`
- `docs/proxy-compat/parameter-matrix.csv` SHA-256: `59143e45f1d125879c4967b62cb4331d152fd7ee8ff051caa907a7b95ebd4ef3`
- CSV shape: 21 columns and 295 data rows; Python's standard `csv` parser accepted every row with exactly 21 fields.

The evidence pins used by the matrix are Mihomo v1.19.28 (`cbd11db`),
Xray v26.3.27 (`d2758`), sing-box v1.13.14 (`25a600`), v2ray-core
v5.51.2 (`59950b`), and Sub-Store v2.36.7 (`0882a522`). Full source URLs,
retrieval dates, and applicability boundaries live in `../sources.md`.

## Counting contract

1. A registered scheme is a row whose `location` is `scheme`. Scheme aliases
   are separate registry rows because they are independently dispatchable.
2. A finite parameter row has `location=query`, `location=json`, or a location
   beginning with `nested.`. Structural carriers, Realm `unsupported.query`
   rows, wildcard/policy rows, and unsupported formats are excluded.
3. A primary raw-key occurrence is one finite parameter row. Reusing a spelling
   in another protocol or nested path remains a separate occurrence.
4. An alias is one pipe-delimited token in `aliases`. Algorithmic normalization
   classes are described in `decode_rule` and are not infinitely expanded.
5. A finite spelling occurrence is a primary raw key plus its explicit aliases.
   Unique spellings are deduplicated globally as exact strings.
6. Canonical semantics are deduplicated by exact `canonical_semantic` token.
7. Known-but-rejected spellings remain in the finite vocabulary. Removing them
   would hide a tested product boundary.
8. `test_ids != none` is a row-level direct-coverage marker. One test may cover
   multiple rows; the number is not a test-case count.

Status meanings:

- `complete`: the bounded product contract is mapped and validated.
- `partial`: behavior is known and bounded, but an evidence or compatibility
  boundary remains.
- `explicit_reject`: the spelling/capability deliberately fails before output.
- `silent_drop`: accepted known semantics disappear without an error.
- `unknown`: behavior or authoritative semantics are unclassified.

The final matrix has zero `silent_drop` and zero `unknown` rows. SSR `group` and
VMess schema `v` are `complete` validated intentional metadata omissions, not
silent drops. The only four finite partials are VMess `host`, `path`, nested
path `ed`, and VLESS `pcs`; the two additional whole-matrix partials are the SS
AEAD-2022 structural form distinction and version-scoped AnyTLS fragment.

## Exact totals

| Metric                             | Top-level query/JSON | Nested | Combined finite parameters |
| ---------------------------------- | -------------------: | -----: | -------------------------: |
| Primary parameter rows             |                  133 |     60 |                        193 |
| Unique primary `raw_key` spellings |                   85 |     45 |                        117 |
| Alias token occurrences            |                   33 |      7 |                         40 |
| Unique alias tokens                |                   24 |      7 |                         31 |
| Finite spelling occurrences        |                  166 |     67 |                        233 |
| Unique finite spellings            |                  104 |     50 |                        139 |
| Unique canonical semantics         |                   93 |     57 |                        150 |
| `complete` rows                    |                  102 |     59 |                        161 |
| `partial` rows                     |                    3 |      1 |                          4 |
| `explicit_reject` rows             |                   28 |      0 |                         28 |
| `silent_drop` rows                 |                    0 |      0 |                          0 |
| `unknown` rows                     |                    0 |      0 |                          0 |
| Rows with direct `test_ids`        |                  132 |     57 |                        189 |
| Direct row-marker coverage         |               99.25% | 95.00% |                     97.93% |

The 295 data rows partition exactly as follows:

| Row class                                      |    Rows | Complete | Partial | Explicit reject | Silent drop | Unknown | Tested rows |
| ---------------------------------------------- | ------: | -------: | ------: | --------------: | ----------: | ------: | ----------: |
| Registered scheme rows                         |      17 |       17 |       0 |               0 |           0 |       0 |          14 |
| Structural carrier/constraint rows             |      69 |       61 |       2 |               6 |           0 |       0 |          65 |
| Finite parameter rows                          |     193 |      161 |       4 |              28 |           0 |       0 |         189 |
| Policy rows, including two wildcard audit rows |      11 |        0 |       0 |              11 |           0 |       0 |          11 |
| Explicitly unsupported format/query rows       |       5 |        0 |       0 |               5 |           0 |       0 |           0 |
| **Total**                                      | **295** |  **239** |   **6** |          **50** |       **0** |   **0** |     **279** |

The 17 scheme rows map to 13 parser families. Whole-matrix direct markers cover
279/295 rows (94.58%). Both former wildcard policies (AnyTLS and WireGuard) are
closed `explicit_reject` rows and are excluded from finite parameter counts.
WireGuard `remote-dns-resolve` is also an `explicit_reject` finite row: fixed
Mihomo requires a paired non-empty structured `dns[]`, while the bounded flat
URI dialect deliberately has no list carrier.

## Top-level subtotals by parser family

`Spellings` includes primary rows plus explicit alias tokens.

| Parser family | Primary | Alias tokens | Spellings | Unique semantics | Complete | Partial | Explicit reject |  Tested |
| ------------- | ------: | -----------: | --------: | ---------------: | -------: | ------: | --------------: | ------: |
| Shadowsocks   |      17 |            4 |        21 |               17 |        7 |       0 |              10 |      17 |
| ShadowsocksR  |       6 |            0 |         6 |                6 |        4 |       0 |               2 |       6 |
| VMess         |      18 |            0 |        18 |               18 |       14 |       2 |               2 |      18 |
| VLESS         |      22 |            2 |        24 |               22 |       20 |       1 |               1 |      21 |
| Trojan        |       8 |            2 |        10 |                8 |        8 |       0 |               0 |       8 |
| Hysteria 1    |       9 |            4 |        13 |                9 |        9 |       0 |               0 |       9 |
| Hysteria 2    |      13 |            2 |        15 |               13 |       12 |       0 |               1 |      13 |
| TUIC          |       6 |            1 |         7 |                6 |        6 |       0 |               0 |       6 |
| Snell         |       3 |            0 |         3 |                3 |        3 |       0 |               0 |       3 |
| AnyTLS        |      13 |            7 |        20 |               13 |       10 |       0 |               3 |      13 |
| WireGuard     |      18 |           11 |        29 |               18 |        9 |       0 |               9 |      18 |
| SOCKS5        |       0 |            0 |         0 |                0 |        0 |       0 |               0 |       0 |
| HTTP(S)       |       0 |            0 |         0 |                0 |        0 |       0 |               0 |       0 |
| **Total**     | **133** |       **33** |   **166** |           **93** |  **102** |   **3** |          **28** | **132** |

SOCKS5 and HTTP(S) have no admitted URI query/JSON vocabulary; their userinfo,
authority, path, query, and fragment contracts are structural rows.

## Nested subtotals

| Parser family | Nested rows | Alias tokens | Spelling occurrences | Unique spellings | Unique semantics | Complete | Partial | Tested |
| ------------- | ----------: | -----------: | -------------------: | ---------------: | ---------------: | -------: | ------: | -----: |
| Shadowsocks   |          15 |            2 |                   17 |               11 |               12 |       15 |       0 |     15 |
| VMess         |           1 |            0 |                    1 |                1 |                1 |        0 |       1 |      1 |
| VLESS         |          44 |            5 |                   49 |               42 |               44 |       44 |       0 |     41 |
| **Total**     |      **60** |        **7** |               **67** |           **50** |           **57** |   **59** |   **1** | **57** |

Repeated leaf spellings under different object paths remain separate row
occurrences. This is why 60 nested rows contain 45 unique primary raw keys.

## Reproduction

Run from the repository root with Python 3. No third-party package is required:

```python
import collections
import csv
import hashlib

path = "docs/proxy-compat/parameter-matrix.csv"

with open(path, newline="", encoding="utf-8") as handle:
    physical = list(csv.reader(handle))
assert len(physical[0]) == 21
assert all(len(row) == 21 for row in physical)

with open(path, newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
assert len(rows) == 295
assert {row["status"] for row in rows} <= {
    "complete", "partial", "explicit_reject", "silent_drop", "unknown"
}
assert not any(
    marker in value
    for row in rows
    for value in row.values()
    for marker in ("[object Object]", "undefined", "null")
)

finite = [
    row for row in rows
    if row["location"] in {"query", "json"}
    or row["location"].startswith("nested.")
]
top = [row for row in finite if not row["location"].startswith("nested.")]
nested = [row for row in finite if row["location"].startswith("nested.")]

def aliases(row):
    return [token for token in row["aliases"].split("|") if token]

def summarize(selected):
    alias_tokens = [token for row in selected for token in aliases(row)]
    spellings = [
        token
        for row in selected
        for token in [row["raw_key"], *aliases(row)]
    ]
    return {
        "rows": len(selected),
        "primary_unique": len({row["raw_key"] for row in selected}),
        "aliases": len(alias_tokens),
        "alias_unique": len(set(alias_tokens)),
        "spelling_occurrences": len(spellings),
        "spelling_unique": len(set(spellings)),
        "semantic_unique": len({row["canonical_semantic"] for row in selected}),
        "statuses": dict(collections.Counter(row["status"] for row in selected)),
        "tested": sum(row["test_ids"] != "none" for row in selected),
    }

assert len([row for row in rows if row["location"] == "scheme"]) == 17
assert len({row["protocol"] for row in rows if row["location"] == "scheme"}) == 13
assert summarize(top) == {
    "rows": 133,
    "primary_unique": 85,
    "aliases": 33,
    "alias_unique": 24,
    "spelling_occurrences": 166,
    "spelling_unique": 104,
    "semantic_unique": 93,
    "statuses": {"complete": 102, "explicit_reject": 28, "partial": 3},
    "tested": 132,
}
assert summarize(nested) == {
    "rows": 60,
    "primary_unique": 45,
    "aliases": 7,
    "alias_unique": 7,
    "spelling_occurrences": 67,
    "spelling_unique": 50,
    "semantic_unique": 57,
    "statuses": {"complete": 59, "partial": 1},
    "tested": 57,
}
assert summarize(finite) == {
    "rows": 193,
    "primary_unique": 117,
    "aliases": 40,
    "alias_unique": 31,
    "spelling_occurrences": 233,
    "spelling_unique": 139,
    "semantic_unique": 150,
    "statuses": {"complete": 161, "explicit_reject": 28, "partial": 4},
    "tested": 189,
}
assert collections.Counter(row["status"] for row in rows) == {
    "complete": 239, "explicit_reject": 50, "partial": 6
}
assert sum(row["test_ids"] != "none" for row in rows) == 279
assert not any(row["status"] in {"silent_drop", "unknown"} for row in rows)

digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
assert digest == "59143e45f1d125879c4967b62cb4331d152fd7ee8ff051caa907a7b95ebd4ef3"
print(summarize(top))
print(summarize(nested))
print(summarize(finite))
print(digest)
```
