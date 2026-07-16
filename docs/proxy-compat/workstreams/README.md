# Workstreams and file ownership

Agent drafts are evidence notebooks, not the integrated source of truth.

| Workstream                     | Owner                                | Initially writable files                         | Shared source files                                                           |
| ------------------------------ | ------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Integration and counts         | Main agent                           | All integrated documents in the parent directory | `uriToClash.ts` and shared registries/tests only after a confirmed root cause |
| Parser inventory               | Parser inventory agent               | `parser-inventory.md`                            | Read-only until reassigned                                                    |
| Input security and cache       | Input security agent                 | `input-security.md`                              | Read-only until reassigned                                                    |
| Standards and versions         | Standards ledger agent               | `standards.md`                                   | Read-only until reassigned                                                    |
| Independent correctness review | Unassigned until implementation ends | A new review draft                               | Read-only                                                                     |
| Red-team review                | Unassigned until implementation ends | A new review draft                               | Read-only                                                                     |

Agents must record sources, findings, proposed files, tests, and unresolved
questions before requesting ownership of implementation files. No two agents
may edit `web/lib/proxies/uriToClash.ts` or the same test file concurrently.
