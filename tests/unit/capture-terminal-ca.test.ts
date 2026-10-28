import { describe, expect, it } from 'vitest';
import { CA_VARIABLES, checkStartUrl, proxyEnvironment, proxyShellLines } from '../../packages/core/src/debugger/capture.js';
import { escapeHtml, proxyPageHtml, PROXY_PAGE_HEADERS } from '../../packages/core/src/debugger/proxy-page.js';

const URL_ = 'http://127.0.0.1:8899';
const CA = 'C:\\Users\\me\\AppData\\Roaming\\TestPion\\debugger\\testpion-root.pem';

describe('the terminal opened for capture trusts the root certificate when HTTPS is decrypted', () => {
  it('exports the four CA variables next to the proxy ones', () => {
    expect(CA_VARIABLES).toEqual(['NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE']);
    const env = proxyEnvironment(URL_, CA);
    expect(env).toMatchObject({ HTTP_PROXY: URL_, https_proxy: URL_, NO_PROXY: '', NODE_EXTRA_CA_CERTS: CA, REQUESTS_CA_BUNDLE: CA, SSL_CERT_FILE: CA, CURL_CA_BUNDLE: CA });
    // without decryption nothing is added: SSL_CERT_FILE would replace the system's own roots
    expect(Object.keys(proxyEnvironment(URL_))).not.toContain('SSL_CERT_FILE');
  });

  it('the copied lines carry them for every shell, and curl gets --cacert', () => {
    const lines = Object.fromEntries(proxyShellLines(URL_, CA).map((l) => [l.shell, l.lines]));
    for (const k of CA_VARIABLES) {
      expect(lines['bash / zsh']).toContain(`${k}='${CA}'`);
      expect(lines.PowerShell).toContain(`$env:${k} = '${CA}'`);
      expect(lines.cmd).toContain(`set "${k}=${CA}"`);
    }
    expect(lines.curl).toBe(`curl -x ${URL_} --cacert '${CA}' https://example.com/`);
    const plain = Object.fromEntries(proxyShellLines(URL_).map((l) => [l.shell, l.lines]));
    expect(plain['bash / zsh']).toBe(`export HTTP_PROXY=${URL_} HTTPS_PROXY=${URL_} NO_PROXY=`);
    expect(plain.curl).toBe(`curl -x ${URL_} https://example.com/`);
  });

  it('a path with a quote is quoted for the shell', () => {
    const bash = proxyShellLines(URL_, "/home/o'neil/root.pem")[0]!.lines;
    expect(bash).toContain(`NODE_EXTRA_CA_CERTS='/home/o'\\''neil/root.pem'`);
  });
});

describe('the page a browser opens through the proxy', () => {
  it('http and https only; never a browser switch or a file address', () => {
    expect(checkStartUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(checkStartUrl(' http://neverssl.com/ ')).toBe('http://neverssl.com/');
    for (const bad of ['--renderer-cmd-prefix=calc', '-profile', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/', 'not a url', ''])
      expect(() => checkStartUrl(bad), bad).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe("the proxy's own page", () => {
  it('escapes the Host the client sent, and carries a CSP', () => {
    const html = proxyPageHtml('"><script>alert(1)</script>:8899', false);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;');
    expect(escapeHtml(`<a href="x">&'`)).toBe('&#60;a href=&#34;x&#34;&#62;&#38;&#39;');
    expect(PROXY_PAGE_HEADERS['content-security-policy']).toMatch(/default-src 'none'/);
    expect(PROXY_PAGE_HEADERS['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });
});
