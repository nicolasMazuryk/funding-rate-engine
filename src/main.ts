export function scaffoldOk(): boolean {
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('scaffold ok:', scaffoldOk())
}
