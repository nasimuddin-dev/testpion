import { describe, expect, it } from 'vitest';
import { detectFormat, type CollectionFolder, type SavedHttpRequest } from '../../packages/core/src/index.js';
import { importAny } from '../helpers-import.js';

const WSDL2 = `<?xml version="1.0" encoding="utf-8"?>
<description xmlns="http://www.w3.org/ns/wsdl" targetNamespace="urn:clinic" xmlns:tns="urn:clinic" xmlns:wsoap="http://www.w3.org/ns/wsdl/soap" xmlns:whttp="http://www.w3.org/ns/wsdl/http" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <documentation>Clinic appointments</documentation>
  <types>
    <xs:schema targetNamespace="urn:clinic" elementFormDefault="qualified">
      <xs:element name="BookRequest"><xs:complexType><xs:sequence>
        <xs:element name="patientId" type="xs:int"/>
        <xs:element name="when" type="xs:dateTime"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="BookResponse" type="xs:string"/>
    </xs:schema>
  </types>
  <interface name="Base">
    <operation name="Ping" pattern="http://www.w3.org/ns/wsdl/in-out"><input element="#none"/><output element="#none"/></operation>
  </interface>
  <interface name="Clinic" extends="tns:Base">
    <operation name="Book" pattern="http://www.w3.org/ns/wsdl/in-out">
      <documentation>Book an appointment</documentation>
      <input element="tns:BookRequest"/><output element="tns:BookResponse"/>
    </operation>
  </interface>
  <binding name="ClinicSoap12" interface="tns:Clinic" type="http://www.w3.org/ns/wsdl/soap" wsoap:protocol="http://www.w3.org/2003/05/soap/bindings/HTTP/">
    <operation ref="tns:Book" wsoap:action="urn:clinic:Book"/>
  </binding>
  <binding name="ClinicSoap11" interface="tns:Clinic" type="http://www.w3.org/ns/wsdl/soap" wsoap:version="1.1" wsoap:protocol="http://www.w3.org/2006/01/soap11/bindings/HTTP/">
    <operation ref="tns:Book" wsoap:action="urn:clinic:Book"/>
  </binding>
  <binding name="ClinicHttp" interface="tns:Clinic" type="http://www.w3.org/ns/wsdl/http"/>
  <service name="ClinicService" interface="tns:Clinic">
    <endpoint name="Soap12" binding="tns:ClinicSoap12" address="http://localhost:8080/clinic"/>
    <endpoint name="Soap11" binding="tns:ClinicSoap11" address="http://localhost:8080/clinic11"/>
    <endpoint name="Rest" binding="tns:ClinicHttp" address="http://localhost:8080/rest"/>
  </service>
</description>`;

describe('WSDL 2.0 import', () => {
  it('is detected', () => {
    expect(detectFormat(WSDL2)).toBe('wsdl');
  });

  it('imports SOAP 1.2 and 1.1 endpoints with actions, inherited operations and sample envelopes', () => {
    const { collection } = importAny(WSDL2);
    const folders = collection!.items as CollectionFolder[];
    // the HTTP binding is not SOAP and is skipped
    expect(folders.map((f) => f.name)).toEqual(['ClinicService · Soap12 (SOAP 1.2)', 'ClinicService · Soap11']);
    expect(collection!.variables.map((v) => [v.key, v.value])).toEqual([
      ['baseUrl', 'http://localhost:8080/clinic'],
      ['soap11Url', 'http://localhost:8080/clinic11'],
    ]);
    const [ping12, book12] = folders[0]!.items as SavedHttpRequest[];
    expect(ping12!.name).toBe('Ping');
    expect(book12!.name).toBe('Book');
    expect(book12!.description).toBe('Book an appointment');
    expect(book12!.request.url).toBe('{{baseUrl}}');
    expect(book12!.request.headers).toEqual([{ key: 'Content-Type', value: 'application/soap+xml; charset=utf-8; action="urn:clinic:Book"', enabled: true }]);
    const env = (book12!.request.body as { content: string }).content;
    expect(env).toContain('xmlns:soap="http://www.w3.org/2003/05/soap-envelope"');
    expect(env).toContain('<tns:BookRequest>');
    expect(env).toContain('<tns:patientId>0</tns:patientId>');
    expect(env).toContain('<tns:when>2024-01-01T00:00:00</tns:when>');
    // #none: an empty body
    expect((ping12!.request.body as { content: string }).content).toContain('<soap:Body>\n  </soap:Body>');

    const book11 = (folders[1]!.items as SavedHttpRequest[]).find((r) => r.name === 'Book')!;
    expect(book11.request.url).toBe('{{soap11Url}}');
    expect(book11.request.headers).toEqual([
      { key: 'Content-Type', value: 'text/xml; charset=utf-8', enabled: true },
      { key: 'SOAPAction', value: '"urn:clinic:Book"', enabled: true },
    ]);
    expect((book11.request.body as { content: string }).content).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
  });

  it('says when a WSDL 2.0 document has no SOAP binding', () => {
    expect(() => importAny(WSDL2.replace(/<binding name="ClinicSoap1[12]"[\s\S]*?<\/binding>/g, ''))).toThrow(/no SOAP operations/);
  });
});
