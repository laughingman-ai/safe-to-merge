# Known bugs

This repo keeps one bug in the code on purpose, so the demo always has a real fix to make.
The fresh-context reviewer reads this file and doesn't report these. Only a human can edit
it: it's one of the gates.

| Issue                                                          | Bug                                                                                                                                                                                    | Where                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| [#1](https://github.com/laughingman-ai/safe-to-merge/issues/1) | `addBusinessDays` checks the day it leaves instead of the day it lands on, so a due date can fall on a weekend or holiday. No test on `main` covers it; the fix starts with that test. | `src/business-days.ts` |
