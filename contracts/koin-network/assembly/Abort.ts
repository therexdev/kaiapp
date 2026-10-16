// Runtime assertions must revert, but native receipts should identify the source.
// Avoid SDK global buffers here: this handler also runs during initialization.
@external("env", "invoke_system_call")
declare function invoke(id: u32, result: u32, resultSize: u32, args: u32, argsSize: u32, written: u32): i32;
export function contractAbort(message: string | null, file: string | null, line: u32, column: u32): void {
  const text = "Contract assertion: " + (message === null ? "unknown" : message!) + " at " + (file === null ? "unknown" : file!) + ":" + line.toString() + ":" + column.toString();
  const bytes = Uint8Array.wrap(String.UTF8.encode(text.slice(0, 512)));
  const args = new Uint8Array(bytes.length + 4), result = new Uint8Array(16), written = new Uint32Array(1);
  args[0] = 10; // koinos.chain.log_arguments.message
  let length = <u32>bytes.length, cursor = 1;
  while (length >= 128) { args[cursor++] = <u8>((length & 127) | 128); length >>= 7; }
  args[cursor++] = <u8>length;
  memory.copy(args.dataStart + cursor, bytes.dataStart, bytes.length);
  invoke(401, result.dataStart, result.length, args.dataStart, cursor + bytes.length, written.dataStart);
  unreachable();
}
