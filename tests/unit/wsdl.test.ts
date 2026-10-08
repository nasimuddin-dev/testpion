import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeServices } from '../helpers.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { bundleWsdl, detectFormat, fetchImportText, importAny, runCollection, type CollectionFolder, type SavedHttpRequest, type TestResult } from '../../packages/core/src/index.js';

const wsdl = readFileSync(join(__dirname, '../../examples/servers/patients.wsdl'), 'utf8');

const RPC = `<?xml version="1.0"?>
<definitions name="Calc" targetNamespace="urn:calc" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:calc">
  <message name="AddIn"><part name="a" type="xsd:int"/><part name="b" type="xsd:int"/></message>
  <message name="AddOut"><part name="sum" type="xsd:int"/></message>
  <portType name="CalcPort"><operation name="Add"><input message="tns:AddIn"/><output message="tns:AddOut"/></operation></portType>
  <binding name="CalcBinding" type="tns:CalcPort">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="Add"><soap:operation soapAction="urn:calc#Add"/><input><soap:body use="encoded" namespace="urn:calc"/></input></operation>
  </binding>
  <service name="CalcService"><port name="CalcPort" binding="tns:CalcBinding"><soap:address location="https://calc.example/soap"/></port></service>
</definitions>`;

let server: Server;
let base = '';
const seen: Array<{ action?: string; type?: string; body: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ action: req.headers.soapaction as string, type: req.headers['content-type'], body });
      res.setHeader('content-type', 'text/xml; charset=utf-8');
      res.end('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetPatientResponse xmlns="http://vet.example/patients"><patient><name>Rex</name><species>DOG</species><id>7</id></patient></GetPatientResponse></soap:Body></soap:Envelope>');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/soap/patients`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('WSDL import', () => {
  it('detects WSDL 1.1 and builds a folder per SOAP port with sample envelopes', () => {
    expect(detectFormat(wsdl)).toBe('wsdl');
    const r = importAny(wsdl);
    const c = r.collection!;
    expect(c.name).toBe('PatientService');
    expect(c.description).toBe('Look up and register patients.');
    // both ports share the address: one {{baseUrl}}
    expect(c.variables).toEqual([{ key: 'baseUrl', value: 'http://localhost:8080/soap/patients', enabled: true }]);
    expect(c.items.map((f) => f.name)).toEqual(['PatientService · PatientSoap', 'PatientService · PatientSoap12 (SOAP 1.2)']);
    const [soap11, soap12] = c.items as CollectionFolder[];
    const get = soap11!.items[0] as SavedHttpRequest;
    expect(get.name).toBe('GetPatient');
    expect(get.description).toBe('Fetch one patient by id.');
    expect(get.request).toMatchObject({ method: 'POST', url: '{{baseUrl}}' });
    expect(get.request.headers).toEqual([
      { key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true },
      { key: 'SOAPAction', value: '"http://vet.example/patients/GetPatient"', enabled: true },
    ]);
    expect((get.request.body as { content: string }).content).toBe(
      [
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://vet.example/patients">',
        '  <soap:Header/>',
        '  <soap:Body>',
        '    <tns:GetPatient>',
        '      <tns:id>0</tns:id>',
        '      <tns:includeOwner>false</tns:includeOwner>',
        '    </tns:GetPatient>',
        '  </soap:Body>',
        '</soap:Envelope>',
      ].join('\n'),
    );
    // extension (base fields first), enums, and a recursive type (Owner → Patient) that stops
    const register = (soap11!.items[1] as SavedHttpRequest).request.body as { content: string };
    expect(register.content).toContain('<tns:name>?</tns:name>\n        <tns:species>DOG</tns:species>\n        <tns:id>0</tns:id>\n        <tns:born>2024-01-01</tns:born>');
    expect(register.content).toMatch(/<tns:owner>\s+<tns:name>\?<\/tns:name>\s+<tns:pets\/>\s+<\/tns:owner>/);
    const get12 = soap12!.items[0] as SavedHttpRequest;
    expect(get12.request.headers).toEqual([{ key: 'Content-Type', value: 'application/soap+xml; charset=utf-8; action="http://vet.example/patients/GetPatient"', enabled: true }]);
    expect((get12.request.body as { content: string }).content).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
  });

  it('RPC style: the operation wraps its parts', () => {
    const c = importAny(RPC).collection!;
    const add = c.items[0] as SavedHttpRequest;
    expect(add.name).toBe('Add');
    expect((add.request.body as { content: string }).content).toContain('<tns:Add>\n      <a>0</a>\n      <b>0</b>\n    </tns:Add>');
    expect(add.request.headers?.[1]).toEqual({ key: 'SOAPAction', value: '"urn:calc#Add"', enabled: true });
  });

  it('sends the imported SOAP request', async () => {
    const c = importAny(wsdl).collection!;
    const results: TestResult[] = [];
    // collection variables come from the engine context; here the environment gives baseUrl
    const services = fakeServices({ vars: { baseUrl: base } });
    const first = (c.items[0] as CollectionFolder).items[0] as SavedHttpRequest;
    await runCollection({ name: 'soap', collection: { ...c, items: [first] }, services, onEvent: (e) => void (e.type === 'test-end' && results.push(e.result)) });
    expect(results[0]?.status, JSON.stringify(results[0]?.error)).toBe('passed');
    expect(seen[0]).toMatchObject({ action: '"http://vet.example/patients/GetPatient"', type: 'text/xml; charset=utf-8' });
    expect(seen[0]!.body).toContain('<tns:GetPatient>');
  });

  it('explains what is not supported', () => {
    expect(() => importAny('<?xml version="1.0"?><description xmlns="http://www.w3.org/ns/wsdl"><x/></description>')).toThrow();
    const httpOnly = RPC.replace(/<soap:binding[^>]*\/>/, '').replace(/soap:operation/g, 'http:operation');
    expect(() => importAny(httpOnly)).toThrow(/no SOAP operations/);
  });
});

describe('WSDL imports (JAX-WS / WCF style: ?wsdl=… and ?xsd=… documents)', () => {
  const MAIN = `<?xml version="1.0"?>
