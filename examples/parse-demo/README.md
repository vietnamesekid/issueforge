# parse-demo

A deliberately buggy fixture, used to exercise IssueForge end to end.

`parsePair` splits on every `=`, so a value that itself contains one is truncated.
The bug is latent: the test suite here passes.
