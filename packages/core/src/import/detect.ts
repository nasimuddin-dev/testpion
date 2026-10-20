import { parseYamlShared } from '../util/lazy-yaml.js';
import { WORKSPACE_FORMATS } from '../storage/workspace.js';
import type { ImportFormat } from '@testpion/shared';
import { looksLikeBru } from './bru.js';
import { isWsdl } from './wsdl.js';
import { detectOtherTool } from './other-tools.js';
import { isDotenv } from './dotenv.js';
import { isAsyncApi } from './asyncapi.js';
import { isHttpFile } from './http-file.js';
import { isArazzo } from './arazzo.js';
import { isOpenCollection } from './opencollection-import.js';
import { isThunder } from './thunder-import.js';
import { isGraphqlIntrospection } from './graphql-sdl.js';
import { isYaak } from './yaak-import.js';
import { isHttpie } from './httpie-import.js';
import { isApidog } from './apidog-import.js';
import { isPostmanV1, isPostmanV3Bundle } from './postman-versions.js';

/** Which format a text is in; every format it returns has its file extensions in IMPORT_FORMATS (the pickers' filter). */
export function detectFormat(text: string): ImportFormat | 'unknown' {
  const t = text.trim();
  if (isWsdl(t)) return 'wsdl';
  // an .http / .rest file (VS Code REST Client, JetBrains HTTP Client)
  if (isHttpFile(t)) return 'http-file';
  // a single Bruno .bru request file
  if (looksLikeBru(t)) return 'bruno';
  if (/^(type|schema|interface|enum|input|scalar|union|directive|extend)\s/m.test(t) && !t.startsWith('{')) return 'graphql-sdl';
  if (!t.startsWith('{') && !t.startsWith('[') && isDotenv(t)) return 'dotenv';
  let d: Record<string, any>;
  try {
    d = t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : (parseYamlShared(t) as Record<string, any>);
  } catch {
    return 'unknown';
  }
  if (!d || typeof d !== 'object') return 'unknown';
  // a GraphQL introspection result ({ data: { __schema } }): the schema, as a collection of its root fields
  if (isGraphqlIntrospection(d)) return 'graphql-sdl';
  // an Arazzo workflow description (arazzo: 1.0.x): its workflows become flow files under tests/
  if (isArazzo(d)) return 'arazzo';
  // Bruno's OpenCollection (opencollection: 1.0.0), the YAML format
  if (isOpenCollection(d)) return 'opencollection';
  // the tools with their own file shape (Thunder Client, Yaak, HTTPie, Apidog) and Postman's older and newer formats
  if (isPostmanV3Bundle(d)) return 'postman-v3';
  if (isYaak(d)) return 'yaak';
  if (isHttpie(d)) return 'httpie';
  if (isApidog(d)) return 'apidog';
  if (isThunder(d)) return 'thunder';
  if (isPostmanV1(d)) return 'postman-v1';
  const other = detectOtherTool(d);
  if (other) return other;
  if (isAsyncApi(d)) return 'asyncapi';
  if (d.openapi) return 'openapi';
  if (d.swagger) return 'swagger';
  if (d.info?._postman_id || String(d.info?.schema ?? '').includes('postman')) return 'postman';
  if (d._postman_variable_scope === 'environment' || d._postman_variable_scope === 'globals' || (Array.isArray(d.values) && d.name)) return 'postman-env';
  if (d.log?.entries) return 'har';
  if (WORKSPACE_FORMATS.has(d.format)) return 'aps-workspace';
  if (d.schemaVersion && Array.isArray(d.items)) return 'aps-collection';
  return 'unknown';
}
