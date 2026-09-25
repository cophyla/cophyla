// Can this runtime serve a Windows named pipe? Try a plain name and the LOCAL\ namespace Claude uses.
import { createServer, connect } from 'node:net';

const rt = typeof (globalThis as any).Bun !== 'undefined' ? 'bun' : 'node';
const BS = String.fromCharCode(92);
const pipePath = (name: string) => [BS + BS + '.', 'pipe', name].join(BS);

for (const name of ['cophyla-spike-plain', ['LOCAL', 'cophyla-spike-local'].join(BS)]) {
  const path = pipePath(`${name}-${process.pid}`);
  await new Promise<void>((done) => {
    const srv = createServer((c) => { c.on('data', (d) => { c.write('echo:' + d); }); });
    srv.on('error', (e: any) => { console.log(`${rt} listen ${path}: FAIL ${e.code} ${e.message}`); done(); });
    srv.listen(path, () => {
      const c = connect(path, () => c.write('hi'));
      c.on('data', (d) => { console.log(`${rt} listen ${path}: OK, round trip "${d}"`); c.end(); srv.close(() => done()); });
      c.on('error', (e: any) => { console.log(`${rt} listen ${path}: listen ok, connect FAIL ${e.code}`); srv.close(() => done()); });
    });
  });
}
