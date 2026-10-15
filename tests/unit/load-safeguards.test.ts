import { describe, expect, it } from 'vitest';
import { checkLoadSafeguards, prepareLoadTest, type LoadTestConfig } from '@testpion/core';

const cfg = { virtualUsers: 2, durationSec: 1 } as unknown as LoadTestConfig;

describe('load test safeguards', () => {
  it('names an unset variable in the URL instead of calling it a remote host', () => {
    expect(() => checkLoadSafeguards(cfg, 'http://{{baseUrl}}/health')).toThrow(/uses \{\{baseUrl\}\}, which is not set/);
  });
  it('still asks for opt-in before a remote host', () => {
    expect(() => checkLoadSafeguards(cfg, 'https://example.com/')).toThrow(/requires explicit opt-in/);
    expect(() => checkLoadSafeguards(cfg, 'http://127.0.0.1:8080/')).not.toThrow();
  });
});

// the app awaits prepareLoadTest before Start answers: whatever would refuse the test refuses it there, for every target
describe('prepareLoadTest refuses before anything is sent', () => {
  const base = { virtualUsers: 1, durationSec: 1 };
  it('a request to a remote host', async () => {
    await expect(prepareLoadTest({ ...base, target: { kind: 'http', request: { method: 'GET', url: 'https://example.com/' } } } as LoadTestConfig)).rejects.toThrow(/requires explicit opt-in/);
  });
  it('any request of a collection sequence, not only the first', async () => {
    const target = { kind: 'sequence', requests: [{ name: 'a', request: { method: 'GET', url: 'http://127.0.0.1:1/' } }, { name: 'b', request: { method: 'GET', url: 'https://example.com/' } }] };
    await expect(prepareLoadTest({ ...base, target } as LoadTestConfig)).rejects.toThrow(/remote host "example.com"/);
  });
  it('a gRPC server on a remote host', async () => {
    const target = { kind: 'grpc', request: { target: 'grpc.example.com:443', tls: true, service: 's', method: 'm' } };
    await expect(prepareLoadTest({ ...base, target } as unknown as LoadTestConfig)).rejects.toThrow(/remote host "grpc.example.com"/);
  });
  it('a production environment without consent', async () => {
    await expect(prepareLoadTest({ ...base, environmentIsProduction: true, target: { kind: 'http', request: { method: 'GET', url: 'http://127.0.0.1:1/' } } } as LoadTestConfig)).rejects.toThrow(/production/);
  });
  it('a model with no provider registry', async () => {
    await expect(prepareLoadTest({ ...base, target: { kind: 'llm', model: { provider: 'openai' } } } as unknown as LoadTestConfig)).rejects.toThrow(/No provider registry/);
  });
  it('a flow file that is not there', async () => {
    await expect(prepareLoadTest({ ...base, target: { kind: 'flow', file: 'missing.yaml' } } as unknown as LoadTestConfig, { services: {} as never, testsDir: process.cwd() })).rejects.toThrow();
  });
  it('a local request passes', async () => {
    await expect(prepareLoadTest({ ...base, target: { kind: 'http', request: { method: 'GET', url: 'http://127.0.0.1:1/' } } } as LoadTestConfig)).resolves.toMatchObject({ url: 'http://127.0.0.1:1/' });
  });
});
