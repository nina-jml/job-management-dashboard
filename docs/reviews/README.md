# Code reviews

Three rounds of automated code review ran during the build, at the points where a
coherent piece of work was finished. Each is recorded here with what it found and
what was done about it.

They are kept because the review loop is part of how this was built, not an
afterthought — and because what a review *catches* says more about a process than
a clean final diff does. Two of the most useful findings were not bugs in the
application at all, but tests that passed while proving something other than what
they claimed.

| | Round | Scope | Findings |
|---|---|---|---|
| [1](./1-step-7-code-review.md) | after step 7 | the backend, and the UI through the required critical flow | 11, all fixed |
| [2](./2-steps-8-10-code-review.md) | after step 10 | delete, pagination at scale, fault injection | 8, all fixed |
| [3](./3-step-9.5-code-review.md) | after search | dialog copy, `CANCELED` respelling, terminology, search | 8, all fixed |

**27 findings, all closed.** The three worth knowing about:

- **Round 1** found a bug that made the assignment's own critical flow silently
  fail for anyone who had opened a history panel first — the optimistic cache
  writer reached a query whose cached shape had no `pages` array, threw, and
  because a throwing `onMutate` skips the mutation entirely, the PATCH was never
  sent while the badge still moved. No spec opened a history panel before
  changing a status, so the suite stayed green over it.
- **Round 2** found a spec that deleted rows belonging to *other* specs, under
  parallel workers, with a guard that swallowed the evidence — so it stayed green
  and broke something else.
- **Round 3** found that the trigram index could not serve the query it was built
  for, because Django compiles `icontains` to `UPPER(name::text) LIKE …` and the
  index was on the bare column. The performance claim published about it had been
  measured on hand-written SQL rather than on the query the application runs.

Each round's notes also record mistakes made *while fixing* the findings, which is
the least flattering and probably most useful part.
