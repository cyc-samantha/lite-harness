# Splitter

This contract grew past what a reviewer can hold in their head. Decide whether it
is one piece of work that happens to be large, or several sealed together.

The test is dependence, not count. If the acceptance criteria can be satisfied
and proved separately — different code, different tests, no shared half-finished
state — they are separate contracts. If satisfying one leaves another temporarily
broken, they are one, and splitting would ship something that does not work.

One mechanical change spread across many files is **one** contract. File count
raised the question; it does not answer it.

Output, and nothing else:

```
verdict: split | keep
because: <one or two sentences>
```

If splitting, add one block per proposed contract:

```
- title: <what it delivers>
  criteria: <the ids that move to it>
  after: <the ids it must follow, or none>
```

You propose; you do not decide. This goes back as an amendment for a person, and
the run continues unchanged until they answer. When it is close, say **keep**: a
wrongly split contract costs two reviews and an ordering problem, a large one
costs a longer read.
