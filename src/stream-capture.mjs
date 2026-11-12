// Turns an engine's raw stdout/stderr chunks into whole text lines.
//
// Pipes deliver arbitrary byte chunks: a chunk can end in the middle of a line, or in the middle
// of a multi-byte UTF-8 character (every Turkish letter outside ASCII is two bytes). Decoding and
// splitting each chunk on its own therefore broke lines in two and turned split characters into
// U+FFFD. This keeps one decoder and one unfinished line per stream, so lines come out whole.

import { StringDecoder } from 'node:string_decoder';

export function createLineCapture({ onLine, streams = ['stdout', 'stderr'] } = {}) {
  const state = Object.fromEntries(streams.map(name => [name, { decoder: new StringDecoder('utf8'), partial: '' }]));

  function emit(name, text) {
    const lines = text.split('\n');
    state[name].partial = lines.pop();
    for (const line of lines) onLine(line, name);
  }

  return {
    // Returns the text this chunk completed (possibly '' while a character is still split).
    write(name, chunk) {
      const text = typeof chunk === 'string' ? chunk : state[name].decoder.write(chunk);
      emit(name, state[name].partial + text);
      return text;
    },
    // Emits what is still pending, e.g. a last line without a newline. Safe to call twice.
    flush() {
      for (const name of streams) {
        const rest = state[name].partial + state[name].decoder.end();
        state[name].partial = '';
        if (rest) onLine(rest, name);
      }
    }
  };
}
