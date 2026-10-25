# Task (disposable desktop-continuity demo)

Implement the four functions in src/ so that `npm test` passes. One module per file; do not edit the tests.

1. src/slugify.js     slugify(text): lowercase, trim, runs of non-alphanumerics become one "-", no leading/trailing "-".
2. src/titleCase.js   titleCase(text): capitalize the first letter of each space-separated word, lowercase the rest.
3. src/truncate.js    truncate(text, max): if text is longer than max characters, cut it to max-1 characters and add "…"; otherwise return it unchanged.
4. src/wordCount.js   wordCount(text): number of words separated by whitespace; 0 for an empty or blank string.
