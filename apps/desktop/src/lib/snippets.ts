/** Script snippets (same set Postman offers), inserted into pre-request / test scripts. */
export interface Snippet {
  label: string;
  code: string;
  kind: 'test' | 'pre' | 'both';
}

export const SNIPPETS: Snippet[] = [
  { kind: 'test', label: 'Status code: Code is 200', code: `tp.test("Status code is 200", function () {\n  tp.response.to.have.status(200);\n});` },
  { kind: 'test', label: 'Status code: Successful POST request', code: `tp.test("Successful POST request", function () {\n  tp.expect(tp.response.code).to.be.oneOf([200, 201, 202]);\n});` },
  { kind: 'test', label: 'Response time is less than 200ms', code: `tp.test("Response time is less than 200ms", function () {\n  tp.expect(tp.response.responseTime).to.be.below(200);\n});` },
  { kind: 'test', label: 'Response body: JSON value check', code: `tp.test("Your test name", function () {\n  const jsonData = tp.response.json();\n  tp.expect(jsonData.value).to.eql(100);\n});` },
  { kind: 'test', label: 'Response body: Contains string', code: `tp.test("Body matches string", function () {\n  tp.expect(tp.response.text()).to.include("string_you_want_to_search");\n});` },
  { kind: 'test', label: 'Response body: Is equal to a string', code: `tp.test("Body is correct", function () {\n  tp.response.to.have.body("response_body_string");\n});` },
  { kind: 'test', label: 'Response headers: Content-Type header check', code: `tp.test("Content-Type is present", function () {\n  tp.response.to.have.header("Content-Type");\n});` },
  { kind: 'test', label: 'Response body: Array has items', code: `tp.test("Returns items", function () {\n  const data = tp.response.json();\n  tp.expect(data.items).to.be.an("array").that.is.not.empty;\n});` },
  { kind: 'test', label: 'Response body: Property types', code: `tp.test("Has the expected shape", function () {\n  const data = tp.response.json();\n  tp.expect(data).to.have.property("id");\n  tp.expect(data.id).to.be.a("string");\n});` },
  { kind: 'test', label: 'Save a value from the response', code: `const data = tp.response.json();\ntp.environment.set("token", data.access_token);` },
  { kind: 'both', label: 'Set an environment variable', code: `tp.environment.set("variable_key", "variable_value");` },
  { kind: 'both', label: 'Get an environment variable', code: `tp.environment.get("variable_key");` },
  { kind: 'both', label: 'Set a collection variable', code: `tp.collectionVariables.set("variable_key", "variable_value");` },
  { kind: 'both', label: 'Set a global variable', code: `tp.globals.set("variable_key", "variable_value");` },
  { kind: 'both', label: 'Get a variable (any scope)', code: `tp.variables.get("variable_key");` },
  { kind: 'both', label: 'Clear an environment variable', code: `tp.environment.unset("variable_key");` },
  { kind: 'test', label: 'Cookies: Cookie is present', code: `tp.test("Session cookie is set", function () {\n  tp.expect(tp.cookies.has("session")).to.be.true;\n});` },
  { kind: 'both', label: 'Cookies: Read from the cookie jar', code: `const jar = tp.cookies.jar();\njar.get(tp.request.url.toString(), "session", (error, value) => {\n  tp.variables.set("session", value);\n});` },
  { kind: 'both', label: 'Cookies: Set a cookie in the jar', code: `tp.cookies.jar().set(tp.request.url.toString(), "cookie_name", "cookie_value");` },
  { kind: 'both', label: 'Cookies: Clear the jar for this domain', code: `tp.cookies.jar().clear(tp.request.url.toString());` },
  { kind: 'both', label: 'Send a request (tp.sendRequest)', code: `tp.sendRequest({\n  url: tp.variables.replaceIn("{{baseUrl}}/auth/token"),\n  method: "POST",\n  header: { "Content-Type": "application/json" },\n  body: { mode: "raw", raw: JSON.stringify({ client_id: tp.environment.get("clientId") }) }\n}, (err, res) => {\n  if (err) return console.error(err.message);\n  tp.environment.set("accessToken", res.json().access_token);\n});` },
  { kind: 'pre', label: 'Add a request header', code: `tp.request.headers.upsert({ key: "X-Request-Id", value: tp.uuid() });` },
  { kind: 'pre', label: 'Timestamp variable', code: `tp.variables.set("timestamp", new Date().toISOString());` },
  { kind: 'pre', label: 'HMAC signature header', code: `const body = tp.request.body.toString();\nconst signature = CryptoJS.HmacSHA256(body, tp.environment.get("secret")).toString(CryptoJS.enc.Base64);\ntp.request.headers.upsert({ key: "X-Signature", value: signature });` },
  { kind: 'both', label: 'Log to the console', code: `console.log(tp.variables.toObject());` },
  { kind: 'test', label: 'Collection runner: go to a request next', code: `tp.execution.setNextRequest("Request name");` },
  { kind: 'test', label: 'Visualize the response as a table', code: `const template = \`
<table>
  <tr><th>Name</th><th>Email</th></tr>
  {{#each response}}
    <tr><td>{{name}}</td><td>{{email}}</td></tr>
  {{/each}}
</table>\`;
// Handlebars template + data; open Body › Visualize to see it
tp.visualizer.set(template, { response: tp.response.json() });` },
];