<wsdl:definitions name="Clinic" targetNamespace="urn:clinic" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:clinic">
  <wsdl:import namespace="urn:clinic" location="?wsdl=wsdl0"/>
  <wsdl:binding name="ClinicSoap" type="tns:ClinicPort">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <wsdl:operation name="Ping"><soap:operation soapAction="urn:clinic/Ping"/></wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="Clinic"><wsdl:port name="ClinicSoap" binding="tns:ClinicSoap"><soap:address location="http://clinic.test/svc"/></wsdl:port></wsdl:service>
</wsdl:definitions>`;
  const PARTS = `<?xml version="1.0"?>
<definitions targetNamespace="urn:clinic" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:c="urn:clinic">
  <types><xsd:schema targetNamespace="urn:clinic/import"><xsd:import namespace="urn:clinic" schemaLocation="?xsd=xsd0"/><xsd:import schemaLocation="http://elsewhere.test/evil.xsd"/></xsd:schema></types>
  <message name="PingIn"><part name="parameters" element="c:Ping"/></message>
  <portType name="ClinicPort"><operation name="Ping"><input message="c:PingIn"/></operation></portType>
</definitions>`;
  const XSD = `<?xml version="1.0"?>
<xs:schema targetNamespace="urn:clinic" elementFormDefault="qualified" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="Ping"><xs:complexType><xs:sequence><xs:element name="message" type="xs:string"/><xs:element name="count" type="xs:int"/></xs:sequence></xs:complexType></xs:element>
</xs:schema>`;
  let srv: Server;
  let origin = '';
  const asked: string[] = [];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      asked.push(req.url!);
      const q = new URL(req.url!, 'http://x').search;
      res.setHeader('content-type', 'text/xml');
      res.end(q === '?wsdl' ? MAIN : q === '?wsdl=wsdl0' ? PARTS : q === '?xsd=xsd0' ? XSD : '');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => srv.close(() => r())));

  it('follows wsdl:import and xsd:import on the same site, and builds the envelope from the imported schema', async () => {
    const { text } = await fetchImportText(`${origin}/svc?wsdl`);
    expect(detectFormat(text)).toBe('wsdl');
    expect(asked).toEqual(['/svc?wsdl', '/svc?wsdl=wsdl0', '/svc?xsd=xsd0']); // not elsewhere.test
    const ping = importAny(text).collection!.items[0] as SavedHttpRequest;
    expect(ping.name).toBe('Ping');
    expect((ping.request.body as { content: string }).content).toContain('<tns:Ping>\n      <tns:message>?</tns:message>\n      <tns:count>0</tns:count>\n    </tns:Ping>');
  });

  it('bundles local files next to a WSDL (CLI import of a file)', async () => {
    const files: Record<string, string> = { '/w/main.wsdl': MAIN.replace('?wsdl=wsdl0', 'parts.wsdl'), '/w/parts.wsdl': PARTS.replace('?xsd=xsd0', 'types/clinic.xsd'), '/w/types/clinic.xsd': XSD };
    const text = await bundleWsdl(files['/w/main.wsdl']!, '/w/main.wsdl', async (loc) => files[loc.split(sep).join('/').replace(/^[A-Z]:/, '')]);
    const ping = importAny(text).collection!.items[0] as SavedHttpRequest;
    expect((ping.request.body as { content: string }).content).toContain('<tns:count>0</tns:count>');
  });
});
