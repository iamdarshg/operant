// Step 2 — network. Read-only: DNS lookups and HTTPS HEAD requests only.

import dns from 'node:dns';
import https from 'node:https';

export const id = 'network';
export const title = 'Network reachability';
export const why = 'A provisioning run that cannot reach the package mirrors or npm fails halfway; prove the network first.';
export const needsRoot = false;

const DNS_TARGETS = ['github.com', 'registry.npmjs.org', 'api.deepseek.com'];
const HTTPS_TARGETS = [
  { name: 'GitHub', url: 'https://github.com/' },
  { name: 'npm registry', url: 'https://registry.npmjs.org/' },
  { name: 'DeepSeek API', url: 'https://api.deepseek.com/' },
];

function resolveHost(host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `DNS lookup timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    dns.promises
      .lookup(host, { all: true })
      .then((addresses) => {
        clearTimeout(timer);
        finish({ ok: true, addresses });
      })
      .catch((error) => {
        clearTimeout(timer);
        finish({ ok: false, error: `${error.code || 'DNS_ERROR'}: ${error.message}` });
      });
  });
}

function headRequest(url, timeoutMs) {
  return new Promise((resolve) => {
    let request;
    try {
      request = https.request(
        url,
        {
          method: 'HEAD',
          timeout: timeoutMs,
          headers: {
            'user-agent': 'operant-provision/1.0 (+local first-boot wizard)',
            accept: '*/*',
          },
        },
        (response) => {
          response.resume();
          resolve({
            ok: true,
            status: response.statusCode,
            location: response.headers.location || null,
          });
        },
      );
    } catch (error) {
      resolve({ ok: false, error: `${error.code || 'REQUEST_ERROR'}: ${error.message}` });
      return;
    }
    request.on('timeout', () => {
      request.destroy(new Error(`timed out after ${timeoutMs} ms`));
    });
    request.on('error', (error) => {
      resolve({ ok: false, error: `${error.code || 'NETWORK_ERROR'}: ${error.message}` });
    });
    request.end();
  });
}

export async function run(ctx) {
  ctx.log('Read-only checks: DNS resolution and HTTPS HEAD requests. Nothing is installed or changed.');
  const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const configuredProxies = proxyVariables.filter((name) => process.env[name]);
  if (configuredProxies.length > 0) {
    ctx.log(
      `Proxy variables are set (${configuredProxies.join(', ')}). Node's https.request does not ` +
        'honour them by default, so this check measured a direct connection, not your proxy.',
      'info',
    );
  }

  ctx.logSection('DNS');
  const dnsResults = new Map();
  for (const host of DNS_TARGETS) {
    const result = await resolveHost(host, 8000);
    dnsResults.set(host, result);
    if (result.ok) {
      const addresses = result.addresses.map((entry) => `${entry.address} (IPv${entry.family})`);
      ctx.log(`${host} → ${addresses.join(', ')}`);
    } else {
      ctx.log(`${host} → DNS failed: ${result.error}`, 'err');
    }
  }

  ctx.logSection('HTTPS');
  const httpsResults = new Map();
  for (const target of HTTPS_TARGETS) {
    const result = await headRequest(target.url, 8000);
    httpsResults.set(target.name, result);
    if (result.ok) {
      ctx.log(
        `${target.name}: HTTP ${result.status}` +
          (result.location ? ` → ${result.location.includes('://') ? result.location : `redirect ${result.location}`}` : ''),
      );
    } else {
      ctx.log(`${target.name}: failed — ${result.error}`, 'err');
    }
  }

  const coreDnsOk = dnsResults.get('github.com')?.ok && dnsResults.get('registry.npmjs.org')?.ok;
  const coreHttpsOk =
    httpsResults.get('GitHub')?.ok && httpsResults.get('npm registry')?.ok;
  const deepseekOk = dnsResults.get('api.deepseek.com')?.ok && httpsResults.get('DeepSeek API')?.ok;
  const ok = Boolean(coreDnsOk && coreHttpsOk);

  ctx.logSection('Verdict');
  if (ok) {
    ctx.log('GitHub and the npm registry resolve and answer. Package and AI-stack steps can fetch.');
  } else {
    ctx.log('At least one core endpoint failed. Install and build steps will fail until this is fixed.', 'err');
    ctx.log('Check: network link, DNS (/etc/resolv.conf), proxy settings, and any firewall.', 'info');
  }
  if (!deepseekOk) {
    ctx.log(
      'DeepSeek API is not reachable from here. That is not fatal for installation, but model calls ' +
        'through an official DeepSeek route will fail; a different model provider may still work.',
      'info',
    );
  }

  const dnsPassed = [...dnsResults.values()].filter((result) => result.ok).length;
  const httpsPassed = [...httpsResults.values()].filter((result) => result.ok).length;
  return {
    ok,
    summary: `${dnsPassed}/${DNS_TARGETS.length} DNS · ${httpsPassed}/${HTTPS_TARGETS.length} HTTPS · ` +
      (ok ? 'core reachable' : 'core unreachable'),
  };
}