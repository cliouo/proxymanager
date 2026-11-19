import assert from 'node:assert/strict';
import { fixtures } from './fixtures';
import { analyzeExport, fieldDiff, markdown, parseFixture, type Result } from './report';
import { mapClient } from './clients';

async function main() {
  const node = parseFixture('ss://YWVzLTEyOC1nY206dGVzdA==@127.0.0.1:8388#lab');
  assert.equal(node[0].type, 'ss');
  for (const core of ['sing-box', 'xray'] as const) {
    assert.ok(mapClient(node[0], core, 1080).config);
    assert.ok(mapClient({}, core, 1080).reason);
    assert.match(mapClient({ ...node[0], type: 'snell' }, core, 1080).reason ?? '', /Snell/);
    assert.match(
      mapClient({ ...node[0], unknown: true }, core, 1080).reason ?? '',
      /unmapped fields/,
    );
  }
  const ws = {
    type: 'vless',
    server: 'localhost',
    port: 1234,
    uuid: 'lab',
    network: 'ws',
    'ws-opts': {
      path: '/lab',
      'max-early-data': 2048,
      'early-data-header-name': 'Sec-WebSocket-Protocol',
    },
  };
  const singWs = mapClient(ws, 'sing-box', 1080).config?.outbounds as Record<string, unknown>[];
  assert.equal((singWs[0].transport as Record<string, unknown>).max_early_data, 2048);
  const xrayWs = mapClient(ws, 'xray', 1080).config?.outbounds as Record<string, unknown>[];
  assert.match(JSON.stringify(xrayWs), /ed=2048/);
  assert.match(mapClient({ ...ws, network: 'mkcp' }, 'sing-box', 1080).reason ?? '', /mKCP/);
  assert.match(
    mapClient({ ...ws, encryption: 'mlkem' }, 'sing-box', 1080).reason ?? '',
    /encryption/,
  );
  const strictTLS = mapClient({ ...ws, tls: true, 'skip-cert-verify': true }, 'xray', 1080);
  assert.match(strictTLS.reason ?? '', /allowInsecure/);
  assert.equal(strictTLS.gaps.length, 1);
  const hopping = mapClient(
    {
      type: 'hysteria2',
      server: 'localhost',
      port: 1234,
      password: 'lab',
      ports: '1234,2000-2002',
      'hop-interval': '5',
      obfs: 'salamander',
      'obfs-password': 'lab',
    },
    'sing-box',
    1080,
  ).config?.outbounds as Record<string, unknown>[];
  assert.deepEqual(hopping[0].server_ports, ['1234:1234', '2000:2002']);
  assert.deepEqual(hopping[0].obfs, { type: 'salamander', password: 'lab' });
  assert.match(
    mapClient(
      {
        type: 'hysteria2',
        server: 'localhost',
        port: 1234,
        password: 'lab',
        ports: '1234',
        'hop-interval': '1',
      },
      'sing-box',
      1080,
    ).reason ?? '',
    /minimum is 5s/,
  );
  const tuic = mapClient(
    {
      type: 'tuic',
      server: 'localhost',
      port: 1234,
      uuid: 'lab',
      password: 'lab',
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
    },
    'sing-box',
    1080,
  ).config?.outbounds as Record<string, unknown>[];
  assert.equal(tuic[0].congestion_control, 'bbr');
  assert.equal(tuic[0].udp_relay_mode, 'native');
  assert.equal(analyzeExport(node).diff, 'identical');
  assert.equal(analyzeExport(node).status, 'PASS');
  assert.equal(analyzeExport([]).status, 'SKIP');
  assert.equal(analyzeExport([{ ...node[0], type: 'wireguard' }]).status, 'SKIP');
  assert.deepEqual(
    fieldDiff({ a: 1, opts: { b: 2 }, list: ['a'] }, { a: 3, opts: {}, list: ['b'], added: true }),
    ['changed a', 'added added', 'changed list.0', 'lost opts.b'],
  );
  assert.deepEqual(fieldDiff(null, {}), ['changed (root)']);
  assert.deepEqual(fieldDiff({ b: 1, a: 2 }, { a: 2, b: 1 }), []);
  assert.throws(() => parseFixture(''), /expected one node/);
  assert.throws(() => parseFixture('unknown://127.0.0.1'), /unsupported scheme/);
  assert.throws(() => parseFixture('ss://bad'), /invalid|malformed/);
  assert.throws(() => parseFixture('ss://bm90LWEtY2lwaGVyOnRlc3Q=@127.0.0.1:8388#lab'));
  const row: Result = {
    name: 'a|b',
    server: 'none',
    parse: 'FAIL',
    validate: 'SKIP',
    test: 'SKIP',
    startup: 'N/A',
    connect: 'SKIP',
    notes: ['error\nmessage'],
  };
  assert.match(markdown([row]), /a\\\|b/);
  assert.match(markdown([row]), /error message/);
  assert.equal(markdown([]).split('\n').length, 3);
  let next = 20000;
  const key = {
    privateKey: Buffer.alloc(32, 1).toString('base64'),
    publicKey: Buffer.alloc(32, 2).toString('base64'),
  };
  const cases = await fixtures({
    port: async () => next++,
    cert: '/lab/cert',
    key: '/lab/key',
    tlsPort: 19000,
    targetPort: 19001,
    reality: { privateKey: 'unused', publicKey: Buffer.alloc(32, 3).toString('base64url') },
    wgClient: key,
    wgServer: key,
    encryption: [
      {
        encryption: 'mlkem768x25519plus.native.0rtt.' + Buffer.alloc(32, 4).toString('base64url'),
        decryption: 'unused',
      },
      {
        encryption: 'mlkem768x25519plus.native.0rtt.' + Buffer.alloc(1184, 5).toString('base64url'),
        decryption: 'unused',
      },
    ],
  });
  assert.equal(new Set(cases.map((c) => c.name)).size, cases.length);
  assert.ok(cases.length >= 35);
  for (const fixture of cases) assert.equal(parseFixture(fixture.uri).length, 1, fixture.name);
  console.log(
    `PASS: normal/empty/error parsing, validator rejection, client mappings and unsupported features, report escaping, ${cases.length} unique fixture shapes`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
