---
title: "Mock servers"
description: "Serve a collection's saved examples on localhost to build and test clients before the real API exists."
---

::: v-pre

# Mock servers

A mock server answers HTTP requests with the [saved examples](/api-testing/collections#examples) of a collection, like a Postman mock server. Use it to build a front end or client before the API exists, to test error handling, or to work offline.

Mock servers run on your computer only. They listen on `127.0.0.1` and are never reachable from other machines.

## Start one

**In the app:** open the collection's page (its **⋯ ▸ Settings, runner & docs** in the Collections explorer, or the collection's name at the start of a request's breadcrumb line) and open the **Mock** tab. The tab lists the routes the collection's examples provide. Pick a port (or leave it empty for any free port), optionally a delay, and click **Start mock server**. Copy the URL and use it as `{{baseUrl}}`, for example in a new *Mock* environment. Requests to the server appear below the routes as they arrive, and in the [HTTP Debugger](/api-testing/http-debugger)'s **Incoming requests** with the example that answered. Click a route to open its request.

The server follows the collection: examples you save, rename or delete are served straight away. It stops when you click **Stop**, switch workspace or close the app.

**From the CLI:**

```bash
testpion mock "Veterinary API" -p 4545
# Mock server for Veterinary API: http://127.0.0.1:4545
#   GET     /patients/1 → 200 Patient found
#   GET     /patients/999 → 404 Patient not found
```

A Postman collection file with saved responses works too: `testpion mock api.postman_collection.json`.

### From an OpenAPI document

Importing an OpenAPI or Swagger document gives every request an example for each documented response (up to five, success first), taken from the document's `example`, its first named example, or a sample built from the schema. So an imported API can be mocked straight away, and the CLI can mock a document from a file or a link without importing it:

```bash
testpion mock https://petstore3.swagger.io/api/v3/openapi.json -p 4545
curl http://127.0.0.1:4545/pet/5                                     # 200, the documented pet example
curl -H "x-mock-response-code: 404" http://127.0.0.1:4545/pet/5      # the documented 404
```

## How a request finds its example

Every example is a route: the method and path of the example's request (or of the saved request when the example has none). The host part is ignored, so `{{baseUrl}}/patients/1` and `https://api.example.com/patients/1` both become `/patients/1`.

1. **Method and path must match.** Path segments written as `:id` or `{{id}}` match any value. Literal segments must be equal and score higher, so `/patients/999` wins over `/patients/:id` for that exact path.
2. **Pick an example explicitly** with a request header:
   - `x-mock-response-name: Patient not found` selects the example with that name.
   - `x-mock-response-code: 404` selects an example with that status.
3. **Otherwise the best match wins.** Query parameters and the **request body** equal to the example's score higher, and a 2xx example wins a tie.
   - Bodies are compared as JSON when they are JSON (key order doesn't matter). A request body that contains every field of the example's body (and maybe more) is a good match too. Form bodies match with their fields in any order.
   - So a `POST /login` can answer with the *Success* example or the *Wrong password* example depending on the password sent, when you saved one example of each.
   - `x-mock-match-request-body: true` accepts only examples whose saved body matches; otherwise the mock answers `404`.
   - `x-mock-match-request-headers: X-Tenant, X-Version` accepts only examples whose saved request has the same values for those headers.
4. **Ids are flexible.** If nothing matches exactly, id-like segments in saved URLs (`/patients/1`, UUIDs, long hex ids) match any value. `/patients/42` is then answered by the `/patients/1` example.

The response has the example's status, headers and body, plus `x-mock-example: <name>` and permissive CORS headers so a browser app on another port can call it. A request that matches no example gets `404` with a JSON list of the available routes.

**Partial mocking:** set **Forward the rest to** in the Mock tab (or `testpion mock "My API" --fallback https://api.example.com`) and requests that match no example are sent to the real API instead of getting a `404`. Mock just the endpoints that aren't built yet, or the error cases that are hard to trigger, and use the real API for everything else. Forwarded responses carry `x-mock-forwarded: true`.

**Fresh data on every call:** [dynamic variables](/api-testing/environments#built-in-variables) in an example's body or headers are filled in each time, as in Postman's mocks. An example body like `{"id": "{{$guid}}", "name": "{{$randomFullName}}", "createdAt": "{{$isoTimestamp}}"}` returns a new id, name and time for every request. Other `{{variables}}` are sent as written.

:::
