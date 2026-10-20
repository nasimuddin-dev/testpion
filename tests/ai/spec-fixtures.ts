/** A shop API with limits, enums and security, and a workspace that tests only part of it (the AI-4 golden cases). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspaceStore } from '../../packages/core/src/index.js';

export const SHOP_SPEC = `openapi: 3.0.3
info:
  title: Shop API
  version: 1.0.0
servers:
  - url: http://localhost:4010
security:
  - bearer: []
paths:
  /health:
    get:
      operationId: health
      summary: Health check
      security: []
      responses:
        '200':
          description: Up
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status: { type: string }
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      tags: [orders]
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
        - { name: status, in: query, schema: { type: string, enum: [new, paid] } }
      responses:
        '200':
          description: Orders
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items: { type: array, items: { $ref: '#/components/schemas/Order' } }
        '401': { description: No token }
    post:
      operationId: createOrder
      summary: Create an order
      tags: [orders]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [item, qty]
              properties:
                item: { type: string, minLength: 1, maxLength: 50 }
                qty: { type: integer, minimum: 1, maximum: 10 }
                note: { type: string }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '400': { description: Invalid }
        '401': { description: No token }
        '422': { description: Rejected }
  /orders/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string, format: uuid } }
    get:
      operationId: getOrder
      summary: Get an order
      tags: [orders]
      responses:
        '200':
          description: The order
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '404': { description: Not found }
    delete:
      operationId: deleteOrder
      summary: Delete an order
      tags: [orders]
      responses:
        '204': { description: Deleted }
        '404': { description: Not found }
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  schemas:
    Order:
      type: object
      required: [id, item, qty]
      properties:
        id: { type: string }
        item: { type: string }
        qty: { type: integer }
        note: { type: string, nullable: true }
`;

/** Tests that exist: health is called, an order is created and read, the list is a saved request that asserts 200. */
export const SHOP_TESTS = `defaults:
  type: http
tests:
  - id: health
    name: Health
    method: GET
    url: "{{baseUrl}}/health"
    assertions:
      - { type: status, expected: 200 }
      - { type: openapi, spec: specs/shop.yaml }
  - id: create
    name: Create an order
    method: POST
    url: "{{baseUrl}}/orders"
    auth: { type: bearer, token: "{{accessToken}}" }
    body: { item: bookshelf, qty: 1 }
    assertions:
      - { type: status, expected: 201 }
  - id: get
    name: Get an order
    method: GET
    url: "{{baseUrl}}/orders/{{orderId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions:
      - { type: status, expected: 200 }
`;

/** A workspace with the spec and the partial tests. */
export function addShopSpec(store: WorkspaceStore, o: { tests?: boolean } = {}): void {
  const put = (rel: string, text: string) => {
    const f = join(store.root, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  };
  put('specs/shop.yaml', SHOP_SPEC);
  if (o.tests !== false) put('tests/smoke/orders.yaml', SHOP_TESTS);
}
