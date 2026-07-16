import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { resolveConfig } from '@/lib/engine/resolve';
import { parseProxyUriList, type ClashProxy } from '@/lib/proxies/uriToClash';
import { exportCollectionNodes } from '@/lib/services/nodeExportService';
import type { Collection, Subscription } from '@/schemas';

async function main(): Promise<void> {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error('usage: tsx scripts/proxy-compat/generate-mihomo-fixtures.ts <output-dir>');
  }

  const UUID = '00000000-0000-4000-8000-000000000001';
  const base64url = (value: string | Uint8Array): string =>
    Buffer.from(value).toString('base64url');
  const realityPublicKey = base64url(Buffer.alloc(32, 1));
  // WireGuard's key grammar is standard padded Base64, unlike Reality's
  // unpadded Base64URL key. Percent-encode it in the URI so `=` remains data.
  const wireGuardPrivateKey = Buffer.alloc(32, 2).toString('base64');
  const wireGuardPublicKey = Buffer.alloc(32, 3).toString('base64');
  const vlessEncryption = `mlkem768x25519plus.native.1rtt.${base64url(Buffer.alloc(32, 4))}`;

  const ssUserInfo = base64url('aes-128-gcm:FAKE_SS_PASSWORD');
  const ssrPassword = base64url('FAKE_SSR_PASSWORD');
  const ssrBody = base64url(
    `ssr.invalid:443:origin:aes-256-cfb:plain:${ssrPassword}/?remarks=${base64url('SSR')}`,
  );
  const vmessBody = base64url(
    JSON.stringify({
      v: '2',
      ps: 'VMess',
      add: 'vmess.invalid',
      port: '443',
      id: UUID,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      host: 'cdn.invalid',
      path: '/ws',
      tls: 'tls',
      sni: 'vmess.invalid',
    }),
  );
  const vmessHttpUpgradeBody = base64url(
    JSON.stringify({
      v: '2',
      ps: 'VMess-HTTPUpgrade',
      add: 'vmess-upgrade.invalid',
      port: '443',
      id: UUID,
      aid: '0',
      scy: 'auto',
      net: 'httpupgrade',
      host: 'cdn.invalid',
      path: '/upgrade?ed=2048',
      tls: 'tls',
      sni: 'vmess-upgrade.invalid',
    }),
  );

  const allFamilyUris = [
    `ss://${ssUserInfo}@ss.invalid:8388#SS`,
    `ssr://${ssrBody}`,
    `vmess://${vmessBody}`,
    `vless://${UUID}@vless.invalid:443?encryption=none&security=tls&sni=vless.invalid&type=ws&path=%2Fws&host=cdn.invalid#VLESS`,
    'trojan://FAKE_TROJAN_PASSWORD@trojan.invalid:443?sni=trojan.invalid#Trojan',
    'hysteria://hysteria.invalid:443?auth=FAKE_H1_AUTH&upmbps=10&downmbps=20&sni=hysteria.invalid#Hysteria1',
    'hysteria2://FAKE_H2_PASSWORD@hysteria2.invalid:443?sni=hysteria2.invalid#Hysteria2',
    `tuic://${UUID}:FAKE_TUIC_PASSWORD@tuic.invalid:443?sni=tuic.invalid&alpn=h3#TUIC`,
    'snell://FAKE_SNELL_PSK@snell.invalid:443?version=3#Snell',
    'anytls://FAKE_ANYTLS_PASSWORD@anytls.invalid:443?sni=anytls.invalid#AnyTLS',
    `wireguard://${encodeURIComponent(wireGuardPrivateKey)}@wg.invalid:51820?public-key=${encodeURIComponent(wireGuardPublicKey)}&address=${encodeURIComponent('10.0.0.2/32,fd00::2/128')}#WireGuard`,
    `socks5://${base64url('FAKE_USER:FAKE_PASSWORD')}@socks.invalid:1080#SOCKS`,
    'https://FAKE_USER:FAKE_PASSWORD@http.invalid:8443#HTTPS',
  ];

  const xhttpExtra = encodeURIComponent(
    JSON.stringify({
      xmux: { maxConnections: 2 },
      downloadSettings: {
        address: 'download.invalid',
        port: 8443,
        security: 'reality',
        tlsSettings: { serverName: 'download.invalid', fingerprint: 'chrome' },
        realitySettings: { publicKey: realityPublicKey, shortId: 'ab12' },
        xhttpSettings: { path: '/download', host: 'download.invalid' },
      },
    }),
  );

  const vlessUris = [
    `vless://${UUID}@default-xudp.invalid:443?encryption=none&type=tcp#VLESS-Default-XUDP`,
    `vless://${UUID}@explicit-xudp.invalid:443?encryption=none&type=tcp&packetEncoding=xudp#VLESS-Explicit-XUDP`,
    `vless://${UUID}@packet.invalid:443?encryption=none&type=tcp&packet-encoding=packetaddr#VLESS-PacketAddr`,
    `vless://${UUID}@reality.invalid:443?encryption=none&security=reality&fp=chrome&pbk=${realityPublicKey}&sid=ab12&sni=reality.invalid&type=tcp#VLESS-Reality`,
    `vless://${UUID}@enc.invalid:443?encryption=${encodeURIComponent(vlessEncryption)}&type=tcp#VLESS-Encryption`,
    `vless://${UUID}@xhttp.invalid:443?encryption=none&security=tls&sni=xhttp.invalid&type=xhttp&mode=packet-up&path=%2Fup&host=xhttp.invalid&extra=${xhttpExtra}#VLESS-XHTTP`,
  ];
  const httpUpgradeUris = [
    `vmess://${vmessHttpUpgradeBody}`,
    `vless://${UUID}@vless-upgrade.invalid:443?encryption=none&security=tls&sni=vless-upgrade.invalid&type=httpupgrade&path=%2Fupgrade&host=cdn.invalid&ed=2048&eh=X-Early-Data#VLESS-HTTPUpgrade`,
  ];

  function parseFixture(uris: string[]): ClashProxy[] {
    const result = parseProxyUriList(uris.join('\n'));
    if (result.errors.length > 0 || result.proxies.length !== uris.length) {
      throw new Error(
        `fixture URI parsing failed: ${result.errors.length} errors for ${uris.length} inputs`,
      );
    }
    return result.proxies;
  }

  function fullConfig(proxies: ClashProxy[]): string {
    return stringify(
      {
        'mixed-port': 17890,
        mode: 'rule',
        'log-level': 'silent',
        proxies,
        'proxy-groups': [
          {
            name: 'AUDIT',
            type: 'select',
            proxies: proxies.length > 0 ? proxies.map((proxy) => proxy.name) : ['DIRECT'],
          },
        ],
        rules: ['MATCH,AUDIT'],
      },
      { lineWidth: 0 },
    );
  }

  const target = resolve(outputDirectory);
  const localSubscription: Subscription = {
    id: '00000000-0000-4000-8000-000000000101',
    name: 'audit-local',
    enabled: true,
    kind: 'local',
    content: allFamilyUris.join('\n'),
    ttl_ms: 60_000,
    tags: ['audit'],
    operators: [{ id: 'audit-tfo', kind: 'set-prop', tfo: true }],
  };
  const collection: Collection = {
    id: '00000000-0000-4000-8000-000000000201',
    name: 'Audit collection',
    slug: 'audit-collection',
    enabled: true,
    type: 'select',
    subscription_ids: [localSubscription.id],
    subscription_tags: [],
    operators: [{ id: 'audit-sort', kind: 'sort', by: 'name', order: 'asc' }],
  };
  const base = fullConfig([]);
  const localResolved = await resolveConfig(base, [], [localSubscription], [], [], {
    ignoreFailedSubs: false,
    persistSnapshot: false,
  });
  const collectionResolved = await resolveConfig(base, [], [localSubscription], [], [], {
    boundSource: { type: 'collection', id: collection.id },
    collections: [collection],
    ignoreFailedSubs: false,
    persistSnapshot: false,
  });
  const exported = await exportCollectionNodes(collection, [localSubscription]);
  const exportedDocument = parse(exported.yaml) as { proxies?: unknown };
  if (!Array.isArray(exportedDocument.proxies) || exportedDocument.proxies.length !== 13) {
    throw new Error('collection export fixture did not preserve all parser families');
  }

  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(resolve(target, 'all-uri-families.yaml'), fullConfig(parseFixture(allFamilyUris))),
    writeFile(
      resolve(target, 'vless-security-transport.yaml'),
      fullConfig(parseFixture(vlessUris)),
    ),
    writeFile(resolve(target, 'http-upgrade.yaml'), fullConfig(parseFixture(httpUpgradeUris))),
    writeFile(resolve(target, 'full-chain-local.yaml'), localResolved.content),
    writeFile(resolve(target, 'full-chain-collection.yaml'), collectionResolved.content),
    writeFile(
      resolve(target, 'full-chain-collection-export.yaml'),
      fullConfig(exportedDocument.proxies as ClashProxy[]),
    ),
  ]);

  process.stdout.write(`${target}\n`);
}

void main();