/** Type declarations for Monaco so the script editor autocompletes the tp API. */
/** Bruno's script API (bru, req, res, test, expect), for scripts imported from Bruno. */
export const BRUNO_TYPES = `
declare const bru: {
  getEnvVar(key: string): any; setEnvVar(key: string, value: any): void; hasEnvVar(key: string): boolean; deleteEnvVar(key: string): void; getEnvName(): string | undefined;
  getGlobalEnvVar(key: string): any; setGlobalEnvVar(key: string, value: any): void;
  getVar(key: string): any; setVar(key: string, value: any): void; hasVar(key: string): boolean; deleteVar(key: string): void;
  getCollectionVar(key: string): any; getFolderVar(key: string): any; getRequestVar(key: string): any; getProcessEnv(key: string): undefined;
  interpolate(text: string): string; getRequestName(): string; setNextRequest(name: string | null): void;
  runner: { setNextRequest(name: string | null): void; skipRequest(): void; stopExecution(): void };
  sleep(ms: number): Promise<void>; cwd(): string;
};
declare const req: {
  getUrl(): string; setUrl(url: string): void; getMethod(): string; setMethod(method: string): void; getName(): string;
  getHeader(name: string): string | undefined; getHeaders(): Record<string, string>; setHeader(name: string, value: string): void; setHeaders(headers: Record<string, string>): void; deleteHeader(name: string): void;
  getBody(): any; setBody(body: any): void; getTimeout(): number | undefined; setTimeout(ms: number): void; getAuthMode(): string;
};
declare const res: {
  (path: string): any;
  status: number; statusText: string; headers: Record<string, string>; body: any; responseTime: number;
  getStatus(): number; getStatusText(): string; getHeader(name: string): string | undefined; getHeaders(): Record<string, string>; getBody(): any; getResponseTime(): number; getUrl(): string;
};
declare function test(name: string, fn: () => void): void;
declare function expect(value: any): any;
`;

