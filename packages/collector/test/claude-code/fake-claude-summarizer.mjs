// Stands in for `claude -p --output-format json` in tests: answers the batched summary prompt.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const turns = JSON.parse(input.slice(input.indexOf('Turns (JSON):') + 'Turns (JSON):'.length));
  const result = Object.fromEntries(turns.map((t, i) => [t.id, `Summary ${i + 1} (${t.tools.length} tools)`]));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) }));
});