export const PM_TYPES = `
interface PmExpect {
  to: PmExpect; be: PmExpect; been: PmExpect; is: PmExpect; that: PmExpect; which: PmExpect; and: PmExpect; has: PmExpect; have: PmExpect; with: PmExpect; not: PmExpect; deep: PmExpect;
  equal(v: any): PmExpect; eql(v: any): PmExpect; a(type: string): PmExpect; an(type: string): PmExpect;
  include(v: any): PmExpect; contain(v: any): PmExpect; property(name: string, value?: any): PmExpect; lengthOf(n: number): PmExpect;
  above(n: number): PmExpect; below(n: number): PmExpect; least(n: number): PmExpect; most(n: number): PmExpect; within(a: number, b: number): PmExpect;
  match(re: RegExp | string): PmExpect; oneOf(values: any[]): PmExpect; keys(...keys: string[]): PmExpect; members(values: any[]): PmExpect;
  /** Validates against a JSON Schema (Ajv: draft-07 keywords and formats). */
  jsonSchema(schema: object): PmExpect;
  readonly true: PmExpect; readonly false: PmExpect; readonly null: PmExpect; readonly undefined: PmExpect; readonly ok: PmExpect; readonly empty: PmExpect; readonly exist: PmExpect;
}
interface PmVariableScope { get(key: string): any; set(key: string, value: any): void; unset(key: string): void; has(key: string): boolean; clear(): void; toObject(): Record<string, any>; replaceIn(template: string): string; }
interface PmHeaderList { get(key: string): string | undefined; has(key: string): boolean; add(h: { key: string; value: string }): void; upsert(h: { key: string; value: string }): void; remove(key: string): void; toObject(): Record<string, string>; }
interface PmResponseAssert {
  to: PmResponseAssert; have: PmResponseAssert; be: PmResponseAssert; not: PmResponseAssert;
  status(codeOrReason: number | string): PmResponseAssert; header(name: string, value?: string): PmResponseAssert; body(expected?: string | object): PmResponseAssert; jsonBody(path?: string, value?: any): PmResponseAssert;
  /** The response body validates against a JSON Schema (Ajv). */
  jsonSchema(schema: object): PmResponseAssert;
  readonly ok: PmResponseAssert; readonly success: PmResponseAssert; readonly error: PmResponseAssert; readonly clientError: PmResponseAssert; readonly serverError: PmResponseAssert; readonly json: PmResponseAssert;
  readonly notFound: PmResponseAssert; readonly unauthorized: PmResponseAssert; readonly forbidden: PmResponseAssert; readonly badRequest: PmResponseAssert;
}
/** Workspace cookie jar. Callbacks run immediately; the value is also returned. */
interface PmCookieJar {
  get(url: string, name: string, cb?: (err: null, value: string | undefined) => void): string | undefined;
  getAll(url: string, cb?: (err: null, cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: string; secure: boolean; httpOnly: boolean }>) => void): Array<{ name: string; value: string; domain: string; path: string }>;
  set(url: string, name: string, value: string, cb?: (err: null, cookie: object) => void): object;
  unset(url: string, name: string, cb?: (err: null) => void): void;
  clear(url: string, cb?: (err: null) => void): void;
}
/** Postman's Url object; {{variables}} stay as written. Assigning a string to tp.request.url replaces it. */
interface PmUrl {
  toString(): string; update(url: string): void; getHost(): string; getRemote(): string; getPath(): string; getQueryString(): string; getPathWithQuery(): string;
  readonly protocol: string; readonly host: string[]; readonly port: string | undefined; readonly path: string[];
  query: { get(key: string): string | null | undefined; has(key: string): boolean; add(p: { key: string; value?: any }): void; upsert(p: { key: string; value?: any }): void; remove(key: string): void; clear(): void; all(): Array<{ key: string; value: string | null }>; count(): number; toObject(): Record<string, string | null> };
  addQueryParams(params: Array<{ key: string; value?: any }> | { key: string; value?: any }): void; removeQueryParams(keys: string[] | string): void;
}
/** TestPion's script API: tests, assertions, variables, the request and the response. */
declare const tp: {
  /** Define a named test; it passes unless the function throws. */
  test(name: string, fn: () => void): void;
  /** Chai-style assertion: tp.expect(value).to.equal(expected) */
  expect: { (value: any): PmExpect; fail(message?: string): never };
  variables: PmVariableScope; environment: PmVariableScope; globals: PmVariableScope; collectionVariables: PmVariableScope;
  iterationData: { get(key: string): any; has(key: string): boolean; toObject(): Record<string, any> };
  request: { method: string; url: PmUrl; headers: PmHeaderList; body: { toString(): string; update(body: string | object): void } };
  response: { code: number; status: string; responseTime: number; responseSize: number; headers: PmHeaderList; json(): any; text(): string; to: PmResponseAssert; size(): { body: number; header: number; total: number } };
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number; eventName: 'prerequest' | 'test' };
  cookies: { get(name: string): string | undefined; has(name: string): boolean; toObject(): Record<string, string>; jar(): PmCookieJar };
  execution: { setNextRequest(name: string | null): void; skipRequest(): void };
  /** Show the response as HTML: a Handlebars template rendered with \`data\` in Body › Visualize. */
  visualizer: { set(template: string, data?: any, options?: any): void; clear(): void };
  /** Send another HTTP request from a script. The callback runs with the response (or an error). */
  sendRequest(
    request: string | { url: string; method?: string; header?: Array<{ key: string; value: string }> | Record<string, string>; body?: { mode: 'raw'; raw: string } | { mode: 'urlencoded'; urlencoded: Array<{ key: string; value: string }> } },
    callback: (err: Error | null, res: { code: number; status: string; responseTime: number; headers: PmHeaderList; json(): any; text(): string } | null) => void,
  ): void;
  /** Without a callback: a promise of the response, for const res = await tp.sendRequest(…). */
  sendRequest(request: string | { url: string; method?: string; header?: any; body?: any }): Promise<{ code: number; status: string; responseTime: number; headers: PmHeaderList; json(): any; text(): string }>;
  /** Postman Vault: TestPion keeps secrets in (secret) variables; the vault reads and writes those. */
  vault: { get(key: string): Promise<any>; set(key: string, value: any): Promise<void>; unset(key: string): Promise<void> };
  /** A workspace script package (packages/<name>.js), like Postman's package library. */
  require(name: string): any;
  uuid(): string;
};
declare const postman: {
  setNextRequest(name: string | null): void; setEnvironmentVariable(k: string, v: any): void; getEnvironmentVariable(k: string): any; clearEnvironmentVariable(k: string): void;
  setGlobalVariable(k: string, v: any): void; getGlobalVariable(k: string): any; clearGlobalVariable(k: string): void;
  getResponseHeader(name: string): string | undefined; getResponseCookie(name: string): { name: string; value: string } | undefined;
};
/** XML (e.g. a SOAP response) as an object: attributes under "$", text under "_", repeated elements as arrays. */
declare function xml2Json(xml: string): any;
/** lodash (loaded when a script uses it): _.get(obj, 'a.b[0]'), _.map, _.sortBy … */
declare const _: any;
interface PmMoment {
  format(fmt?: string): string; add(n: number | object, unit?: string): PmMoment; subtract(n: number | object, unit?: string): PmMoment;
  startOf(unit: string): PmMoment; endOf(unit: string): PmMoment; clone(): PmMoment; diff(other: any, unit?: string, float?: boolean): number;
  isBefore(other: any, unit?: string): boolean; isAfter(other: any, unit?: string): boolean; isSame(other: any, unit?: string): boolean;
  toISOString(): string; valueOf(): number; unix(): number; toDate(): Date; isValid(): boolean; fromNow(): string;
}
/** moment (UTC): moment().add(1, 'day').format('YYYY-MM-DD') */
declare const moment: { (input?: any, format?: string): PmMoment; utc(input?: any, format?: string): PmMoment; unix(seconds: number): PmMoment; duration(n: number | object, unit?: string): any };
/** tv4-compatible JSON Schema validation (older Postman scripts). */
declare const tv4: { validate(data: any, schema: object): boolean; error: { message: string } | null; validateResult(data: any, schema: object): { valid: boolean; error: { message: string } | null }; validateMultiple(data: any, schema: object): { valid: boolean; errors: Array<{ message: string }> } };
declare function require(name: 'ajv' | 'atob' | 'btoa' | 'chai' | 'cheerio' | 'crypto-js' | 'csv-parse/lib/sync' | 'lodash' | 'moment' | 'tv4' | 'uuid' | 'xml2js'): any;
/** HTML with CSS selectors, as in Postman: const $ = cheerio.load(tp.response.text()); $('title').text() */
declare const cheerio: { load(html: string): any };
declare const CryptoJS: any;
declare const tests: Record<string, boolean>;
declare function btoa(s: string): string;
declare function atob(s: string): string;
/** @deprecated Postman compatibility; use tp. Scripts written for Postman run unchanged. */
declare const pm: typeof tp;
/** @deprecated An older alias of tp. */
declare const aps: typeof tp;
/** Lines go to the Console panel (and to the test's logs in reports); every level writes the same way. */
declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void; debug(...args: any[]): void };
/** Timers run after the script's own code, before the sandbox returns (there is no real clock to wait on). */
declare function setTimeout(fn: () => void, ms?: number): number;
declare function setInterval(fn: () => void, ms?: number): number;
declare function setImmediate(fn: () => void): number;
declare function clearTimeout(id: number): void;
declare function clearInterval(id: number): void;
/** Old Postman globals, still filled in for scripts that use them. */
declare const responseCode: { code: number; name: string; detail: string };
declare const responseBody: string;
declare const responseTime: number;
declare const responseHeaders: Record<string, string>;
declare const environment: Record<string, any>;
declare const globals: Record<string, any>;
/** The current data-file row (collection runner with a dataset). */
declare const data: Record<string, any>;
/** In a script package: what it offers to tp.require. */
declare const module: { exports: any };
`;
